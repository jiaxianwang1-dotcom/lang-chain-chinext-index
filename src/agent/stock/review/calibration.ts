/**
 * 置信度校准（Confidence Calibration）。
 *
 * 问题：LLM 输出的 confidence 是"自我感知"概率，往往不校准。
 * 例如 LLM 说 0.80，实际命中率可能只有 0.60。
 *
 * 解决方案：基于历史 review 数据，按 confidence 分桶计算实际命中率，
 * 建立映射函数，把 raw confidence 映射到 calibrated probability。
 */

import { getReviewsInRange, type PredictionReviewRow } from "../db/index.js";
import { listTargetIndexes } from "../providers/index.js";

interface CalibrationBucket {
  binLow: number;
  binHigh: number;
  rawConfidenceMean: number;
  actualHitRate: number;
  count: number;
}

/** 默认分桶边界 */
const DEFAULT_BINS = [0.48, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.0];

function buildBuckets(
  rows: PredictionReviewRow[],
  bins = DEFAULT_BINS
): CalibrationBucket[] {
  const sorted = [...bins].sort((a, b) => a - b);
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const low = sorted[i];
    const high = sorted[i + 1];
    const binRows = rows.filter(
      (r) =>
        r.confidence != null &&
        r.confidence >= low &&
        r.confidence < high &&
        r.direction_hit != null
    );
    if (binRows.length === 0) {
      buckets.push({
        binLow: low,
        binHigh: high,
        rawConfidenceMean: (low + high) / 2,
        actualHitRate: (low + high) / 2,
        count: 0,
      });
      continue;
    }
    const hits = binRows.filter((r) => r.direction_hit === 1).length;
    const meanConf =
      binRows.reduce((sum, r) => sum + (r.confidence ?? 0), 0) / binRows.length;
    buckets.push({
      binLow: low,
      binHigh: high,
      rawConfidenceMean: meanConf,
      actualHitRate: hits / binRows.length,
      count: binRows.length,
    });
  }
  return buckets;
}

/**
 * 简单平滑：用相邻桶的加权平均填充空桶，减少过拟合。
 */
function smoothBuckets(buckets: CalibrationBucket[]): CalibrationBucket[] {
  const out = buckets.map((b) => ({ ...b }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].count === 0) {
      // 找最近的非空桶
      let left = i - 1;
      let right = i + 1;
      while (left >= 0 && out[left].count === 0) left--;
      while (right < out.length && out[right].count === 0) right++;
      const leftRate = left >= 0 ? out[left].actualHitRate : out[i].rawConfidenceMean;
      const rightRate = right < out.length ? out[right].actualHitRate : out[i].rawConfidenceMean;
      const leftDist = left >= 0 ? i - left : Infinity;
      const rightDist = right < out.length ? right - i : Infinity;
      const totalDist = leftDist + rightDist;
      if (totalDist > 0 && totalDist !== Infinity) {
        out[i].actualHitRate =
          (leftRate * (rightDist / totalDist) + rightRate * (leftDist / totalDist));
      } else {
        out[i].actualHitRate = out[i].rawConfidenceMean;
      }
    }
  }
  return out;
}

/** 缓存：同一天内多次校准查询复用结果 */
let _cachedCurve: { date: string; buckets: CalibrationBucket[] } | null = null;

function getCalibrationCurve(): CalibrationBucket[] {
  const today = new Date().toISOString().slice(0, 10);
  if (_cachedCurve && _cachedCurve.date === today) {
    return _cachedCurve.buckets;
  }

  // 拉取所有指数最近 180 天的 review 数据
  const end = today;
  const start = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 180);
    return d.toISOString().slice(0, 10);
  })();

  let allRows: PredictionReviewRow[] = [];
  for (const meta of listTargetIndexes()) {
    allRows = allRows.concat(getReviewsInRange(meta.index_code, start, end));
  }

  // 过滤掉 hold 方向的记录（hold 不统计方向命中率，不用于校准）
  const validRows = allRows.filter(
    (r) => r.predicted_direction === "up" || r.predicted_direction === "down"
  );

  if (validRows.length < 20) {
    // 数据不足，不做校准，返回恒等映射
    const identity = DEFAULT_BINS.slice(0, -1).map((low, i) => ({
      binLow: low,
      binHigh: DEFAULT_BINS[i + 1],
      rawConfidenceMean: (low + DEFAULT_BINS[i + 1]) / 2,
      actualHitRate: (low + DEFAULT_BINS[i + 1]) / 2,
      count: 0,
    }));
    _cachedCurve = { date: today, buckets: identity };
    return identity;
  }

  const buckets = smoothBuckets(buildBuckets(validRows));
  _cachedCurve = { date: today, buckets };
  return buckets;
}

/**
 * 把 LLM 输出的 raw confidence 映射到校准后的概率。
 *
 * 原理：在历史数据中，找到 raw confidence 所在的分桶，
 * 返回该桶的实际命中率。跨桶时做线性插值。
 */
export function calibrateConfidence(rawConfidence: number): number {
  const buckets = getCalibrationCurve();
  // 找到所在桶
  let bucket = buckets.find(
    (b) => rawConfidence >= b.binLow && rawConfidence < b.binHigh
  );
  if (!bucket) {
    // 落在最后一个桶或超出范围
    if (rawConfidence >= buckets[buckets.length - 1].binHigh) {
      return buckets[buckets.length - 1].actualHitRate;
    }
    if (rawConfidence < buckets[0].binLow) {
      return buckets[0].actualHitRate;
    }
    bucket = buckets[buckets.length - 1];
  }

  // 线性插值：用相邻桶的 actualHitRate 插值
  const idx = buckets.indexOf(bucket);
  if (idx < 0) return rawConfidence;

  const next = buckets[idx + 1];
  const prev = buckets[idx - 1];

  // 如果当前桶有足够数据（count > 10），优先用当前桶的实际命中率
  if (bucket.count >= 10) {
    return Number(bucket.actualHitRate.toFixed(3));
  }

  // 否则做简单线性插值（当前桶中心 vs 相邻桶）
  const center = (bucket.binLow + bucket.binHigh) / 2;
  if (rawConfidence >= center && next) {
    const t = (rawConfidence - center) / (bucket.binHigh - center);
    return Number((bucket.actualHitRate + t * (next.actualHitRate - bucket.actualHitRate)).toFixed(3));
  }
  if (rawConfidence < center && prev) {
    const t = (center - rawConfidence) / (center - bucket.binLow);
    return Number((bucket.actualHitRate + t * (prev.actualHitRate - bucket.actualHitRate)).toFixed(3));
  }

  return Number(bucket.actualHitRate.toFixed(3));
}

/**
 * 获取校准统计摘要（用于调试和报表）。
 */
export function getCalibrationSummary(): {
  buckets: Array<{
    range: string;
    rawMean: string;
    actualHitRate: string;
    count: number;
  }>;
  totalSamples: number;
} {
  const buckets = getCalibrationCurve();
  return {
    buckets: buckets.map((b) => ({
      range: `${b.binLow.toFixed(2)}-${b.binHigh.toFixed(2)}`,
      rawMean: b.rawConfidenceMean.toFixed(3),
      actualHitRate: b.actualHitRate.toFixed(3),
      count: b.count,
    })),
    totalSamples: buckets.reduce((sum, b) => sum + b.count, 0),
  };
}
