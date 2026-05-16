import "dotenv/config";
import Database from "better-sqlite3";
import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  AIMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";
import {
  getQuote,
  getLatestQuote,
  getQuotesInRange,
  getLatestMemory,
  getMarginInRange,
  getLatestMargin,
  getBreadthInRange,
  getLatestBreadth,
  getLatestSectorRotation,
  getNewsByDate,
  getRecentNews,
  getPredictionsInRange,
  getLatestExternalProxy,
  getExternalProxyInRange,
  getLatestFuturesBasis,
  getMacroEventsInRange,
  type ExternalProxyRow,
  type MacroCalendarRow,
} from "./src/agent/stock/db/index.js";
import { ensureRecentMacroSeed } from "./src/agent/stock/providers/macro.js";
import { ingestExternalProxies } from "./src/agent/stock/providers/external.js";
import { ingestFuturesBasis } from "./src/agent/stock/providers/futures.js";
import { ingestLhb } from "./src/agent/stock/providers/lhb.js";
import { ingestMarketBreadth } from "./src/agent/stock/providers/breadth.js";
import { ingestSectorRotation } from "./src/agent/stock/providers/sector.js";
import { ingestLatestMargin } from "./src/agent/stock/providers/margin.js";
import { ingestToday } from "./src/agent/stock/providers/ingestion.js";
import {
  predictChangePctForTarget,
  decideCardTarget,
} from "./src/agent/stock/prediction/realtime-card.js";
import {
  computeAllAccuracy,
  computeAccuracy,
  reviewRecentPredictions,
} from "./src/agent/stock/review/index.js";
import { analyzeRecentPredictions } from "./src/agent/stock/review/analysis.js";
import { getReviewsInRange, getAnalysesInRange, getLatestLhbDate } from "./src/agent/stock/db/index.js";
import { listTargetIndexes, findIndexMeta } from "./src/agent/stock/providers/index.js";
import { predictAllTargets, predictNextTradingDay } from "./src/agent/stock/prediction/index.js";
import { classifyTodayNews } from "./src/agent/stock/news/index.js";
import { getLhbActivity, getLhbForIndex } from "./src/agent/stock/providers/lhb.js";
import {
  fetchQuoteWindow,
  fetchTodayIntraday,
  aggregateForLlm,
  parseRange,
  todayShanghai,
  type QuoteRow,
  type RangeKey,
} from "./src/agent/stock/realtime/index.js";
import { stockGraph, buildContextSystemMessage } from "./src/agent/stock/graph/index.js";
import { logStage } from "./src/agent/stock/utils/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== SQLite 长期记忆 ====================
const MEMORY_DIR = join(__dirname, ".memory");
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const db = new Database(join(MEMORY_DIR, "web_agent.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT    NOT NULL UNIQUE,
    content   TEXT    NOT NULL,
    createdAt TEXT    NOT NULL,
    updatedAt TEXT    NOT NULL
  )
`);

const saveMemory = tool(
  ({ key, content }: { key: string; content: string }) => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM memories WHERE key = ?").get(key);
    if (existing) {
      db.prepare("UPDATE memories SET content = ?, updatedAt = ? WHERE key = ?").run(content, now, key);
      return `已更新记忆 [${key}]: ${content}`;
    }
    db.prepare("INSERT INTO memories (key, content, createdAt, updatedAt) VALUES (?, ?, ?, ?)").run(key, content, now, now);
    return `已保存记忆 [${key}]: ${content}`;
  },
  {
    name: "save_memory",
    description: "将重要信息保存到长期记忆数据库中。当用户提到个人信息、偏好、重要事实时主动保存。",
    schema: z.object({
      key: z.string().describe("记忆键名，如 '用户姓名'"),
      content: z.string().describe("记忆内容"),
    }),
  }
);

const searchMemory = tool(
  ({ query }: { query: string }) => {
    const rows = db.prepare(
      "SELECT key, content, updatedAt FROM memories WHERE key LIKE ? OR content LIKE ?"
    ).all(`%${query}%`, `%${query}%`) as Array<{ key: string; content: string; updatedAt: string }>;

    if (rows.length === 0) {
      const all = db.prepare("SELECT key, content FROM memories").all() as Array<{ key: string; content: string }>;
      if (all.length === 0) return "长期记忆为空。";
      return `未找到与"${query}"相关记忆。所有记忆：\n${all.map((m) => `- [${m.key}]: ${m.content}`).join("\n")}`;
    }
    return rows.map((m) => `[${m.key}]: ${m.content} (${m.updatedAt})`).join("\n");
  },
  {
    name: "search_memory",
    description: "从长期记忆中搜索信息。需要回忆用户信息时调用。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

// ==================== 联网搜索工具 ====================
const webSearch = tool(
  async ({ query }: { query: string }) => {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url);
      if (!res.ok) {
        return `[联网搜索不可达] HTTP ${res.status}。请基于本地数据回答，不要编造行情。`;
      }
      const data = await res.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const results: string[] = [];
      if (data.AbstractText) {
        results.push(`摘要: ${data.AbstractText}\n来源: ${data.AbstractURL ?? ""}`);
      }
      for (const topic of data.RelatedTopics ?? []) {
        if (topic.Text) results.push(`${topic.Text}\n链接: ${topic.FirstURL ?? ""}`);
      }
      for (const r of data.Results ?? []) {
        if (r.Text) results.push(`${r.Text}\n链接: ${r.FirstURL ?? ""}`);
      }
      return results.length ? results.join("\n\n") : `未找到"${query}"的相关信息`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[联网搜索失败] ${msg}。请基于本地数据库或长期记忆回答，不要凭空编造数字或方向。`;
    }
  },
  {
    name: "web_search",
    description: "联网搜索互联网获取实时信息。仅在本地数据无法回答时使用；禁止用搜索结果编造行情数字。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

const webFetch = tool(
  async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent/1.0)" },
      });
      if (!res.ok) {
        return `[网页抓取不可达] ${url} → HTTP ${res.status}`;
      }
      const html = await res.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[网页抓取失败] ${url} → ${msg}`;
    }
  },
  {
    name: "web_fetch",
    description: "获取指定URL网页的文本内容。当搜索结果中有需要深入阅读的链接时使用。",
    schema: z.object({ url: z.string().describe("要访问的网页URL") }),
  }
);

// ==================== 指数数据查询工具（来自 stock_agent.db） ====================

function formatVolumeLite(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "万亿手";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return Math.round(v).toString() + "手";
}

function resolveIndexCode(input?: string): string | null {
  if (!input) return null;
  const v = input.trim();
  // 直接匹配 code
  const direct = findIndexMeta(v);
  if (direct) return direct.index_code;
  // 按名称匹配
  for (const meta of listTargetIndexes()) {
    if (v.includes(meta.index_name)) return meta.index_code;
  }
  // 别名
  if (/上证|沪指|大盘/.test(v)) return "000001.SH";
  if (/创业板|创指/.test(v)) return "399006.SZ";
  return null;
}

const queryIndexQuotes = tool(
  ({ index, start_date, end_date, limit }: { index?: string; start_date?: string; end_date?: string; limit?: number }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}。支持上证指数 / 创业板指。`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      let rows;
      if (start_date && end_date) {
        rows = getQuotesInRange(code, start_date, end_date);
      } else {
        const latest = getLatestQuote(code);
        if (!latest) {
          out.push(`【${name}】 暂无数据。`);
          continue;
        }
        const start = (() => {
          const d = new Date(latest.trade_date);
          d.setUTCDate(d.getUTCDate() - 30);
          return d.toISOString().slice(0, 10);
        })();
        rows = getQuotesInRange(code, start, latest.trade_date);
      }

      const tail = rows.slice(-(limit ?? 30));
      out.push(`【${name}】共 ${tail.length} 条：`);
      for (const r of tail) {
        const pct = r.change_pct == null ? "-" : (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%";
        const reason = (r.change_reason ?? "（无归因）").slice(0, 60);
        const ohlc =
          r.open_value != null && r.high_value != null && r.low_value != null
            ? `开${r.open_value.toFixed(2)} 高${r.high_value.toFixed(2)} 低${r.low_value.toFixed(2)}`
            : "OHLC=-";
        const vol = formatVolumeLite(r.volume);
        out.push(
          `  ${r.trade_date} ${ohlc} 收${r.close_value.toFixed(2)} 涨跌${pct} 量${vol}  原因=${reason}`
        );
      }
    }
    return out.join("\n");
  },
  {
    name: "query_index_quotes",
    description:
      "查询上证指数 / 创业板指的历史日线行情（含每日涨跌原因 change_reason）。参数 index 可填 '上证指数' / '创业板指' / 代码 '000001.SH' / '399006.SZ'，留空则两个都查。start_date / end_date 用 YYYY-MM-DD；省略则返回最近 30 个交易日。limit 控制返回条数。",
    schema: z.object({
      index: z.string().optional().describe("指数名称或代码，留空查询全部"),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
  }
);

const queryIndexQuoteByDate = tool(
  ({ index, date }: { index: string; date: string }) => {
    const code = resolveIndexCode(index);
    if (!code) return `未识别指数：${index}`;
    const row = getQuote(code, date);
    const meta = findIndexMeta(code);
    if (!row) return `【${meta?.index_name ?? code}】 ${date} 无记录（可能是非交易日或尚未入库）。`;
    const pct = row.change_pct == null ? "-" : (row.change_pct >= 0 ? "+" : "") + row.change_pct.toFixed(2) + "%";
    const ohlcLine =
      row.open_value != null && row.high_value != null && row.low_value != null
        ? `  开盘=${row.open_value.toFixed(2)}, 最高=${row.high_value.toFixed(2)}, 最低=${row.low_value.toFixed(2)}`
        : `  OHLC: 缺失`;
    const volLine = `  成交量=${formatVolumeLite(row.volume)}${
      row.turnover != null ? `, 成交额=${(row.turnover / 1e8).toFixed(2)}亿元` : ""
    }`;
    return [
      `【${meta?.index_name ?? code}】 ${date}`,
      ohlcLine,
      `  收盘=${row.close_value.toFixed(2)}, 涨跌=${pct}`,
      volLine,
      `  原因: ${row.change_reason ?? "（无归因）"}`,
      `  来源: ${row.reason_source ?? "（无来源）"}`,
    ].join("\n");
  },
  {
    name: "query_index_quote_by_date",
    description: "查询某只指数在某个交易日的具体行情与涨跌原因。",
    schema: z.object({
      index: z.string().describe("指数名称或代码"),
      date: z.string().describe("YYYY-MM-DD"),
    }),
  }
);

const queryIndexMemory = tool(
  ({ index }: { index?: string }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      const m = getLatestMemory(code);
      if (!m) {
        out.push(`【${name}】 暂无长期分析记忆。`);
        continue;
      }
      out.push(`【${name}】 v${m.version}（as_of=${m.as_of_date}）`);
      out.push(`  summary: ${m.summary}`);
      out.push(`  features: ${m.features}`);
    }
    return out.join("\n");
  },
  {
    name: "query_index_memory",
    description:
      "查询某只指数最新的长期分析记忆（summary + features）。每次预测后都会写入新版本，可用于回顾智能体当前对趋势的判断。留空 index 则两个都查。",
    schema: z.object({ index: z.string().optional() }),
  }
);

const queryLatestPrediction = tool(
  ({ index }: { index?: string }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      const m = getLatestMemory(code);
      if (!m) {
        out.push(`【${name}】 暂无长期分析记忆，请先调用 run_prediction_now 触发一次预测。`);
        continue;
      }
      let features: Record<string, unknown> = {};
      try {
        features = JSON.parse(m.features);
      } catch {
        features = {};
      }
      const pred = (features as {
        last_prediction?: {
          direction?: string;
          confidence?: number;
          rationale?: string;
          predicted_at?: string;
          based_on_trade_date?: string;
          predicted_change_pct?: number;
          predicted_change_pct_low?: number;
          predicted_change_pct_high?: number;
          magnitude_bucket?: string;
          dimensions_used?: number;
          signals?: Record<string, string>;
        }
      }).last_prediction;
      if (!pred?.direction) {
        out.push(`【${name}】 v${m.version}（as_of=${m.as_of_date}）记忆里没有保存方向；请用 run_prediction_now 触发一次新预测以获得方向。`);
        continue;
      }
      const dirText = pred.direction === "up" ? "买涨" : "买跌";
      const confText = pred.confidence == null ? "-" : (pred.confidence * 100).toFixed(1) + "%";
      const pctText = pred.predicted_change_pct != null
        ? (pred.predicted_change_pct >= 0 ? "+" : "") + pred.predicted_change_pct.toFixed(2) + "%"
        : "-";
      const rangeText = pred.predicted_change_pct_low != null && pred.predicted_change_pct_high != null
        ? `[${(pred.predicted_change_pct_low >= 0 ? "+" : "") + pred.predicted_change_pct_low.toFixed(2)}%, ${(pred.predicted_change_pct_high >= 0 ? "+" : "") + pred.predicted_change_pct_high.toFixed(2)}%]`
        : "-";
      out.push(`【${name}】 下一交易日 → ${dirText}（置信度 ${confText}，预测 ${pctText}，区间 ${rangeText}）`);
      out.push(`  基于交易日: ${pred.based_on_trade_date ?? m.as_of_date}`);
      out.push(`  生成时间: ${pred.predicted_at ?? "-"}`);
      out.push(`  记忆版本: v${m.version}`);
      out.push(`  覆盖维度: ${pred.dimensions_used ?? "-"}/10`);
      if (pred.rationale) {
        out.push(`  理由: ${pred.rationale}`);
      }
      if (pred.signals && Object.keys(pred.signals).length > 0) {
        const sigLines = Object.entries(pred.signals)
          .map(([k, v]) => {
            const labelMap: Record<string, string> = {
              trend: "价格趋势", volume: "量能", fund_flow: "资金面",
              breadth: "市场广度", sector: "板块轮动", lhb: "龙虎榜",
              news: "新闻事件", macro: "宏观日历", external: "外资代理", futures: "股指期货",
            };
            const dirMap: Record<string, string> = { up: "偏多", down: "偏空", neutral: "中性", missing: "缺失" };
            return `${labelMap[k] ?? k}: ${dirMap[v] ?? v}`;
          })
          .join(" / ");
        out.push(`  各维度信号: ${sigLines}`);
      }
    }
    out.push("");
    out.push("（仅供参考，非投资建议）");
    return out.join("\n");
  },
  {
    name: "query_latest_prediction",
    description: "查询指数智能体上一次给出的下一交易日方向（买涨/买跌）+ 置信度 + 理由 + 各维度信号 + 基于的交易日。**用户问'下一个交易日怎么走'/'买涨还是买跌'/'你预测什么'/'为什么这样判断'/'具体依据是什么'/'详细理由'时优先使用此工具，禁止用 web_search 编方向**。留空 index 则两个都查。",
    schema: z.object({ index: z.string().optional() }),
  }
);

const runPredictionNow = tool(
  async ({ index }: { index?: string }) => {
    const code = resolveIndexCode(index ?? "");
    try {
      if (code) {
        const r = await predictNextTradingDay(code);
        return [
          `【${r.index_name}】 下一交易日 → ${r.direction === "up" ? "买涨" : "买跌"}（置信度 ${(r.confidence * 100).toFixed(1)}%）`,
          `  理由: ${r.rationale}`,
          `  基于: ${r.as_of_date}, 已写入记忆 v${r.version}`,
          ``,
          `（仅供参考，非投资建议）`,
        ].join("\n");
      }
      const all = await predictAllTargets();
      const lines = ["[新一轮预测结果]"];
      for (const r of all) {
        lines.push(`- ${r.index_name}: ${r.direction === "up" ? "买涨" : "买跌"}（置信度 ${(r.confidence * 100).toFixed(1)}%）→ v${r.version}`);
        lines.push(`    理由: ${r.rationale}`);
      }
      lines.push("");
      lines.push("（仅供参考，非投资建议）");
      return lines.join("\n");
    } catch (e) {
      return `[预测失败] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "run_prediction_now",
    description: "立即触发一次新的下一交易日方向预测（会消耗 LLM 配额，约 10-20 秒），写入新版本长期记忆。当用户明确要求'重新预测一下/帮我跑一次/现在预测'时调用。留空 index 则两个指数都跑。",
    schema: z.object({ index: z.string().optional() }),
  }
);

// ==================== 多信号查询工具（资金面 / 广度 / 板块 / 龙虎榜 / 事件）====================

const queryMarginBalance = tool(
  ({ days = 7 }: { days?: number }) => {
    const latest = getLatestMargin();
    if (!latest) return "[两融余额] 无数据。请先跑 backfill_margin。";
    const start = (() => {
      const d = new Date(latest.trade_date);
      d.setUTCDate(d.getUTCDate() - Math.ceil(days * 1.6));
      return d.toISOString().slice(0, 10);
    })();
    const rows = getMarginInRange(start, latest.trade_date).slice(-days);
    const lines = [`[两融余额最近 ${rows.length} 个交易日（截至 ${latest.trade_date}，T+1 滞后）]`];
    lines.push(`date\t融资余额(亿)\t融资净买入(亿)\t融券余额(亿)\t两融总额(亿)`);
    for (const r of rows) {
      lines.push(
        [
          r.trade_date,
          r.finance_balance != null ? (r.finance_balance / 1e8).toFixed(0) : "-",
          r.finance_net != null ? (r.finance_net >= 0 ? "+" : "") + (r.finance_net / 1e8).toFixed(2) : "-",
          r.short_balance != null ? (r.short_balance / 1e8).toFixed(0) : "-",
          r.total_balance != null ? (r.total_balance / 1e8).toFixed(0) : "-",
        ].join("\t")
      );
    }
    const sumNet = rows.reduce((a, r) => a + (r.finance_net ?? 0), 0);
    lines.push(`累计融资净买入: ${sumNet >= 0 ? "+" : ""}${(sumNet / 1e8).toFixed(2)}亿`);
    return lines.join("\n");
  },
  {
    name: "query_margin_balance",
    description:
      "查询融资融券余额近 N 个交易日（默认 7）。返回融资余额、融资净买入、融券余额。用户问'最近两融加仓还是减仓''融资资金流入流出'时调用。数据 T+1 滞后属正常监管口径。",
    schema: z.object({ days: z.number().optional().describe("最近多少个交易日，默认 7") }),
  }
);

const queryMarketBreadth = tool(
  ({ days = 5 }: { days?: number }) => {
    const latest = getLatestBreadth();
    if (latest.length === 0) return "[市场广度] 无数据。请先跑 ingest_breadth。";
    const tradeDate = latest[0].trade_date;
    const start = (() => {
      const d = new Date(tradeDate);
      d.setUTCDate(d.getUTCDate() - Math.ceil(days * 1.6));
      return d.toISOString().slice(0, 10);
    })();
    const rows = getBreadthInRange(start, tradeDate);
    const byDate = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byDate.get(r.trade_date) ?? [];
      arr.push(r);
      byDate.set(r.trade_date, arr);
    }
    const dates = [...byDate.keys()].sort().slice(-days);
    const lines = [`[市场广度最近 ${dates.length} 个交易日]`];
    lines.push(`date\t上证(涨/跌/平/涨停)\t深证(涨/跌/平/涨停)\t创业板(涨/跌/平/涨停)`);
    for (const d of dates) {
      const groups = byDate.get(d) ?? [];
      const fmt = (s: string) => {
        const x = groups.find((g) => g.scope === s);
        if (!x) return "-";
        return `${x.advancing ?? "-"}/${x.declining ?? "-"}/${x.unchanged ?? "-"}/${x.limit_up ?? "-"}`;
      };
      lines.push(`${d}\t${fmt("sse")}\t${fmt("szse")}\t${fmt("chinext")}`);
    }
    return lines.join("\n");
  },
  {
    name: "query_market_breadth",
    description:
      "查询沪/深/创三市最近 N 个交易日的涨跌平家数 + 涨停数（默认 5）。用户问'今天涨家多还是跌家多''市场情绪/赚钱效应'时调用。",
    schema: z.object({ days: z.number().optional().describe("最近多少个交易日，默认 5") }),
  }
);

const querySectorRotation = tool(
  () => {
    const rows = getLatestSectorRotation();
    if (rows.length === 0) return "[板块轮动] 无数据。请先跑 ingest_sector。";
    const top = rows.filter((r) => r.rank_type === "top5").sort((a, b) => a.rank_pos - b.rank_pos);
    const bot = rows
      .filter((r) => r.rank_type === "bottom5")
      .sort((a, b) => a.rank_pos - b.rank_pos);
    const lines = [`[当日板块轮动 ${rows[0].trade_date}]`];
    lines.push("涨幅 Top5:");
    for (const r of top) {
      lines.push(
        `  ${r.rank_pos}. ${r.sector_name} (${r.sector_code}) +${r.change_pct?.toFixed(2)}% 换手 ${r.turnover_pct?.toFixed(2)}%`
      );
    }
    lines.push("跌幅 Bottom5:");
    for (const r of bot) {
      lines.push(
        `  ${r.rank_pos}. ${r.sector_name} (${r.sector_code}) ${r.change_pct?.toFixed(2)}% 换手 ${r.turnover_pct?.toFixed(2)}%`
      );
    }
    return lines.join("\n");
  },
  {
    name: "query_sector_rotation",
    description:
      "返回当日板块涨幅榜 Top5 + 跌幅榜 Bottom5（含板块名、代码、涨跌幅、换手）。用户问'今天什么板块在动''今天涨什么''今天跌什么'时调用。",
    schema: z.object({}),
  }
);

const queryLhbToday = tool(
  ({ index_code }: { index_code?: string }) => {
    if (index_code) {
      const meta = findIndexMeta(index_code);
      if (!meta) return `未知指数 ${index_code}`;
      const latest = getLatestQuote(index_code);
      if (!latest) return "[龙虎榜] 该指数无行情数据";
      const r = getLhbForIndex(latest.trade_date, index_code);
      if (r.count === 0) return `[${meta.index_name}] ${latest.trade_date} 无成分股上榜`;
      const sign = r.net_amount_sum >= 0 ? "+" : "";
      const lines = [
        `[${meta.index_name} ${latest.trade_date} 龙虎榜成分股 ${r.count} 只，净买入合计 ${sign}${(r.net_amount_sum / 1e8).toFixed(2)}亿]`,
      ];
      for (const t of r.top_3) {
        lines.push(
          `  ${t.code} ${t.name}  净额 ${t.net_amount >= 0 ? "+" : ""}${(t.net_amount / 1e8).toFixed(2)}亿  原因: ${(t.explanation ?? "").slice(0, 50)}`
        );
      }
      return lines.join("\n");
    }
    // 全市场
    const latest = getLatestQuote("000001.SH");
    const date = latest?.trade_date ?? new Date().toISOString().slice(0, 10);
    const a = getLhbActivity(date);
    if (a.total_count === 0) return `[${date}] 龙虎榜无数据`;
    const lines = [
      `[全市场 ${date} 龙虎榜 ${a.total_count} 只上榜，净买入合计 +${(a.net_buy_total / 1e8).toFixed(2)}亿，净卖出合计 ${(a.net_sell_total / 1e8).toFixed(2)}亿]`,
      `Top 3 (按 |净买入|):`,
    ];
    for (const t of a.top_3_by_net_amount) {
      lines.push(
        `  ${t.code} ${t.name}  净额 ${t.net_amount >= 0 ? "+" : ""}${(t.net_amount / 1e8).toFixed(2)}亿  原因: ${(t.explanation ?? "").slice(0, 50)}`
      );
    }
    return lines.join("\n");
  },
  {
    name: "query_lhb_today",
    description:
      "返回当日龙虎榜个股聚合：上榜只数、净买入合计、Top 3 个股净额与上榜原因。可指定 index_code 仅看影响该指数的成分股。用户问'今天龙虎榜机构看上谁''今天谁上龙虎榜'时调用。",
    schema: z.object({
      index_code: z
        .string()
        .optional()
        .describe("可选 000001.SH / 399006.SZ / 399001.SZ；不传则全市场"),
    }),
  }
);

const queryTodayEvents = tool(
  ({ as_of_date }: { as_of_date?: string }) => {
    const date = as_of_date ?? getLatestQuote("000001.SH")?.trade_date ?? new Date().toISOString().slice(0, 10);
    const events = getNewsByDate(date, 30);
    if (events.length === 0) return `[${date}] 当日无已分类新闻事件。可调用 web_search 临时搜索。`;
    const grouped = new Map<string, typeof events>();
    for (const e of events) {
      const k = e.category ?? "other";
      const arr = grouped.get(k) ?? [];
      arr.push(e);
      grouped.set(k, arr);
    }
    const lines = [`[${date} 当日已分类事件 ${events.length} 条]`];
    for (const [cat, evs] of grouped) {
      lines.push(`\n# ${cat} (${evs.length})`);
      for (const e of evs) {
        const s = e.sentiment != null ? (e.sentiment >= 0 ? "+" : "") + e.sentiment.toFixed(2) : "0";
        lines.push(`  [${s} ${e.impact_indices ?? "-"}] ${e.title}`);
        if (e.rationale) lines.push(`     ↳ ${e.rationale}`);
      }
    }
    return lines.join("\n");
  },
  {
    name: "query_today_events",
    description:
      "返回某一交易日已分类的财经事件（按类别分组）。每条带 category / sentiment / impact_indices / rationale。用户问'今天有什么大新闻''今天 A 股有什么消息面'时调用。",
    schema: z.object({
      as_of_date: z.string().optional().describe("YYYY-MM-DD，默认当日"),
    }),
  }
);

const queryStockOverview = tool(
  () => {
    const out: string[] = ["[指数智能体数据概览]"];
    for (const meta of listTargetIndexes()) {
      const latest = getLatestQuote(meta.index_code);
      const memory = getLatestMemory(meta.index_code);
      out.push(`- ${meta.index_name} (${meta.index_code})`);
      if (latest) {
        const pct = latest.change_pct == null ? "-" : (latest.change_pct >= 0 ? "+" : "") + latest.change_pct.toFixed(2) + "%";
        const ohlc =
          latest.open_value != null && latest.high_value != null && latest.low_value != null
            ? ` 开${latest.open_value.toFixed(2)}/高${latest.high_value.toFixed(2)}/低${latest.low_value.toFixed(2)}`
            : "";
        out.push(
          `    最新行情: ${latest.trade_date}${ohlc} 收=${latest.close_value.toFixed(2)} 涨跌=${pct} 量=${formatVolumeLite(latest.volume)}`
        );
      } else {
        out.push(`    最新行情: 无`);
      }
      if (memory) {
        out.push(`    长期记忆: v${memory.version} (as_of=${memory.as_of_date})`);
      } else {
        out.push(`    长期记忆: 无`);
      }
    }
    return out.join("\n");
  },
  {
    name: "query_stock_overview",
    description: "返回指数智能体当前的整体数据状态：每只指数的最新行情 + 最新长期记忆版本号。用户问'你那边有什么数据'类问题时调用。",
    schema: z.object({}),
  }
);

// ==================== 上下文压缩 ====================
const MAX_TOKENS = 4000;

function estimateTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(content.length / 2);
  }
  return total;
}

async function summarizeMessages(messages: BaseMessage[], summarizer: ChatOpenAI): Promise<SystemMessage> {
  const conversationText = messages
    .map((m) => {
      const role = m instanceof HumanMessage ? "用户" : m instanceof AIMessage ? "助手" : "系统";
      return `${role}: ${typeof m.content === "string" ? m.content : ""}`;
    })
    .join("\n");

  const response = await summarizer.invoke([
    new SystemMessage("你是一个对话压缩助手。请将以下对话历史压缩为简洁的摘要，保留所有关键信息（用户身份、偏好、讨论要点、决策结论）。使用中文，不超过500字。"),
    new HumanMessage(`请压缩以下对话：\n${conversationText}`),
  ]);

  return new SystemMessage(`[历史对话摘要]\n${typeof response.content === "string" ? response.content : ""}`);
}

async function compressIfNeeded(messages: BaseMessage[], summarizer: ChatOpenAI): Promise<BaseMessage[]> {
  const tokenCount = estimateTokens(messages);
  if (tokenCount <= MAX_TOKENS) return messages;

  console.log(`[压缩] ${tokenCount} tokens 超过限制 ${MAX_TOKENS}，开始压缩...`);

  const keepRecent = 6;
  const oldMessages = messages.slice(1, Math.max(1, messages.length - keepRecent));
  const recentMessages = messages.slice(Math.max(1, messages.length - keepRecent));
  if (oldMessages.length === 0) return messages;

  const summary = await summarizeMessages(oldMessages, summarizer);
  const compressed = [messages[0], summary, ...recentMessages];
  console.log(`[压缩完成] ${oldMessages.length} 条旧消息 → 1 条摘要，${tokenCount} → ${estimateTokens(compressed)} tokens`);
  return compressed;
}

// ==================== LangGraph 智能体 ====================
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const llm = new ChatOpenAI({
  model: "moonshot-v1-32k",
  apiKey: process.env.KIMI_API_KEY,
  configuration: { baseURL: "https://api.moonshot.cn/v1" },
  streaming: true,
});

const summarizer = new ChatOpenAI({
  model: "moonshot-v1-32k",
  apiKey: process.env.KIMI_API_KEY,
  configuration: { baseURL: "https://api.moonshot.cn/v1" },
});

const allTools = [
  saveMemory,
  searchMemory,
  webSearch,
  webFetch,
  queryIndexQuotes,
  queryIndexQuoteByDate,
  queryIndexMemory,
  queryLatestPrediction,
  runPredictionNow,
  queryStockOverview,
  queryMarginBalance,
  queryMarketBreadth,
  querySectorRotation,
  queryLhbToday,
  queryTodayEvents,
];
const llmWithTools = llm.bindTools(allTools);

const SYSTEM_PROMPT = `你是一个全能智能助手，具备以下能力：

## 核心能力
1. **长期记忆**: 记住用户告诉你的任何信息，下次对话时能回忆起来
   - 用户提到个人信息、偏好、重要事实时，调用 save_memory 保存
   - 需要回忆用户信息时，调用 search_memory 查找
2. **联网搜索**: 可以搜索互联网获取最新信息
   - 使用 web_search 搜索实时信息
   - 使用 web_fetch 获取网页详细内容
3. **指数行情数据库（多信号）**: 你接管了 stock-index-agent 智能体生成的数据，可以回答上证指数和创业板指的历史行情、每日涨跌原因、长期分析记忆、下一交易日预测，以及 7 维度多信号数据。
   ## 价格行情维度
   - "最近行情/这周走势/某天为什么涨跌" → query_index_quotes / query_index_quote_by_date
   - "下一交易日怎么走/买涨还是买跌/你的预测/为什么这样判断/具体依据/详细理由" → **先调用 query_latest_prediction**；提示"无方向/无记忆"时再 run_prediction_now
   - "你对趋势的判断/分析记忆/summary" → query_index_memory
   - "有哪些数据/数据现状" → query_stock_overview
   ## 多信号维度
   - **资金面**：用户问"两融/融资余额/资金流入流出/最近加仓还是减仓" → query_margin_balance（数据 T+1 滞后）
   - **市场广度**：用户问"今天涨家多还是跌家多/市场情绪/赚钱效应/涨停数" → query_market_breadth
   - **板块轮动**：用户问"今天什么板块在动/今天涨什么/今天跌什么/热点主题" → query_sector_rotation
   - **龙虎榜异动**：用户问"今天龙虎榜机构看上谁/今天谁上龙虎榜/机构在出手谁" → query_lhb_today；可指定 index_code
   - **当日事件**：用户问"今天有什么大新闻/A 股有什么消息面/政策面" → query_today_events
   ## 别名
   - 上证指数=000001.SH（也叫沪指/大盘）；创业板指=399006.SZ（也叫创指）
   ## 注意
   - 涉及 A 股的查询**优先用本地工具**而不是 web_search；web_search 只用于补充本地没有的实时新闻或政策原文。
   - 北向资金（沪深港通）数据源已停止公布每日数据（港交所 2024-08 起），不要用 web_search 找"北向资金"，应直接告知用户该数据已无可靠来源。

## 工作流程
1. 对话开始时，可调用 search_memory 了解用户背景
2. 发现新的用户信息，调用 save_memory 保存
3. 涉及指数数据 / 预测 / 涨跌方向时，**必须**先用 query_index_* / query_latest_prediction 读本地库；本地无答案时才考虑 web_search
4. **绝对禁止用 web_search 的结果直接给出指数点位、涨跌幅或买涨/买跌方向**——这些只能来自本地数据库或 run_prediction_now

## 注意事项
- 始终使用中文回答
- 回答要有据可依：行情要带具体日期与点位；预测要带置信度、记忆版本号、基于的交易日
- 涉及投资方向的回答末尾必须附"仅供参考，非投资建议"
- 工具返回 [联网搜索失败] / [联网搜索不可达] 时，不要因此放弃；改用本地工具回答，并在末尾告知用户网络当前不可达
- 对话要自然友好`;

async function agentNode(state: typeof AgentState.State) {
  const systemMsg = new SystemMessage(SYSTEM_PROMPT);
  const allMessages = [systemMsg, ...state.messages];
  const compressed = await compressIfNeeded(allMessages, summarizer);
  const response = await llmWithTools.invoke(compressed);
  return { messages: [response] };
}

const toolNode = new ToolNode(allTools);

function shouldContinue(state: typeof AgentState.State) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (isAIMessage(lastMsg) && lastMsg.tool_calls?.length) return "tools";
  return END;
}

const workflow = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
const graph = workflow.compile({ checkpointer });

// ==================== Express 服务器 ====================
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// 聊天会话存储（线程ID → 消息列表）
const sessions = new Map<string, BaseMessage[]>();

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default" } = req.body as { message: string; sessionId?: string };

  if (!message) {
    res.status(400).json({ error: "消息不能为空" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: string) => {
    res.write(`data: ${JSON.stringify({ content: data })}\n\n`);
  };

  try {
    const stream = await graph.stream(
      { messages: [new HumanMessage(message)] },
      { configurable: { thread_id: sessionId } }
    );

    let fullResponse = "";

    for await (const chunk of stream) {
      for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
        const messages = (nodeOutput as { messages: BaseMessage[] }).messages;
        const lastMsg = messages[messages.length - 1];

        if (nodeName === "tools") {
          const toolContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
          if (toolContent) {
            sendEvent(`[工具调用] ${toolContent.slice(0, 100)}...`);
          }
        }

        if (nodeName === "agent" && typeof lastMsg.content === "string" && lastMsg.content) {
          const newText = lastMsg.content;
          if (newText.length > fullResponse.length) {
            const delta = newText.slice(fullResponse.length);
            fullResponse = newText;
            sendEvent(delta);
          }
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, fullResponse })}\n\n`);
    res.end();
  } catch (error) {
    console.error("聊天错误:", error);
    sendEvent("抱歉，发生了错误，请稍后重试。");
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
});

// 获取长期记忆列表
app.get("/api/memories", (_req, res) => {
  const rows = db.prepare("SELECT key, content, updatedAt FROM memories ORDER BY updatedAt DESC").all();
  res.json(rows);
});

// ==================== /api/stock/* 实时行情 + Tab UI 后端 ====================
//
// 这一组接口承载需求文档 docs/requirement/11.md 的"实时数据"诉求：
// - 智能体问答（/api/stock/chat）：按窗口实时拉取后注入 LLM 上下文，不读 SQLite。
// - 大盘 Tab 数据（/api/stock/quotes /quotes/today /trading-day）：纯实时。
// 既有 cron + 短信 + 长期记忆链路完全不受影响。

const VALID_RANGES: RangeKey[] = ["3d", "10d", "1m", "2m", "3m", "1y", "custom"];
const STOCK_KEYWORDS = ["大盘", "上证", "创业板", "000001", "399006", "指数", "A股", "盘面", "沪指", "创指"];

interface ParsedStockRangeQuery {
  range: RangeKey;
  from?: string;
  to?: string;
  start: string;
  end: string;
}

/**
 * 从 query / body 解析时间范围参数。失败时直接写 400 并返回 null，调用方
 * 立即 return 即可。range 缺省视为 "1m"（30 天）。
 */
function parseStockRangeQuery(req: express.Request, res: express.Response): ParsedStockRangeQuery | null {
  const source = (req.method === "GET" ? req.query : req.body) as Record<string, unknown>;
  const rangeRaw = (source.range as string | undefined) ?? "1m";
  if (!VALID_RANGES.includes(rangeRaw as RangeKey)) {
    res.status(400).json({ error: "invalid range" });
    return null;
  }
  const range = rangeRaw as RangeKey;
  const from = source.from as string | undefined;
  const to = source.to as string | undefined;
  try {
    const { start, end } = parseRange({ range, from, to });
    return { range, from, to, start, end };
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

function rangeLabel(p: ParsedStockRangeQuery): string {
  const map: Record<RangeKey, string> = {
    "3d": "近 3 天",
    "10d": "近 10 天",
    "1m": "近 30 天",
    "2m": "近 60 天",
    "3m": "近 90 天",
    "1y": "近一年",
    custom: `${p.start} ~ ${p.end}`,
  };
  return map[p.range];
}

/**
 * 严格判定：指定日期"此刻是否处于可拉实时盘中数据的时段"。给 /api/stock/trading-day
 * 与前端 5 分钟轮询使用——开市前 / 收盘后都返回 false，避免轮询打到非盘中接口。
 *
 * 判定来源：
 *   1) DB（index_quotes）中已有该日 row → true（已经成交并入库）
 *   2) 否则按"周一至周五 + 当前时间在 09:30-11:30 / 13:00-15:00 (Asia/Shanghai)"启发判定。
 *
 * 不引入交易日历依赖；最坏后果是节假日上午误判为交易日 → 后续实时拉取失败时
 * 由 5s LRU 吸收 + 502 暴露给前端，前端轮询时不会持续打满。
 */
function isTradingDayHeuristic(date: string, now: Date = new Date()): boolean {
  for (const meta of listTargetIndexes()) {
    if (getQuote(meta.index_code, date)) return true;
  }
  if (date !== todayShanghai(now)) return false;

  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dow = shanghai.getUTCDay(); // 0..6, 0=Sun
  if (dow === 0 || dow === 6) return false;
  const hh = shanghai.getUTCHours();
  const mm = shanghai.getUTCMinutes();
  const minutes = hh * 60 + mm;
  const morning = minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
  const afternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
  return morning || afternoon;
}

/**
 * 宽松判定：指定日期"是否大概率是交易日"。给 AI 卡片预测使用——开盘前（如 8:00）
 * 也应当判定今日是交易日，从而预测当天涨跌幅而不是跳到下一交易日。
 *
 * 判定规则：
 *   1) DB 中已有该日 row → true
 *   2) 历史日期（早于今日）DB 无 row → false（节假日 / 周末，cron 也没补到）
 *   3) 今日或未来：周一~周五 → true，周末 → false
 *
 * 节假日识别仍然有缺口（无交易日历），但对"开盘前预测今日"这种核心场景已经足够。
 */
function isLikelyTradingDay(date: string, now: Date = new Date()): boolean {
  for (const meta of listTargetIndexes()) {
    if (getQuote(meta.index_code, date)) return true;
  }
  const today = todayShanghai(now);
  if (date < today) return false;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6;
}

app.get("/api/stock/quotes", async (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  const parsed = parseStockRangeQuery(req, res);
  if (!parsed) return;

  try {
    const rows = await fetchQuoteWindow(indexCode, parsed.range, { from: parsed.from, to: parsed.to });
    res.json({
      indexCode,
      indexName: meta.index_name,
      range: parsed.range,
      from: parsed.start,
      to: parsed.end,
      rows,
    });
  } catch (e) {
    logStage({
      stage: "realtime.fetch_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(502).json({ error: "upstream quote provider failed" });
  }
});

app.get("/api/stock/quotes/today", async (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  try {
    const row = await fetchTodayIntraday(indexCode);
    res.json({
      indexCode,
      indexName: meta.index_name,
      row,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    logStage({
      stage: "realtime.fetch_today_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(502).json({ error: "upstream quote provider failed" });
  }
});

app.get("/api/stock/trading-day", (req, res) => {
  const date = (req.query.date as string | undefined) ?? todayShanghai();
  const isTradingDay = isTradingDayHeuristic(date);
  res.json({ date, isTradingDay });
});

// ==================== AI 涨跌幅预测 ====================
//
// - GET /api/stock/predictions          按窗口拉取已落库的预测，前端用于在大盘表格中渲染"AI 预测涨跌幅"列。
// - GET /api/stock/predictions/card     卡片预测：目标日为"今日（交易日 < 14:30）"或"下一交易日"，
//                                       若 DB 已有则直接返回；否则调 LLM 生成并落库。
//
// 预测结果统一存在 stock_agent.db 的 index_predictions 表，按 (index_code, target_date) 唯一。
// 历史日期若未预测过，前端拿不到记录就展示 "--"。

app.get("/api/stock/predictions", (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  const parsed = parseStockRangeQuery(req, res);
  if (!parsed) return;
  try {
    const rows = getPredictionsInRange(indexCode, parsed.start, parsed.end);
    res.json({
      indexCode,
      indexName: meta.index_name,
      from: parsed.start,
      to: parsed.end,
      rows,
    });
  } catch (e) {
    logStage({
      stage: "predictions.list_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "predictions query failed" });
  }
});

app.get("/api/stock/predictions/card", async (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  const force = String(req.query.force ?? "") === "1";
  try {
    const today = todayShanghai();
    // 用宽松判定（不要求当前时间处于盘中时段）：开市前 8:00 也应判今日是交易日。
    const isTodayTradingDay = isLikelyTradingDay(today);
    const target = decideCardTarget(isTodayTradingDay);
    const prediction = await predictChangePctForTarget(indexCode, target.target, { force });
    res.json({
      indexCode,
      indexName: meta.index_name,
      target: target.target,
      reason: target.reason,
      label: target.label,
      isTodayTradingDay,
      prediction,
    });
  } catch (e) {
    logStage({
      stage: "predictions.card_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(502).json({ error: "predict failed", message: e instanceof Error ? e.message : String(e) });
  }
});

// ==================== AI 预测准确率（P2-7）====================
//
// - GET /api/stock/accuracy        汇总：方向命中率 / 区间命中率 / 平均绝对误差 MAE。可选 indexCode + days。
// - GET /api/stock/reviews         明细：列出 [start, end] 区间内每一条预测 vs 实际。
// - POST /api/stock/reviews/refresh 触发一次盘后回顾（默认回顾近 90 天）。

function parseDaysQuery(req: express.Request, fallback = 30): { start: string; end: string; days: number } {
  const daysRaw = Number(req.query.days ?? fallback);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : fallback;
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days };
}

app.get("/api/stock/accuracy", (req, res) => {
  const { start, end, days } = parseDaysQuery(req, 30);
  const indexCode = (req.query.indexCode as string | undefined) ?? undefined;
  try {
    if (indexCode) {
      const meta = findIndexMeta(indexCode);
      if (!meta) {
        res.status(400).json({ error: "unsupported indexCode" });
        return;
      }
      res.json({ start, end, days, stats: [computeAccuracy(indexCode, start, end)] });
      return;
    }
    res.json({ start, end, days, stats: computeAllAccuracy(start, end) });
  } catch (e) {
    logStage({
      stage: "accuracy.failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "accuracy compute failed" });
  }
});

app.get("/api/stock/reviews", (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  const { start, end, days } = parseDaysQuery(req, 30);
  try {
    const rows = getReviewsInRange(indexCode, start, end);
    res.json({
      indexCode,
      indexName: meta.index_name,
      start,
      end,
      days,
      rows,
    });
  } catch (e) {
    logStage({
      stage: "reviews.failed",
      ok: false,
      indexCode,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "reviews query failed" });
  }
});

// ==================== P3：AI 预测准确率分析 ====================
//
// - GET /api/stock/analysis        明细：列出 [start, end] 区间内每条预测的 AI 分析。
// - POST /api/stock/analysis/refresh 手动触发最近 N 天的 AI 分析。

app.get("/api/stock/analysis", (req, res) => {
  const indexCode = String(req.query.indexCode ?? "");
  const meta = findIndexMeta(indexCode);
  if (!meta) {
    res.status(400).json({ error: "unsupported indexCode" });
    return;
  }
  const { start, end, days } = parseDaysQuery(req, 30);
  try {
    const rows = getAnalysesInRange(indexCode, start, end);
    res.json({
      indexCode,
      indexName: meta.index_name,
      start,
      end,
      days,
      rows,
    });
  } catch (e) {
    logStage({
      stage: "analysis.query_failed",
      ok: false,
      indexCode,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "analysis query failed" });
  }
});

app.post("/api/stock/analysis/refresh", async (req, res) => {
  const days = Number(req.body?.days ?? req.query?.days ?? 90);
  try {
    const result = await analyzeRecentPredictions(
      Number.isFinite(days) && days > 0 ? Math.min(365, days) : 90
    );
    res.json({ ok: true, analyzed: result.length });
  } catch (e) {
    logStage({
      stage: "analysis_refresh.failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "analysis refresh failed" });
  }
});

// ==================== 多信号面板（P1 数据可视化）====================
//
// 把后端入库的所有多信号数据都暴露给前端，纯只读 JSON。
// - GET /api/stock/signals      一次性返回 7 大类聚合数据
// - GET /api/stock/macro        宏观日历（近邻 / 自定义窗口）
// - GET /api/stock/external     外资代理（最新一日 + CNH 近 7 日序列）
// - GET /api/stock/futures      股指期货升贴水（最新一日）
// - POST /api/stock/signals/refresh 触发实时 ingest（macro 种子 / external / futures）

function daysAround(asOf: string, before: number, after: number): { start: string; end: string } {
  const d = new Date(asOf);
  const past = new Date(d);
  past.setUTCDate(past.getUTCDate() - before);
  const fwd = new Date(d);
  fwd.setUTCDate(fwd.getUTCDate() + after);
  return { start: past.toISOString().slice(0, 10), end: fwd.toISOString().slice(0, 10) };
}

interface SignalsPayload {
  asOfDate: string;
  macro: MacroCalendarRow[];
  external: {
    latest: ExternalProxyRow[];
    cnhRecent: ExternalProxyRow[];
  };
  futures: ReturnType<typeof getLatestFuturesBasis>;
  margin: ReturnType<typeof getMarginInRange>;
  breadth: ReturnType<typeof getBreadthInRange>;
  sector: ReturnType<typeof getLatestSectorRotation>;
  lhb: ReturnType<typeof getLhbActivity>;
  news: ReturnType<typeof getNewsByDate>;
}

app.get("/api/stock/signals", (_req, res) => {
  try {
    const sse = getLatestQuote("000001.SH");
    const asOfDate = sse?.trade_date ?? new Date().toISOString().slice(0, 10);

    // 宏观：近 7 天 / 后 5 天
    try {
      ensureRecentMacroSeed(asOfDate);
    } catch {
      /* 启发式种子失败不阻塞读取 */
    }
    const macroRange = daysAround(asOfDate, 7, 5);
    const macro = getMacroEventsInRange(macroRange.start, macroRange.end);

    // 外资：最新一日 + CNH 近 7 自然日序列
    const latest = getLatestExternalProxy();
    const cnhRange = daysAround(asOfDate, 7, 0);
    const cnhRecent = getExternalProxyInRange(cnhRange.start, cnhRange.end).filter(
      (r) => r.symbol === "CNH"
    );

    // 期货
    const futures = getLatestFuturesBasis();

    // 资金面：取近 30 自然日数据（保证含长假期 + 周末后仍有 >= 10 个交易日可看）
    // margin 是 T+1 数据，前端只展示尾部 7 条。
    const marginRange = daysAround(asOfDate, 30, 0);
    const margin = getMarginInRange(marginRange.start, marginRange.end);

    // 广度：近 10 自然日 → 拿到最近 5 个交易日
    const breadthRange = daysAround(asOfDate, 10, 0);
    const breadth = getBreadthInRange(breadthRange.start, breadthRange.end);

    // 板块（最近一日）
    const sector = getLatestSectorRotation();

    // 龙虎榜：先查 asOfDate，无数据则回退到数据库中最新有数据的交易日
    let lhb: ReturnType<typeof getLhbActivity> | null = null;
    try {
      lhb = getLhbActivity(asOfDate);
      if (lhb.total_count === 0) {
        const latestLhbDate = getLatestLhbDate();
        if (latestLhbDate && latestLhbDate !== asOfDate) {
          lhb = getLhbActivity(latestLhbDate);
        }
      }
    } catch {
      lhb = { trade_date: asOfDate, total_count: 0, net_buy_total: 0, net_sell_total: 0, top_3_by_net_amount: [] };
    }

    // 最近已分类新闻事件（不限日期，前 30 条）
    let news = getRecentNews(30);

    const payload: SignalsPayload = {
      asOfDate,
      macro,
      external: { latest, cnhRecent },
      futures,
      margin,
      breadth,
      sector,
      lhb: lhb ?? { trade_date: asOfDate, total_count: 0, net_buy_total: 0, net_sell_total: 0, top_3_by_net_amount: [] },
      news,
    };
    res.json(payload);
  } catch (e) {
    logStage({
      stage: "signals.failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "signals query failed" });
  }
});

app.get("/api/stock/macro", (req, res) => {
  const today = todayShanghai();
  const start = (req.query.start as string | undefined) ?? daysAround(today, 7, 0).start;
  const end = (req.query.end as string | undefined) ?? daysAround(today, 0, 14).end;
  try {
    try {
      ensureRecentMacroSeed(today);
    } catch {
      /* 启发式失败不阻塞 */
    }
    const rows = getMacroEventsInRange(start, end);
    res.json({ start, end, rows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/stock/external", (_req, res) => {
  try {
    const latest = getLatestExternalProxy();
    const asOf = latest[0]?.trade_date ?? new Date().toISOString().slice(0, 10);
    const range = daysAround(asOf, 7, 0);
    const cnhRecent = getExternalProxyInRange(range.start, range.end).filter(
      (r) => r.symbol === "CNH"
    );
    res.json({ asOfDate: asOf, latest, cnhRecent });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/stock/futures", (_req, res) => {
  try {
    const rows = getLatestFuturesBasis();
    res.json({ asOfDate: rows[0]?.trade_date ?? null, rows });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 实时触发采集：把"目前能拉到的数据"一次拉齐。返回采集结果以便前端 toast。
//
// 触发的维度：
// - quote     上证/创业板今日 OHLCV（决定面板 asOfDate）
// - breadth   涨跌平 + 涨停（sina hq.sinajs，分钟级实时）
// - sector    板块涨跌幅 Top/Bottom（东方财富 datacenter）
// - external  CNH / HSI / HSTECH / 510300 / 159915（sina + 腾讯，分钟级实时）
// - futures   IF / IH / IC / IM 升贴水（sina，分钟级实时）
// - lhb       龙虎榜（东方财富，T 日盘后 17:30+ 才有，盘中只能拿 T-1）
// - margin    两融余额（东方财富 datacenter，T+1，盘后 18:00+ 才有 T 日数据）
// - macro     启发式种子，不打远程
//
// 不在此处触发：news（LLM 分类，昂贵，走 cron）。
//
// 接受可选 query 参数 `lhbDate=YYYY-MM-DD` 覆盖龙虎榜目标日期。
// 默认行为：取数据库中最新有龙虎榜数据的交易日（而非今天，避免周末/节假日空跑）。
app.post("/api/stock/signals/refresh", async (req, res) => {
  const today = todayShanghai();
  const lhbDate = (req.query.lhbDate as string | undefined) || getLatestLhbDate() || today;
  const result: {
    quote?: Record<string, string | number | null>;
    breadth?: unknown;
    sector?: unknown;
    external?: unknown;
    futures?: unknown;
    lhb?: unknown;
    margin?: unknown;
    macro?: number;
  } = {};

  // quote：先拉，asOfDate 才能跟上。复用 ingestToday：内部会计算 change/change_pct 与
  // OHLCV 全字段一致地落库，避免重复维护 fetchDailyQuote → upsertQuote 这条路径。
  try {
    const rows = await ingestToday(undefined, today);
    result.quote = Object.fromEntries(
      rows.map((r) => [r.index_code, r.close_value ?? null])
    );
  } catch (e) {
    logStage({
      stage: "signals_refresh.quote_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 并发拉其余 5 类，失败各自 swallow
  const tasks: Array<Promise<void>> = [
    (async () => {
      try {
        result.breadth = await ingestMarketBreadth(today);
      } catch (e) {
        logStage({
          stage: "signals_refresh.breadth_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
    (async () => {
      try {
        result.sector = await ingestSectorRotation(today);
      } catch (e) {
        logStage({
          stage: "signals_refresh.sector_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
    (async () => {
      try {
        result.external = await ingestExternalProxies(today);
      } catch (e) {
        logStage({
          stage: "signals_refresh.external_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
    (async () => {
      try {
        result.futures = await ingestFuturesBasis(today);
      } catch (e) {
        logStage({
          stage: "signals_refresh.futures_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
    (async () => {
      try {
        result.lhb = await ingestLhb(lhbDate);
      } catch (e) {
        logStage({
          stage: "signals_refresh.lhb_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
    (async () => {
      try {
        result.margin = await ingestLatestMargin();
      } catch (e) {
        logStage({
          stage: "signals_refresh.margin_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })(),
  ];
  await Promise.allSettled(tasks);

  try {
    ensureRecentMacroSeed(today);
    result.macro = 1;
  } catch {
    result.macro = 0;
  }

  // 新闻：用户主动刷新时应触发采集（LLM 分类，可能较慢，不阻塞响应）
  // 新闻日期必须与行情日期对齐，避免行情未入库时新闻按今天分类导致面板查不到
  (async () => {
    try {
      const quoteDate = getLatestQuote("000001.SH")?.trade_date ?? today;
      await classifyTodayNews(quoteDate);
    } catch (e) {
      logStage({
        stage: "signals_refresh.news_failed",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  res.json({ ok: true, asOfDate: today, lhbDate, result });
});

app.post("/api/stock/reviews/refresh", (req, res) => {
  const days = Number(req.body?.days ?? req.query?.days ?? 90);
  try {
    const result = reviewRecentPredictions(Number.isFinite(days) && days > 0 ? Math.min(365, days) : 90);
    res.json({ ok: true, result });
  } catch (e) {
    logStage({
      stage: "reviews_refresh.failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "review refresh failed" });
  }
});

app.post("/api/stock/chat", async (req, res) => {
  const message = (req.body?.message as string | undefined)?.trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const parsed = parseStockRangeQuery(req, res);
  if (!parsed) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sseSend = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // 关键字判定：是否需要注入实时大盘上下文。未命中则不浪费 token。
  const isStockRelated = STOCK_KEYWORDS.some((kw) => message.includes(kw));
  const messages: BaseMessage[] = [];

  if (isStockRelated) {
    try {
      const inputs = await Promise.all(
        listTargetIndexes().map(async (meta) => {
          const rows = await fetchQuoteWindow(meta.index_code, parsed.range, {
            from: parsed.from,
            to: parsed.to,
          });
          const aggregated = rows.length > 90;
          return {
            indexCode: meta.index_code,
            indexName: meta.index_name,
            rows: aggregated ? aggregateForLlm(rows) : rows,
            aggregated,
          };
        })
      );
      const aggregated = inputs.some((i) => i.aggregated);
      const sysMsg = buildContextSystemMessage(
        inputs.map((i) => ({ indexCode: i.indexCode, indexName: i.indexName, rows: i.rows })),
        { rangeLabel: rangeLabel(parsed), aggregated }
      );
      messages.push(sysMsg);
    } catch (e) {
      logStage({
        stage: "realtime.context_failed",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      // 不阻塞问答：注入失败时退化为不带实时上下文，前端依然能拿到 LLM 回复
      sseSend({ content: "[提示] 实时数据暂时不可用，本次回答未包含最新行情。\n" });
    }
  }
  messages.push(new HumanMessage(message));

  try {
    const sessionId = (req.body?.thread_id as string | undefined) ?? "stock-default";
    const stream = await stockGraph.stream(
      { messages },
      { configurable: { thread_id: sessionId } }
    );

    let fullResponse = "";
    for await (const chunk of stream) {
      for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
        const outMsgs = (nodeOutput as { messages: BaseMessage[] }).messages;
        const lastMsg = outMsgs[outMsgs.length - 1];
        if (nodeName === "agent" && typeof lastMsg.content === "string" && lastMsg.content) {
          const text = lastMsg.content;
          if (text.length > fullResponse.length) {
            const delta = text.slice(fullResponse.length);
            fullResponse = text;
            sseSend({ content: delta });
          }
        }
      }
    }
    sseSend({ done: true });
    res.end();
  } catch (e) {
    logStage({
      stage: "stock_chat.failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    sseSend({ content: "抱歉，发生了错误，请稍后重试。" });
    sseSend({ done: true });
    res.end();
  }
});

// 测试钩子：把 Express app 暴露出去，避免在测试中 listen 端口。
export { app as _appForTest };

if (process.env.WEB_AGENT_NO_LISTEN !== "1") {
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`\n  🤖 智能体已启动`);
    console.log(`  📡 访问 http://localhost:${PORT}\n`);
  });
}
