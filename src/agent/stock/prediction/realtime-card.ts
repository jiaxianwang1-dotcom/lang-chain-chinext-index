import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { findIndexMeta } from "../providers/index.js";
import { todayShanghai } from "../realtime/index.js";
import {
  getPrediction,
  upsertPrediction,
  getLatestQuote,
  type IndexPredictionRow,
} from "../db/index.js";
import { logStage } from "../utils/log.js";
import {
  gatherMultiSignalContext,
  normalizeMultiSignalPrediction,
  PREDICT_MULTI_SIGNAL_SYSTEM,
  buildMultiSignalUserPrompt,
  safeParseMultiSignal,
  type MultiSignalPrediction,
} from "./index.js";

// ==================== 类型 ====================

export type CardTargetReason = "today" | "next_trading_day";

export interface CardTargetInfo {
  /** 预测目标交易日 YYYY-MM-DD */
  target: string;
  /** 命中原因：今日盘中 / 下一交易日 */
  reason: CardTargetReason;
  /** 帮助前端展示的说明文案 */
  label: string;
}

const MODEL_TAG = "moonshot-v1-32k";

// ==================== 时间 / 交易日工具 ====================

/** 上海时间是否早于 14:30。基于 UTC+8 推算，不依赖运行环境时区。 */
export function isBeforeAfternoonCutoff(now: Date = new Date()): boolean {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  return minutes < 14 * 60 + 30;
}

/** 简易"下一交易日"：在 YYYY-MM-DD 上加 1 天，遇到周六/周日继续跳过。不包含法定节假日。 */
export function nextTradingDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** 上海当天是否为工作日（不考虑法定节假日，仅过滤周末）。 */
function isWeekdayShanghai(now: Date = new Date()): boolean {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dow = shanghai.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * 决定卡片要展示哪一天的预测：
 * - 今日是周一~周五 且 上海时间 < 14:30 → 预测今日
 * - 否则 → 预测下一交易日
 */
export function decideCardTarget(
  isTodayTradingDay: boolean,
  now: Date = new Date()
): CardTargetInfo {
  const today = todayShanghai(now);
  if (isTodayTradingDay && isWeekdayShanghai(now) && isBeforeAfternoonCutoff(now)) {
    return { target: today, reason: "today", label: "预测今日涨跌幅" };
  }
  return {
    target: nextTradingDay(today),
    reason: "next_trading_day",
    label: "预测下一交易日涨跌幅",
  };
}

// ==================== LLM ====================

export type LlmInvokeFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: MODEL_TAG,
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

// ==================== 主入口（v2：多信号 10 维 + 区间）====================

export interface PredictCardOptions {
  /** 强制重算（默认 false：若 DB 已有则直接返回缓存）。*/
  force?: boolean;
  /** 喂给模型的窗口长度，默认 30 个交易日。*/
  windowDays?: number;
  /** 注入测试 LLM。*/
  llmInvoke?: LlmInvokeFn;
  /** 注入"现在"用于确定 today。*/
  now?: Date;
}

/**
 * 为 (indexCode, targetDate) 生成"方向 + 涨跌幅 + 区间"预测并落库。
 *
 * v2 改动（P0 修复）：
 *   - 接入与短信路径相同的 `gatherMultiSignalContext`（10 维度），不再仅用 OHLCV
 *   - 输出新增 predicted_change_pct_low / predicted_change_pct_high / magnitude_bucket
 *   - 数据来源沿用 stock_agent.db（cron 14:00 + 后续 P1 数据维度入库的结果）
 *
 * 缓存：若库中已存在 (index_code, target_date) 且未指定 force=true，直接返回缓存。
 */
export async function predictChangePctForTarget(
  indexCode: string,
  targetDate: string,
  opts: PredictCardOptions = {}
): Promise<IndexPredictionRow> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new RangeError(`unsupported indexCode: ${indexCode}`);

  if (!opts.force) {
    const cached = getPrediction(indexCode, targetDate);
    if (cached) {
      // 仅当缓存的 based_on_date 还是"最新已收盘交易日"时复用。
      // 否则说明：上次预测后 quote 表又有新一日数据入库（典型场景：
      // 当日上午 09:30 之前已生成了基于 T-1 的预测，下午 15:00 收盘后
      // 新的当日 quote 入库；此时 target 不变但 based_on 已陈旧）。
      const latestQuote = getLatestQuote(indexCode);
      const latestDate = latestQuote?.trade_date ?? null;
      if (!latestDate || (cached.based_on_date ?? "") >= latestDate) {
        return cached;
      }
      logStage({
        stage: "realtime_card.cache_stale",
        indexCode,
        target_date: targetDate,
        cached_based_on: cached.based_on_date,
        latest_quote_date: latestDate,
      });
      // fallthrough → 重算
    }
  }

  const windowDays = opts.windowDays ?? 30;
  // 用与短信路径完全一致的多信号上下文（DB-backed）
  const ctx = gatherMultiSignalContext(indexCode, windowDays);
  const userPromptBase = buildMultiSignalUserPrompt(ctx);
  const userPrompt = [
    `### 卡片预测附加说明`,
    `目标交易日: ${targetDate}（与上下文 asOfDate=${ctx.asOfDate} 可能不同；asOfDate 是"截至最新已收盘交易日"）。`,
    `请基于截至 ${ctx.asOfDate} 的 10 维数据，预测 ${targetDate} 的方向 + 涨跌幅区间。`,
    ``,
    userPromptBase,
  ].join("\n");

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(PREDICT_MULTI_SIGNAL_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "predict_card.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 调试：记录 LLM 原始输出，方便排查解析失败
  if (raw) {
    logStage({
      stage: "predict_card.llm_raw",
      indexCode,
      ok: true,
      raw_length: raw.length,
      raw_preview: raw.slice(0, 200),
    });
  }

  // 兜底
  const lastDay = ctx.recent30[ctx.recent30.length - 1];
  const lastPct = lastDay.change_pct ?? 0;
  const fallback: MultiSignalPrediction = {
    direction: lastPct >= 0 ? "up" : "down",
    confidence: 0.5,
    predicted_change_pct: lastPct >= 0 ? 0.3 : -0.3,
    predicted_change_pct_low: lastPct >= 0 ? -0.1 : -0.7,
    predicted_change_pct_high: lastPct >= 0 ? 0.7 : 0.1,
    magnitude_bucket: "small",
    rationale: "（兜底）LLM 不可用或解析失败，按最近一日方向给出弱信号。",
    signals: {
      trend: "missing",
      volume: "missing",
      fund_flow: "missing",
      breadth: "missing",
      sector: "missing",
      lhb: "missing",
      news: "missing",
      macro: "missing",
      external: "missing",
      futures: "missing",
    },
  };
  const parsed = raw ? safeParseMultiSignal(raw, fallback) : fallback;
  if (parsed === fallback && raw) {
    logStage({
      stage: "predict_card.parse_failed",
      indexCode,
      ok: false,
      raw_preview: raw.slice(0, 300),
    });
  }
  const norm = normalizeMultiSignalPrediction(parsed);

  const saved = upsertPrediction({
    index_code: indexCode,
    target_date: targetDate,
    predicted_change_pct: norm.predicted_change_pct ?? null,
    direction: norm.direction,
    confidence: norm.confidence,
    rationale: norm.rationale,
    model: MODEL_TAG + "+multi-signal-v2",
    based_on_date: ctx.asOfDate,
    predicted_at: new Date().toISOString(),
    predicted_change_pct_low: norm.predicted_change_pct_low ?? null,
    predicted_change_pct_high: norm.predicted_change_pct_high ?? null,
    magnitude_bucket: norm.magnitude_bucket ?? null,
    dimensions_used: ctx.dimensionsAvailable,
    signals_json: norm.signals ? JSON.stringify(norm.signals) : null,
  });

  logStage({
    stage: "predict_card.done",
    indexCode,
    target: targetDate,
    based_on: ctx.asOfDate,
    direction: saved.direction,
    pct: saved.predicted_change_pct,
    low: saved.predicted_change_pct_low,
    high: saved.predicted_change_pct_high,
    bucket: saved.magnitude_bucket,
    dimensions_used: saved.dimensions_used,
    ok: true,
  });

  return saved;
}
