import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { insertNewsEventIfAbsent, getNewsByDate, type NewsEventRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 当日新闻事件采集 + LLM 分类。
 *
 * 原则：
 * - 不做常驻爬虫（财联社/东方财富 7x24 反爬严重）
 * - 预测前按需调用 webSearch 抓最近热点，传给 moonshot-v1-32k 做结构化分类
 * - 失败时写空兜底，不阻塞预测主流程
 */

// ==================== Schema ====================

export const NewsCategoryEnum = z.enum([
  "policy_macro",
  "geopolitics",
  "industry_semi",
  "industry_ai",
  "industry_property",
  "industry_energy",
  "industry_finance",
  "market_event",
  "overseas",
  "accident",
  "other",
]);

export type NewsCategory = z.infer<typeof NewsCategoryEnum>;

const ImpactSchema = z.union([
  z.literal("broad"),
  z.array(z.string()).min(1),
]);

const ClassifiedItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional().nullable(),
  category: NewsCategoryEnum,
  sentiment: z.number().min(-1).max(1),
  impact_indices: ImpactSchema,
  rationale: z.string().min(1),
});

const ClassificationOutputSchema = z.object({
  events: z.array(ClassifiedItemSchema),
});

export type ClassifiedItem = z.infer<typeof ClassifiedItemSchema>;

// ==================== LLM ====================

export type LlmInvokeFn = (system: string, user: string) => Promise<string>;

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: "moonshot-v1-32k",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: "https://api.moonshot.cn/v1" },
    temperature: 0.1,
  });
  return _defaultLlm;
}

async function defaultInvokeLlm(system: string, user: string): Promise<string> {
  const llm = getDefaultLlm();
  const res = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

export type WebSearchFn = (query: string) => Promise<string>;

async function defaultWebSearch(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      Results?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const lines: string[] = [];
    if (data.AbstractText) lines.push(`【摘要】${data.AbstractText} (${data.AbstractURL ?? ""})`);
    for (const t of data.RelatedTopics ?? []) {
      if (t.Text) lines.push(`【相关】${t.Text} (${t.FirstURL ?? ""})`);
    }
    for (const r of data.Results ?? []) {
      if (r.Text) lines.push(`【结果】${r.Text} (${r.FirstURL ?? ""})`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ==================== Prompt ====================

const CLASSIFY_SYSTEM = `你是 A 股财经新闻分析助手。任务：对用户提供的近期财经新闻进行结构化分类。

输出 JSON：{"events":[{title, summary, category, sentiment, impact_indices, rationale}, ...]}

字段约束：
1) category 必须是以下 11 个之一：
   policy_macro / geopolitics / industry_semi / industry_ai / industry_property
   industry_energy / industry_finance / market_event / overseas / accident / other
2) sentiment ∈ [-1, 1]：>0 利好 A 股大盘，<0 利空，0 中性
3) impact_indices：
   - "broad"（影响整个 A 股）
   - 或 ["000001.SH"] / ["399006.SZ"] / 两者并列
   - 上证指数偏蓝筹 / 价值；创业板指偏成长 / 科技
4) rationale ≤ 80 字中文，说明"为什么这条新闻会按此 sentiment 影响相应指数"
5) 标题相近、本质同一事件的多条新闻 MUST 合并为一条（避免重复）
6) 与 A 股关系不大的纯本地八卦/娱乐/体育 → category=other，sentiment=0

只输出 JSON，不要 Markdown 代码块。`;

// ==================== Helpers ====================

function safeParseJson<T>(raw: string, schema: z.ZodSchema<T>, fallback: T): T {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/, "").trim(),
    (trimmed.match(/\{[\s\S]*\}/) ?? [""])[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return schema.parse(JSON.parse(c));
    } catch {
      // try next
    }
  }
  return fallback;
}

interface RawHeadline {
  title: string;
  source?: string;
  url?: string;
}

/** 从 webSearch 返回文本里粗暴抽取标题列表。*/
function extractHeadlines(searchText: string, source: string): RawHeadline[] {
  if (!searchText) return [];
  const lines = searchText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: RawHeadline[] = [];
  for (const l of lines) {
    // 形如：【摘要】xxx (URL) / 【相关】xxx (URL) / 【结果】xxx (URL)
    const m = l.match(/^【[^】]+】(.+?)(?:\s*\((https?:\/\/[^)]+)\))?$/);
    if (m && m[1]) {
      const t = m[1].trim();
      if (t.length >= 6 && t.length < 200) {
        out.push({ title: t, url: m[2], source });
      }
    }
  }
  return out;
}

// ==================== 主流程 ====================

export interface ClassifyOptions {
  llmInvoke?: LlmInvokeFn;
  webSearch?: WebSearchFn;
  /** 自定义关键词，否则使用默认 3 组 */
  queries?: string[];
}

const DEFAULT_QUERIES = [
  "今日 A股 财经 重大政策",
  "今日 央行 货币政策 经济数据",
  "今日 半导体 AI 新能源 新闻",
];

export interface ClassifyResult {
  inserted: number;
  skipped_dup: number;
  total_candidates: number;
  llm_failed: boolean;
  search_failed_count: number;
}

export async function classifyTodayNews(
  asOfDate: string,
  opts: ClassifyOptions = {}
): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    inserted: 0,
    skipped_dup: 0,
    total_candidates: 0,
    llm_failed: false,
    search_failed_count: 0,
  };
  const search = opts.webSearch ?? defaultWebSearch;
  const queries = opts.queries ?? DEFAULT_QUERIES;

  // 1) 抓多组关键词
  const headlines: RawHeadline[] = [];
  for (const q of queries) {
    let txt = "";
    try {
      txt = await search(q);
    } catch (e) {
      result.search_failed_count += 1;
      logStage({
        stage: "news.search_failed",
        ok: false,
        query: q,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    headlines.push(...extractHeadlines(txt, `web_search:ddg:${q}`));
  }

  // 去重（按 title）
  const dedup: RawHeadline[] = [];
  const seen = new Set<string>();
  for (const h of headlines) {
    if (seen.has(h.title)) continue;
    seen.add(h.title);
    dedup.push(h);
  }
  result.total_candidates = dedup.length;

  if (dedup.length === 0) {
    // 兜底：写一条 placeholder
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: "fallback",
      url: null,
      title: `${asOfDate} 暂未抓到可分类的公开新闻`,
      summary: null,
      category: "other",
      sentiment: 0,
      impact_indices: "broad",
      rationale: "webSearch 未召回任何标题，事件维度数据缺失",
    });
    if (ok) result.inserted += 1;
    logStage({
      stage: "news.classify_done",
      ok: true,
      asOfDate,
      ...result,
    });
    return result;
  }

  // 2) 让 LLM 一次性分类
  const userPrompt = [
    `决策日: ${asOfDate}`,
    `候选新闻 ${dedup.length} 条：`,
    dedup
      .slice(0, 25) // 限制条数
      .map((h, i) => `${i + 1}. ${h.title}${h.url ? ` (${h.url})` : ""}`)
      .join("\n"),
    ``,
    `请按 schema 分类输出。同一事件的多条标题 MUST 合并为一条。`,
  ].join("\n");

  const invoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await invoke(CLASSIFY_SYSTEM, userPrompt);
  } catch (e) {
    result.llm_failed = true;
    logStage({
      stage: "news.llm_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const parsed = safeParseJson(raw, ClassificationOutputSchema, { events: [] });

  // 3) 写库
  for (const ev of parsed.events) {
    const impact_str =
      typeof ev.impact_indices === "string"
        ? ev.impact_indices
        : JSON.stringify(ev.impact_indices);
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: dedup.find((d) => d.title === ev.title)?.source ?? "web_search:ddg",
      url: dedup.find((d) => d.title === ev.title)?.url ?? null,
      title: ev.title,
      summary: ev.summary ?? null,
      category: ev.category,
      sentiment: ev.sentiment,
      impact_indices: impact_str,
      rationale: ev.rationale,
    });
    if (ok) result.inserted += 1;
    else result.skipped_dup += 1;
  }

  // 如果 LLM 完全没分到事件，也写一条兜底
  if (parsed.events.length === 0 && !result.llm_failed) {
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: "fallback",
      url: null,
      title: `${asOfDate} 候选新闻经分类后无显著影响 A 股的事件`,
      summary: null,
      category: "other",
      sentiment: 0,
      impact_indices: "broad",
      rationale: "LLM 未识别到强相关事件",
    });
    if (ok) result.inserted += 1;
  }

  logStage({
    stage: "news.classify_done",
    ok: !result.llm_failed,
    asOfDate,
    ...result,
  });
  return result;
}

/** 取当日已分类的事件（按情感强度降序）。 */
export function getTodayNewsEvents(asOfDate: string, limit = 10): NewsEventRow[] {
  return getNewsByDate(asOfDate, limit);
}
