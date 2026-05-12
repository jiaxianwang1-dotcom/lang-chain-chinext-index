import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import {
  _setDbForTest,
  openDbForTest,
  upsertQuote,
  upsertPrediction,
  getReview,
} from "../db/index.js";
import {
  reviewPredictionsForIndex,
  computeAccuracy,
} from "../review/index.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `stock-review-${Date.now()}-${Math.random()}.db`);
  db = openDbForTest(dbPath);
  _setDbForTest(db);
});

afterEach(() => {
  db.close();
  _setDbForTest(null);
  try {
    rmSync(dbPath);
  } catch {}
});

function seedQuote(code: string, date: string, close: number, prevClose: number) {
  const change = close - prevClose;
  const pct = (change / prevClose) * 100;
  upsertQuote({
    index_code: code,
    index_name: "测试指数",
    trade_date: date,
    close_value: close,
    change,
    change_pct: pct,
  });
}

describe("prediction_review", () => {
  it("方向命中：预测 up + 实际 up → direction_hit = 1", () => {
    seedQuote("000001.SH", "2026-05-08", 3400, 3380);
    seedQuote("000001.SH", "2026-05-09", 3420, 3400); // +0.59%
    upsertPrediction({
      index_code: "000001.SH",
      target_date: "2026-05-09",
      predicted_change_pct: 0.85,
      direction: "up",
      confidence: 0.7,
      rationale: "x",
      model: "test",
      based_on_date: "2026-05-08",
      predicted_at: new Date().toISOString(),
      predicted_change_pct_low: 0.4,
      predicted_change_pct_high: 1.3,
      magnitude_bucket: "medium",
    });

    reviewPredictionsForIndex("000001.SH", "2026-05-01", "2026-05-15");
    const r = getReview("000001.SH", "2026-05-09");
    expect(r).not.toBeNull();
    expect(r!.direction_hit).toBe(1);
    expect(r!.range_hit).toBe(1); // 0.59 在 [0.4, 1.3] 内
    expect(r!.actual_direction).toBe("up");
    expect(r!.predicted_pct).toBe(0.85);
    expect(r!.pct_abs_error).toBeCloseTo(0.26, 1);
  });

  it("方向不中：预测 up + 实际 down → direction_hit = 0 + range_hit = 0", () => {
    seedQuote("000001.SH", "2026-05-08", 3400, 3390);
    seedQuote("000001.SH", "2026-05-09", 3380, 3400); // -0.59%
    upsertPrediction({
      index_code: "000001.SH",
      target_date: "2026-05-09",
      predicted_change_pct: 0.25,
      direction: "up",
      confidence: 0.6,
      rationale: "x",
      model: "test",
      based_on_date: "2026-05-08",
      predicted_at: new Date().toISOString(),
      predicted_change_pct_low: -0.1,
      predicted_change_pct_high: 0.6,
      magnitude_bucket: "small",
    });

    reviewPredictionsForIndex("000001.SH", "2026-05-01", "2026-05-15");
    const r = getReview("000001.SH", "2026-05-09");
    expect(r!.direction_hit).toBe(0);
    expect(r!.range_hit).toBe(0);
    expect(r!.pct_abs_error).toBeCloseTo(0.84, 1);
  });

  it("尚未发生（无对应行情）的预测被跳过，不写 review", () => {
    upsertPrediction({
      index_code: "000001.SH",
      target_date: "2099-01-01",
      predicted_change_pct: 0.5,
      direction: "up",
      confidence: 0.6,
      rationale: "x",
      model: "test",
      based_on_date: "2026-05-08",
      predicted_at: new Date().toISOString(),
    });
    reviewPredictionsForIndex("000001.SH", "2026-01-01", "2099-12-31");
    expect(getReview("000001.SH", "2099-01-01")).toBeNull();
  });

  it("computeAccuracy 累计：方向命中率 + MAE", () => {
    // 两条都命中
    seedQuote("000001.SH", "2026-05-07", 3400, 3380);
    seedQuote("000001.SH", "2026-05-08", 3420, 3400); // +0.59%
    seedQuote("000001.SH", "2026-05-09", 3440, 3420); // +0.58%
    upsertPrediction({
      index_code: "000001.SH",
      target_date: "2026-05-08",
      predicted_change_pct: 0.5,
      direction: "up",
      confidence: 0.7,
      rationale: "x",
      model: "test",
      based_on_date: "2026-05-07",
      predicted_at: new Date().toISOString(),
      predicted_change_pct_low: 0.2,
      predicted_change_pct_high: 0.9,
      magnitude_bucket: "medium",
    });
    upsertPrediction({
      index_code: "000001.SH",
      target_date: "2026-05-09",
      predicted_change_pct: 0.7,
      direction: "up",
      confidence: 0.7,
      rationale: "x",
      model: "test",
      based_on_date: "2026-05-08",
      predicted_at: new Date().toISOString(),
      predicted_change_pct_low: 0.3,
      predicted_change_pct_high: 1.1,
      magnitude_bucket: "medium",
    });

    reviewPredictionsForIndex("000001.SH", "2026-05-01", "2026-05-15");
    const stat = computeAccuracy("000001.SH", "2026-05-01", "2026-05-15");
    expect(stat.total).toBe(2);
    expect(stat.direction_hits).toBe(2);
    expect(stat.direction_accuracy).toBe(1);
    expect(stat.range_total).toBe(2);
    expect(stat.range_hits).toBe(2);
    expect(stat.mean_abs_error).toBeGreaterThan(0);
    expect(stat.mean_abs_error).toBeLessThan(0.5);
  });
});
