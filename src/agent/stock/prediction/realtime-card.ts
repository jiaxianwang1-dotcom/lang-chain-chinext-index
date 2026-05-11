import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { findIndexMeta } from "../providers/index.js";
import { fetchQuoteWindow, todayShanghai, type QuoteRow } from "../realtime/index.js";
import {
  getPrediction,
  upsertPrediction,
  type IndexPredictionRow,
} from "../db/index.js";
import { logStage } from "../utils/log.js";

// ==================== 类型 & Schema ====================

const PredictPctSchema = z.object({
  direction: z.enum(["up", "down"]),
  confidence: z.number().min(0).max(1),
  predicted_change_pct: z.number().min(-20).max(20),
  rationale: z.string().min(1),
});

type PredictPct = z.infer<typeof PredictPctSchema>;

export type CardTargetReason = "today" | "next_trading_day";

export interface CardTargetInfo {
  /** 预测目标交易日 YYYY-MM-DD */
  target: string;
  /** 命中原因：今日盘中 / 下一交易日 */
  reason: CardTargetReason;
  /** 帮助前端展示的说明文案 */
  label: string;
}

const MODEL_TAG = "glm-4-flash";

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
 *
 * 注意：法定节假日不在这里特殊处理；调用方（API 层）会用 `isTradingDayHeuristic`
 * 做更精细的判定，若节假日就会切换为下一交易日预测。
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
    apiKey: process.env.ZHIPU_API_KEY,
    configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
    temperature: 0.2,
  });
  return _defaultLlm;
}

async function defaultInvokeLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  const llm = getDefaultLlm();
  const res = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

const PREDICT_PCT_SYSTEM = `你是 A 股大盘短线方向 + 涨跌幅判断助手。
输入：某只指数最近若干个交易日的真实日线（OHLCV + 涨跌幅）。
任务：基于这些数据，预测**目标交易日**该指数的"收盘相对前一交易日收盘"的涨跌幅（单位：%）。

硬性纪律：
- 你只能引用上面表格里**实际出现**的数字，禁止编造表格中没有的字段。
- 必须给出方向（up=买涨 / down=买跌），不允许中立。
- 涨跌幅是带符号的小数：例如 +1.50 表示预测上涨 1.5%，-0.80 表示预测下跌 0.8%。
- 涨跌幅与方向必须一致：direction=up 时 predicted_change_pct > 0；direction=down 时 < 0。
- A 股指数单日波动通常在 -5% ~ +5% 之间，超过 ±3% 的预测必须有非常明确的近端信号。

输出严格 JSON：
{"direction":"up","confidence":0.62,"predicted_change_pct":0.85,"rationale":"≤120 字中文，必须引用 1-2 个具体收盘点位或涨跌幅"}

不要 Markdown，不要解释字段。`;

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

function fmtVolume(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "万亿手";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return Math.round(v).toString() + "手";
}

function formatRowsAsTable(rows: QuoteRow[]): string {
  const header = "date\topen\thigh\tlow\tclose\tchg%\tvolume";
  const body = rows
    .map((r) =>
      [
        r.trade_date,
        fmtNum(r.open_value),
        fmtNum(r.high_value),
        fmtNum(r.low_value),
        fmtNum(r.close_value),
        r.change_pct == null ? "-" : (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%",
        fmtVolume(r.volume),
      ].join("\t")
    )
    .join("\n");
  return `${header}\n${body}`;
}

function safeParseJson<T>(raw: string, schema: z.ZodSchema<T>): T | null {
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
  return null;
}

// ==================== 主入口 ====================

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
 * 为 (indexCode, targetDate) 生成"涨跌幅"预测并落库。如果库中已存在记录且未指定
 * force=true，则直接返回缓存；否则调用 LLM 重新预测。
 *
 * 数据来源：实时窗口数据（fetchQuoteWindow），不依赖 cron 入库。这与需求文档
 * docs/requirement/11.md 保持一致：智能体路径全部实时拉取。
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
    if (cached) return cached;
  }

  const windowDays = opts.windowDays ?? 30;
  // 用实时接口拉一段窗口（end 至今日；30 天预设涵盖 30 自然日，足够 LLM 看 ~20 个交易日）
  const rows = await fetchQuoteWindow(indexCode, windowDays <= 30 ? "1m" : "2m", {
    now: opts.now,
  });
  if (rows.length === 0) {
    throw new Error(`${indexCode} 实时数据为空，无法预测`);
  }
  const basedOn = rows[rows.length - 1].trade_date;

  const userPrompt = [
    `指数: ${meta.index_name} (${meta.index_code})`,
    `目标交易日: ${targetDate}`,
    `历史窗口: ${rows[0].trade_date} ~ ${basedOn}, 共 ${rows.length} 个交易日`,
    `近 ${rows.length} 日行情明细：`,
    formatRowsAsTable(rows),
    ``,
    `请基于上述真实日线，预测 ${targetDate} 该指数的涨跌幅（相对前一交易日收盘的百分比）。`,
  ].join("\n");

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(PREDICT_PCT_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "predict_card.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const parsed: PredictPct | null = raw ? safeParseJson(raw, PredictPctSchema) : null;

  // 兜底：用最近一日方向给一个保守的小幅预测，避免界面长期 "--"
  const last = rows[rows.length - 1];
  const fallback: PredictPct = parsed ?? {
    direction: last.change_pct != null && last.change_pct >= 0 ? "up" : "down",
    confidence: 0.5,
    predicted_change_pct: last.change_pct != null && last.change_pct >= 0 ? 0.3 : -0.3,
    rationale: "（兜底）LLM 不可用或解析失败，按最近一日方向给出弱信号。",
  };

  // direction 与 sign 不一致时校正（防御）
  if (fallback.direction === "up" && fallback.predicted_change_pct < 0) {
    fallback.predicted_change_pct = Math.abs(fallback.predicted_change_pct);
  } else if (fallback.direction === "down" && fallback.predicted_change_pct > 0) {
    fallback.predicted_change_pct = -Math.abs(fallback.predicted_change_pct);
  }

  const saved = upsertPrediction({
    index_code: indexCode,
    target_date: targetDate,
    predicted_change_pct: fallback.predicted_change_pct,
    direction: fallback.direction,
    confidence: fallback.confidence,
    rationale: fallback.rationale,
    model: MODEL_TAG,
    based_on_date: basedOn,
    predicted_at: new Date().toISOString(),
  });

  logStage({
    stage: "predict_card.done",
    indexCode,
    target: targetDate,
    based_on: basedOn,
    direction: saved.direction,
    pct: saved.predicted_change_pct,
    ok: true,
  });

  return saved;
}
