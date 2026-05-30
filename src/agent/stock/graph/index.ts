import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import {
  HumanMessage,
  SystemMessage,
  isAIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph, START, END, MemorySaver, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { defaultProvider } from "../providers/index.js";
import { backfillOneYear, ingestToday } from "../providers/ingestion.js";
import type { QuoteRow } from "../realtime/index.js";
import { todayShanghai } from "../realtime/range.js";
import { ingestLatestMargin } from "../providers/margin.js";
import { ingestMarketBreadth } from "../providers/breadth.js";
import { ingestSectorRotation } from "../providers/sector.js";
import { ingestLhb } from "../providers/lhb.js";
import { ingestExternalProxies } from "../providers/external.js";
import { ingestFuturesBasis } from "../providers/futures.js";
import { ensureRecentMacroSeed } from "../providers/macro.js";
import { classifyTodayNews } from "../news/index.js";
import { analyzeChangeReason, backfillReasons } from "../analysis/index.js";
import {
  bootstrapPredictionMemory,
  predictAllTargets,
  predictNextTradingDay,
} from "../prediction/index.js";
import { reviewRecentPredictions } from "../review/index.js";
import { buildNotifier, type SmsNotifier } from "../notify/index.js";
import { logStage, timed } from "../utils/log.js";

// ==================== Tools ====================

const fetchAndIngestToday = tool(
  async () => {
    const rows = await ingestToday(defaultProvider);
    return JSON.stringify(rows.map((r) => ({ index_code: r.index_code, trade_date: r.trade_date, close: r.close_value, change_pct: r.change_pct })));
  },
  {
    name: "fetch_and_ingest_today",
    description: "拉取上证指数和创业板指当日实时点位，并 upsert 入库。返回入库的行（非交易日返回空数组）。",
    schema: z.object({}),
  }
);

const backfillOneYearTool = tool(
  async () => JSON.stringify(await backfillOneYear(defaultProvider)),
  {
    name: "backfill_one_year",
    description: "首次回填两个目标指数近 1 年的日线数据。",
    schema: z.object({}),
  }
);

const analyzeChangeReasonTool = tool(
  async ({ index_code, trade_date }) => {
    const r = await analyzeChangeReason(index_code, trade_date);
    return JSON.stringify(r);
  },
  {
    name: "analyze_change_reason",
    description: "针对指定指数 + 交易日，调用搜索 + LLM 分析涨跌原因并写回数据库。",
    schema: z.object({
      index_code: z.string().describe("如 000001.SH 或 399006.SZ"),
      trade_date: z.string().describe("YYYY-MM-DD"),
    }),
  }
);

const backfillReasonsTool = tool(
  async () => JSON.stringify(await backfillReasons()),
  {
    name: "backfill_reasons",
    description: "对所有 change_reason 缺失的记录批量补齐归因。",
    schema: z.object({}),
  }
);

const bootstrapMemoryTool = tool(
  async ({ index_code }) => {
    const m = await bootstrapPredictionMemory(index_code);
    return JSON.stringify({ version: m.version, as_of_date: m.as_of_date });
  },
  {
    name: "bootstrap_prediction_memory",
    description: "对指定指数生成 version=1 的长期分析记忆（仅在首次运行使用）。",
    schema: z.object({ index_code: z.string() }),
  }
);

const predictNextTool = tool(
  async ({ index_code }) => JSON.stringify(await predictNextTradingDay(index_code)),
  {
    name: "predict_next_trading_day",
    description: "基于上一份长期记忆 + 增量行情，预测下一交易日方向（买涨/买跌）。",
    schema: z.object({ index_code: z.string() }),
  }
);

const predictAllTool = tool(
  async () => JSON.stringify(await predictAllTargets()),
  {
    name: "predict_all_targets",
    description: "对所有目标指数依次预测下一交易日方向。",
    schema: z.object({}),
  }
);

const sendPredictionSmsTool = tool(
  async ({ dry_run }) => {
    const predictions = await predictAllTargets();
    const notifier = buildNotifier({ dryRun: dry_run ?? false });
    await notifier.sendPredictionSms(predictions);
    return JSON.stringify({ ok: true, count: predictions.length });
  },
  {
    name: "send_prediction_sms",
    description: "对所有目标指数预测后通过短信通知用户。dry_run=true 时只打印不真正发送。",
    schema: z.object({ dry_run: z.boolean().optional() }),
  }
);

export const stockTools = [
  fetchAndIngestToday,
  backfillOneYearTool,
  analyzeChangeReasonTool,
  backfillReasonsTool,
  bootstrapMemoryTool,
  predictNextTool,
  predictAllTool,
  sendPredictionSmsTool,
];

// ==================== Graph ====================

const StockState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const SYSTEM_PROMPT = `你是 A 股大盘指数行情智能体，专门负责跟踪上证指数（000001.SH）与创业板指（399006.SZ）。

工作流程通常是：
1) fetch_and_ingest_today 拉当日行情
2) analyze_change_reason 给两个指数补充原因
3) predict_all_targets 输出下一交易日方向
4) send_prediction_sms 通知用户

如果用户只问行情或原因，直接调用对应工具即可，不必跑全流程。
所有结论结尾要附"仅供参考，非投资建议"。`;

let _llm: ChatOpenAI | null = null;
function getLlm(): ChatOpenAI {
  if (_llm) return _llm;
  _llm = new ChatOpenAI({
    model: process.env.KIMI_MODEL ?? "kimi-k2.6",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1" },
    temperature: 1,
  });
  return _llm;
}

async function agentNode(state: typeof StockState.State) {
  const llmWithTools = getLlm().bindTools(stockTools);
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT), ...state.messages];
  const response = await llmWithTools.invoke(messages);
  return { messages: [response] };
}

const toolNode = new ToolNode(stockTools);

function shouldContinue(state: typeof StockState.State) {
  const last = state.messages[state.messages.length - 1];
  if (isAIMessage(last) && last.tool_calls?.length) return "tools";
  return END;
}

const workflow = new StateGraph(StockState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
export const stockGraph = workflow.compile({ checkpointer });

// ==================== 实时上下文注入 ====================
//
// `stockGraph` 本身不读 SQLite。Web 入口（/api/stock/chat）在调用前用
// realtime-quote-service 拉好窗口数据，再用本函数生成一条 SystemMessage 注入；
// 这样问答路径完全不依赖 cron 入库时延，符合需求文档 docs/requirement/11.md。

export interface RealtimeContextInput {
  indexCode: string;
  indexName?: string;
  rows: QuoteRow[];
}

export interface BuildContextOptions {
  /** 时间范围的人类可读描述，例如 "近 30 天" / "2026-01-01 ~ 2026-05-11"。仅用于 prompt 头说明。 */
  rangeLabel?: string;
  /** 是否经过 aggregateForLlm 聚合；若是，prompt 头会注明"以下为周聚合数据"。 */
  aggregated?: boolean;
}

/**
 * 构造一条供 LLM 使用的 system 消息，把多个指数的实时窗口数据序列化为 JSON。
 * 字段名与 db.IndexQuoteRow 完全一致 → 智能体可以沿用既有 prompt 与表达习惯，
 * 上层不必重写任何工具。
 */
export function buildContextSystemMessage(
  inputs: RealtimeContextInput[],
  opts: BuildContextOptions = {}
): SystemMessage {
  const header: string[] = [];
  header.push("以下为实时盘中数据（非来自 SQLite，可能与 14:00 收盘后归因不一致）。");
  if (opts.rangeLabel) header.push(`时间窗口：${opts.rangeLabel}。`);
  if (opts.aggregated) header.push("注：窗口超过 90 个交易日，已按 5 个交易日做周聚合。");
  header.push("字段口径与 index_quotes 表一致（trade_date / open_value / high_value / low_value / close_value / volume / turnover / change / change_pct）。");

  if (inputs.length === 0 || inputs.every((i) => i.rows.length === 0)) {
    return new SystemMessage(`${header.join(" ")}\n（实时数据暂时不可用，请基于通用知识谨慎回答，并提示用户稍后重试。）`);
  }

  const blocks = inputs.map((i) => {
    const name = i.indexName ?? i.rows[0]?.index_name ?? i.indexCode;
    const json = JSON.stringify(i.rows);
    return `# ${name} (${i.indexCode}) 共 ${i.rows.length} 行\n${json}`;
  });

  return new SystemMessage(`${header.join(" ")}\n\n${blocks.join("\n\n")}`);
}

// ==================== runOnce / runSnapshot（直接函数调用，不走 LLM 决策）====================

export interface RunOnceOptions {
  dryRun?: boolean;
  notifier?: SmsNotifier;
}

/**
 * 安全包装：把任一外部数据源失败转成日志，不阻塞 runOnce 主流程。
 * 这是多信号架构的核心 fail-safe 约束。
 */
async function safeStep<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    logStage({
      stage: `runOnce.${label}_failed`,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * 收盘前盘中快照：仅拉行情+多维度数据，不预测不发通知。
 * 用于 14:40 等盘中时刻记录实时点位，收盘后 runOnce 再覆盖为收盘价。
 */
export async function runSnapshot(opts: RunOnceOptions = {}): Promise<void> {
  // 1) 主行情入库（必需）
  const ingested = await timed("ingest_quote_snapshot", undefined, () => ingestToday(defaultProvider));
  const today = todayShanghai();

  if (ingested.length === 0) {
    logStage({ stage: "runSnapshot.skip_non_trading", ok: true, today });
    return;
  }
  const tradeDate = ingested[0].trade_date;

  // 2) 各指数原因分析（盘中快照也做，供后续查看）
  for (const row of ingested) {
    await safeStep(`analyze_${row.index_code}`, () =>
      analyzeChangeReason(row.index_code, row.trade_date)
    );
  }

  // 3) 多维度数据采集（全部 fail-safe）
  await safeStep("ingest_margin", () => ingestLatestMargin());
  await safeStep("ingest_breadth", () => ingestMarketBreadth(tradeDate));
  await safeStep("ingest_sector", () => ingestSectorRotation(tradeDate));
  await safeStep("ingest_lhb", () => ingestLhb(tradeDate));
  await safeStep("classify_news", () => classifyTodayNews(today, { force: true }));
  await safeStep("ingest_external", () => ingestExternalProxies(tradeDate));
  await safeStep("ingest_futures", () => ingestFuturesBasis(tradeDate));
  await safeStep("seed_macro", async () => {
    ensureRecentMacroSeed(tradeDate);
  });

  logStage({ stage: "runSnapshot.done", ok: true, tradeDate, indices: ingested.map((r) => r.index_code) });
}

export async function runOnce(opts: RunOnceOptions = {}): Promise<void> {
  // 1) 主行情入库（必需，失败即跳过非交易日）
  const ingested = await timed("ingest_quote", undefined, () => ingestToday(defaultProvider));
  const today = todayShanghai();

  if (ingested.length === 0) {
    // 非交易日：行情没有更新，但新闻是实时的，不受交易日限制
    logStage({ stage: "runOnce.skip_non_trading", ok: true });
    await safeStep("classify_news", () => classifyTodayNews(today, { force: true }));
    return;
  }
  const tradeDate = ingested[0].trade_date;

  // 2) 各指数原因分析（保留原行为）
  for (const row of ingested) {
    await safeStep(`analyze_${row.index_code}`, () =>
      analyzeChangeReason(row.index_code, row.trade_date)
    );
  }

  // 3-10) 多维度数据采集，全部 fail-safe（任一失败仅记日志，不阻塞预测）
  await safeStep("ingest_margin", () => ingestLatestMargin());
  await safeStep("ingest_breadth", () => ingestMarketBreadth(tradeDate));
  await safeStep("ingest_sector", () => ingestSectorRotation(tradeDate));
  await safeStep("ingest_lhb", () => ingestLhb(tradeDate));
  // 新闻用 today：交易日 today===tradeDate，语义一致；非交易日上面已处理
  await safeStep("classify_news", () => classifyTodayNews(today, { force: true }));
  // P1：新维度
  await safeStep("ingest_external", () => ingestExternalProxies(tradeDate));
  await safeStep("ingest_futures", () => ingestFuturesBasis(tradeDate));
  await safeStep("seed_macro", async () => {
    ensureRecentMacroSeed(tradeDate);
  });

  // P2：盘后回顾（先于本轮预测：用今日实际行情比对"上轮 / 上几轮"对今日的预测）
  await safeStep("review_predictions", async () => {
    reviewRecentPredictions(90);
  });

  // 11) 预测（自动多信号）
  const predictions = await timed("predict", undefined, () => predictAllTargets());

  // 12) 短信通知
  const notifier = opts.notifier ?? buildNotifier({ dryRun: opts.dryRun });
  await timed("notify", undefined, () => notifier.sendPredictionSms(predictions));
}
