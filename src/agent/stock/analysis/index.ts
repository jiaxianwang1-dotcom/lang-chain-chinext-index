import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  getQuote,
  getPreviousTradingDay,
  updateQuoteReason,
  getQuotesMissingReason,
} from "../db/index.js";
import { findIndexMeta, listTargetIndexes } from "../providers/index.js";
import { logStage, sleep } from "../utils/log.js";

// ==================== 可注入的依赖 ====================

export type WebSearchFn = (query: string) => Promise<string>;
export type WebFetchFn = (url: string) => Promise<string>;
export type LlmInvokeFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

const ReasonSchema = z.object({
  reason: z.string().min(1),
  sources: z.array(z.string()).default([]),
});

export type AnalyzedReason = z.infer<typeof ReasonSchema>;

// ==================== 默认 LLM ====================

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: "moonshot-v1-32k",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: "https://api.moonshot.cn/v1" },
    temperature: 0.2,
  });
  return _defaultLlm;
}

async function defaultInvokeLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  const llm = getDefaultLlm();
  const res = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

// 默认搜索 / 抓取使用 DuckDuckGo（与现有 webSearch / webFetch 一致）
async function defaultWebSearch(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const lines: string[] = [];
    if (data.AbstractText) lines.push(`摘要: ${data.AbstractText} | 来源: ${data.AbstractURL ?? ""}`);
    for (const t of data.RelatedTopics ?? []) {
      if (t.Text) lines.push(`${t.Text} | ${t.FirstURL ?? ""}`);
    }
    for (const r of data.Results ?? []) {
      if (r.Text) lines.push(`${r.Text} | ${r.FirstURL ?? ""}`);
    }
    return lines.slice(0, 8).join("\n");
  } catch {
    return "";
  }
}

async function defaultWebFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  } catch {
    return "";
  }
}

// ==================== 提示词 ====================

const SYSTEM_PROMPT = `你是一名 A 股大盘归因分析助手。
任务：基于"行情数据 + 联网搜索摘要"，用中文用 ≤200 字解释当日指数涨跌的最可能原因。
要求：
1) 必须基于检索到的当时社会背景、经济状况、热点问题。检索为空时，给出保守描述（"无显著公开事件，可能由资金面/技术面驱动"），不得编造具体事件。
2) 输出严格 JSON：{"reason": "...", "sources": ["url1","url2"]}。sources 0~3 条，对应你引用的链接；如无外部来源，sources 设为 ["无外部来源"]。
3) 不要 Markdown，不要解释字段含义，只输出 JSON。`;

function buildUserPrompt(args: {
  index_name: string;
  trade_date: string;
  close_value: number;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  searchSummary: string;
}): string {
  const direction = args.change == null ? "未知" : args.change >= 0 ? "上涨" : "下跌";
  return [
    `指数: ${args.index_name}`,
    `日期: ${args.trade_date}`,
    `当日收盘: ${args.close_value}`,
    `上一交易日收盘: ${args.prev_close ?? "未知"}`,
    `点数变化: ${args.change ?? "未知"}`,
    `百分比变化: ${args.change_pct == null ? "未知" : args.change_pct.toFixed(2) + "%"}`,
    `方向: ${direction}`,
    `搜索摘要(可能为空):`,
    args.searchSummary || "（无）",
  ].join("\n");
}

function safeParseJson(raw: string): AnalyzedReason {
  // 尝试从模型输出里抠出第一段 JSON
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/, "").trim(),
    (trimmed.match(/\{[\s\S]*\}/) ?? [""])[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = ReasonSchema.parse(JSON.parse(c));
      return parsed;
    } catch {
      // 继续尝试下一个
    }
  }
  // 全部失败 → 兜底
  return { reason: "无显著公开事件，可能由资金面/技术面驱动。", sources: ["无外部来源"] };
}

// ==================== 主流程 ====================

export interface AnalyzeOptions {
  webSearch?: WebSearchFn;
  webFetch?: WebFetchFn;
  llmInvoke?: LlmInvokeFn;
}

export async function analyzeChangeReason(
  indexCode: string,
  tradeDate: string,
  opts: AnalyzeOptions = {}
): Promise<AnalyzedReason> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new Error(`未知 index_code: ${indexCode}`);

  const today = getQuote(indexCode, tradeDate);
  if (!today) throw new Error(`未找到 ${indexCode} ${tradeDate} 的行情`);

  const prev = getPreviousTradingDay(indexCode, tradeDate);

  const webSearch = opts.webSearch ?? defaultWebSearch;
  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;

  const query = `${tradeDate} ${meta.index_name} 涨跌 原因 政策 热点`;
  let searchSummary = "";
  try {
    searchSummary = await webSearch(query);
  } catch (e) {
    logStage({
      stage: "analyze.search_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const userPrompt = buildUserPrompt({
    index_name: meta.index_name,
    trade_date: tradeDate,
    close_value: today.close_value,
    prev_close: prev?.close_value ?? null,
    change: today.change,
    change_pct: today.change_pct,
    searchSummary,
  });

  let raw = "";
  try {
    raw = await llmInvoke(SYSTEM_PROMPT, userPrompt);
  } catch (e) {
    logStage({
      stage: "analyze.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    raw = "";
  }

  const parsed = raw ? safeParseJson(raw) : { reason: "无显著公开事件，可能由资金面/技术面驱动。", sources: ["无外部来源"] };
  const sourcesJoined = parsed.sources.length ? parsed.sources.join(",") : "无外部来源";

  updateQuoteReason(indexCode, tradeDate, parsed.reason, sourcesJoined);
  logStage({
    stage: "analyze.done",
    indexCode,
    ok: true,
    tradeDate,
    sources: parsed.sources.length,
  });
  return parsed;
}

/**
 * 遍历所有 change_reason IS NULL 的记录串行归因，每条间隔 ≥ 1.5s。
 */
export async function backfillReasons(opts: AnalyzeOptions = {}): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const meta of listTargetIndexes()) {
    const rows = getQuotesMissingReason(meta.index_code);
    for (const row of rows) {
      try {
        await analyzeChangeReason(row.index_code, row.trade_date, opts);
        ok += 1;
      } catch (e) {
        failed += 1;
        logStage({
          stage: "analyze.backfill_failed",
          indexCode: row.index_code,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          tradeDate: row.trade_date,
        });
      }
      await sleep(1500);
    }
  }
  logStage({ stage: "analyze.backfill_summary", ok: true, success: ok, failed });
  return { ok, failed };
}

// 暴露给测试
export const _internal = {
  safeParseJson,
  buildUserPrompt,
  defaultWebSearch,
  defaultWebFetch,
};
