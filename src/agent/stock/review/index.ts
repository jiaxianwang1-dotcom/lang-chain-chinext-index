import {
  getPredictionsInRange,
  getQuotesInRange,
  getReviewsInRange,
  upsertReview,
  type IndexPredictionRow,
  type PredictionReviewRow,
} from "../db/index.js";
import { findIndexMeta, listTargetIndexes } from "../providers/index.js";
import { logStage } from "../utils/log.js";
import { analyzePredictionsForIndex, type AnalyzeOptions } from "./analysis.js";

/**
 * 预测回顾（P2-6 实现）。
 *
 * 工作原理：找到所有 (index_code, target_date) 已经"发生过"的预测（target_date ≤ today），
 * 拉对应的真实行情，计算：
 *   - actual_pct = change_pct（来自 index_quotes）
 *   - direction_hit = sign(predicted) === sign(actual) ? 1 : 0
 *   - range_hit = (low ≤ actual ≤ high) ? 1 : 0 （low/high 缺失时填 NULL）
 *   - pct_abs_error = |predicted - actual|
 *
 * 幂等：每次都重新覆盖（actual 不会变化，但 predicted 字段升级时可吸收）。
 * 失败兜底：单条出错记 warn，不阻塞其他记录。
 */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function buildReviewRow(
  pred: IndexPredictionRow,
  actualPct: number | null
): PredictionReviewRow {
  const predPct = pred.predicted_change_pct;
  const predDir = pred.direction;
  const predLow = pred.predicted_change_pct_low ?? null;
  const predHigh = pred.predicted_change_pct_high ?? null;

  let actualDir: "up" | "down" | null = null;
  if (isFiniteNumber(actualPct)) actualDir = actualPct >= 0 ? "up" : "down";

  let directionHit: 0 | 1 | null = null;
  if (predDir && actualDir) directionHit = predDir === actualDir ? 1 : 0;

  let rangeHit: 0 | 1 | null = null;
  if (
    isFiniteNumber(actualPct) &&
    isFiniteNumber(predLow) &&
    isFiniteNumber(predHigh)
  ) {
    rangeHit = actualPct >= predLow && actualPct <= predHigh ? 1 : 0;
  }

  let pctAbsError: number | null = null;
  if (isFiniteNumber(predPct) && isFiniteNumber(actualPct)) {
    pctAbsError = Math.abs(predPct - actualPct);
  }

  return {
    index_code: pred.index_code,
    target_date: pred.target_date,
    predicted_pct: isFiniteNumber(predPct) ? predPct : null,
    predicted_direction: predDir,
    predicted_low: predLow,
    predicted_high: predHigh,
    confidence: pred.confidence,
    actual_pct: isFiniteNumber(actualPct) ? actualPct : null,
    actual_direction: actualDir,
    direction_hit: directionHit,
    range_hit: rangeHit,
    pct_abs_error: pctAbsError,
    reviewed_at: new Date().toISOString(),
  };
}

export interface ReviewBuildResult {
  index_code: string;
  reviewed: number;
  skipped_no_actual: number;
  direction_hits: number;
  mean_abs_error: number | null;
}

/**
 * 回顾 [start, end] 之间已发生的预测。end 默认为今日（包含）。
 */
export function reviewPredictionsForIndex(
  indexCode: string,
  start: string,
  end?: string
): ReviewBuildResult {
  const endDate = end ?? new Date().toISOString().slice(0, 10);
  const preds = getPredictionsInRange(indexCode, start, endDate);

  // 拉同区间真实行情
  const quotes = getQuotesInRange(indexCode, start, endDate);
  const quoteByDate = new Map(quotes.map((q) => [q.trade_date, q]));

  let reviewed = 0;
  let skipped = 0;
  let dirHits = 0;
  const errors: number[] = [];
  for (const p of preds) {
    const actualQuote = quoteByDate.get(p.target_date);
    if (!actualQuote || actualQuote.change_pct == null) {
      skipped += 1;
      continue;
    }
    const row = buildReviewRow(p, actualQuote.change_pct);
    try {
      upsertReview(row);
      reviewed += 1;
      if (row.direction_hit === 1) dirHits += 1;
      if (row.pct_abs_error != null) errors.push(row.pct_abs_error);
    } catch (e) {
      logStage({
        stage: "review.upsert_failed",
        ok: false,
        indexCode,
        target_date: p.target_date,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const mae =
    errors.length === 0 ? null : errors.reduce((a, b) => a + b, 0) / errors.length;
  const result: ReviewBuildResult = {
    index_code: indexCode,
    reviewed,
    skipped_no_actual: skipped,
    direction_hits: dirHits,
    mean_abs_error: mae == null ? null : Number(mae.toFixed(3)),
  };
  logStage({ stage: "review.done", ok: true, ...result, start, end: endDate });
  return result;
}

/**
 * 回顾所有目标指数最近 N 天的预测，默认 90 天。
 * 回顾完成后自动触发 AI 准确率分析（不阻塞返回）。
 */
export function reviewRecentPredictions(days = 90, opts?: { analyze?: boolean; analyzeOpts?: AnalyzeOptions }): ReviewBuildResult[] {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const out: ReviewBuildResult[] = [];
  for (const meta of listTargetIndexes()) {
    out.push(reviewPredictionsForIndex(meta.index_code, startStr, endStr));
  }

  // 自动触发 AI 分析（fire-and-forget，不阻塞 review 返回）
  if (opts?.analyze !== false) {
    const analyzeOpts = opts?.analyzeOpts;
    (async () => {
      try {
        for (const meta of listTargetIndexes()) {
          await analyzePredictionsForIndex(meta.index_code, startStr, endStr, analyzeOpts);
        }
      } catch (e) {
        logStage({
          stage: "review.auto_analysis_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }

  return out;
}

/**
 * 计算累计统计：方向准确率 / MAE / 区间命中率，按指数分组。
 */
export interface AccuracyStat {
  index_code: string;
  index_name?: string;
  total: number;
  direction_hits: number;
  direction_accuracy: number | null;
  range_hits: number;
  range_total: number;
  range_accuracy: number | null;
  mean_abs_error: number | null;
}

export function computeAccuracy(
  indexCode: string,
  start: string,
  end: string
): AccuracyStat {
  const rows = getReviewsInRange(indexCode, start, end);
  const meta = findIndexMeta(indexCode);
  const total = rows.length;
  const dirHits = rows.filter((r) => r.direction_hit === 1).length;
  const rangeRows = rows.filter((r) => r.range_hit != null);
  const rangeHits = rangeRows.filter((r) => r.range_hit === 1).length;
  const errs = rows
    .map((r) => r.pct_abs_error)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const mae = errs.length === 0 ? null : errs.reduce((a, b) => a + b, 0) / errs.length;
  return {
    index_code: indexCode,
    index_name: meta?.index_name,
    total,
    direction_hits: dirHits,
    direction_accuracy: total === 0 ? null : Number((dirHits / total).toFixed(3)),
    range_hits: rangeHits,
    range_total: rangeRows.length,
    range_accuracy:
      rangeRows.length === 0 ? null : Number((rangeHits / rangeRows.length).toFixed(3)),
    mean_abs_error: mae == null ? null : Number(mae.toFixed(3)),
  };
}

export function computeAllAccuracy(start: string, end: string): AccuracyStat[] {
  return listTargetIndexes().map((m) => computeAccuracy(m.index_code, start, end));
}
