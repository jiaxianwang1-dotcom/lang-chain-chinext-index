import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import {
  _setDbForTest,
  openDbForTest,
  upsertQuote,
  getPrediction,
} from "../db/index.js";
import { predictChangePctForTarget } from "../prediction/realtime-card.js";
import { normalizeMultiSignalPrediction } from "../prediction/index.js";

let dbPath: string;
let db: Database.Database;

function seedDays(code: string, name: string, start: string, n: number, base: number, step: number) {
  const d = new Date(`${start}T00:00:00Z`);
  let prev: number | null = null;
  for (let i = 0; i < n; i++) {
    const close = base + step * i;
    const date = d.toISOString().slice(0, 10);
    const change = prev == null ? null : close - prev;
    const change_pct = prev == null ? null : ((close - prev) / prev) * 100;
    upsertQuote({
      index_code: code,
      index_name: name,
      trade_date: date,
      close_value: close,
      open_value: close - 1,
      high_value: close + 2,
      low_value: close - 2,
      volume: 1e8,
      change,
      change_pct,
      change_reason: "x",
      reason_source: "test",
    });
    prev = close;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

beforeEach(() => {
  dbPath = join(tmpdir(), `card-${Date.now()}-${Math.random()}.db`);
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

describe("predictChangePctForTarget v2 (multi-signal)", () => {
  it("LLM 返回完整 v2 JSON 时落库的预测含 range + bucket + dimensions_used", async () => {
    seedDays("000001.SH", "上证指数", "2026-04-01", 32, 3400, 5);
    const llm = vi.fn(async (sys: string, user: string) => {
      // 验证 prompt 真的包含 10 维而不是 7 维
      expect(sys).toContain("最多 10 个维度");
      expect(user).toContain("维度 9：外资情绪代理");
      expect(user).toContain("维度 10：股指期货升贴水");
      return JSON.stringify({
        direction: "up",
        confidence: 0.7,
        predicted_change_pct: 0.85,
        predicted_change_pct_low: 0.4,
        predicted_change_pct_high: 1.3,
        magnitude_bucket: "medium",
        rationale: "趋势 + 量能 + 宏观偏多",
        signals: {
          trend: "up",
          volume: "up",
          fund_flow: "missing",
          breadth: "missing",
          sector: "missing",
          lhb: "missing",
          news: "missing",
          macro: "up",
          external: "missing",
          futures: "missing",
        },
      });
    });

    const saved = await predictChangePctForTarget("000001.SH", "2026-05-04", { llmInvoke: llm });
    expect(saved.direction).toBe("up");
    expect(saved.predicted_change_pct).toBe(0.85);
    expect(saved.predicted_change_pct_low).toBe(0.4);
    expect(saved.predicted_change_pct_high).toBe(1.3);
    expect(saved.magnitude_bucket).toBe("medium");
    expect(saved.dimensions_used).toBeGreaterThanOrEqual(2);
    expect(saved.signals_json).toContain("trend");

    // 缓存命中：第二次调用相同参数应直接读 DB（llm 不应再被调用）
    const cached = await predictChangePctForTarget("000001.SH", "2026-05-04", { llmInvoke: llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(cached.predicted_change_pct).toBe(0.85);
  });

  it("缓存陈旧（基于 T-1，但 quote 已更新到 T）时自动重算", async () => {
    // 先用截至 5-03 的 quote 种子，生成一条 target=5-04 的预测（based_on=5-03）
    seedDays("000001.SH", "上证指数", "2026-04-01", 33, 3400, 5);
    const llm1 = vi.fn(async () =>
      JSON.stringify({
        direction: "up",
        confidence: 0.6,
        predicted_change_pct: 0.4,
        predicted_change_pct_low: 0.1,
        predicted_change_pct_high: 0.7,
        magnitude_bucket: "small",
        rationale: "based on 5-03",
      })
    );
    const first = await predictChangePctForTarget("000001.SH", "2026-05-04", {
      llmInvoke: llm1,
    });
    expect(first.based_on_date).toBe("2026-05-03");
    expect(llm1).toHaveBeenCalledTimes(1);

    // 模拟收盘后入了 5-04 的 quote（最新 quote 比缓存 based_on 更新）
    upsertQuote({
      index_code: "000001.SH",
      index_name: "上证指数",
      trade_date: "2026-05-04",
      close_value: 3580,
      open_value: 3570,
      high_value: 3590,
      low_value: 3565,
      volume: 1e8,
    });

    // 再次查询同 target，应当感知到陈旧并重算
    const llm2 = vi.fn(async () =>
      JSON.stringify({
        direction: "down",
        confidence: 0.7,
        predicted_change_pct: -0.5,
        predicted_change_pct_low: -1.0,
        predicted_change_pct_high: 0.0,
        magnitude_bucket: "small",
        rationale: "based on 5-04",
      })
    );
    const second = await predictChangePctForTarget("000001.SH", "2026-05-04", {
      llmInvoke: llm2,
    });
    expect(llm2).toHaveBeenCalledTimes(1);
    expect(second.based_on_date).toBe("2026-05-04");
    expect(second.direction).toBe("down");
  });

  it("force=true 时强制重算，绕过缓存", async () => {
    seedDays("000001.SH", "上证指数", "2026-04-01", 32, 3400, 5);
    const llm = vi.fn(async () =>
      JSON.stringify({
        direction: "up",
        confidence: 0.7,
        predicted_change_pct: 0.5,
        predicted_change_pct_low: 0.2,
        predicted_change_pct_high: 0.8,
        magnitude_bucket: "medium",
        rationale: "x",
      })
    );
    await predictChangePctForTarget("000001.SH", "2026-05-04", { llmInvoke: llm });
    await predictChangePctForTarget("000001.SH", "2026-05-04", { llmInvoke: llm, force: true });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("LLM 输出非法 JSON 时使用兜底 + normalize 仍能给出区间与档位", async () => {
    seedDays("000001.SH", "上证指数", "2026-04-01", 32, 3400, 5);
    const saved = await predictChangePctForTarget("000001.SH", "2026-05-04", {
      llmInvoke: async () => "i don't know",
    });
    expect(["up", "down"]).toContain(saved.direction);
    expect(saved.predicted_change_pct).not.toBeNull();
    expect(saved.predicted_change_pct_low).not.toBeNull();
    expect(saved.predicted_change_pct_high).not.toBeNull();
    expect(saved.magnitude_bucket).toBe("small"); // 兜底是 ±0.3% < 0.5%
    // 区间必须夹住中位数
    expect(saved.predicted_change_pct_low!).toBeLessThanOrEqual(saved.predicted_change_pct!);
    expect(saved.predicted_change_pct_high!).toBeGreaterThanOrEqual(saved.predicted_change_pct!);
  });

  it("getPrediction 能读到刚刚的 v2 预测结果", async () => {
    seedDays("000001.SH", "上证指数", "2026-04-01", 32, 3400, 5);
    await predictChangePctForTarget("000001.SH", "2026-05-04", {
      llmInvoke: async () =>
        JSON.stringify({
          direction: "down",
          confidence: 0.65,
          predicted_change_pct: -0.6,
          predicted_change_pct_low: -1.1,
          predicted_change_pct_high: -0.1,
          magnitude_bucket: "medium",
          rationale: "回踩",
        }),
    });
    const row = getPrediction("000001.SH", "2026-05-04");
    expect(row?.direction).toBe("down");
    expect(row?.predicted_change_pct).toBe(-0.6);
    expect(row?.magnitude_bucket).toBe("medium");
  });
});

describe("normalizeMultiSignalPrediction", () => {
  it("方向 up 但 pct 是负的 → 校正为绝对值", () => {
    const r = normalizeMultiSignalPrediction({
      direction: "up",
      confidence: 0.7,
      predicted_change_pct: -0.5,
      rationale: "x",
    });
    expect(r.predicted_change_pct).toBeGreaterThan(0);
    expect(r.direction).toBe("up");
  });

  it("缺 pct 时按 direction 兜底为 ±0.4，bucket=small", () => {
    const r = normalizeMultiSignalPrediction({
      direction: "down",
      confidence: 0.6,
      rationale: "x",
    });
    expect(r.predicted_change_pct).toBeLessThan(0);
    expect(r.magnitude_bucket).toBe("small");
  });

  it("缺 low/high 时按 confidence 自动派生区间，且区间夹住 pct", () => {
    const r = normalizeMultiSignalPrediction({
      direction: "up",
      confidence: 0.7,
      predicted_change_pct: 0.85,
      rationale: "x",
    });
    expect(r.predicted_change_pct_low).not.toBeUndefined();
    expect(r.predicted_change_pct_high).not.toBeUndefined();
    expect(r.predicted_change_pct_low!).toBeLessThanOrEqual(r.predicted_change_pct!);
    expect(r.predicted_change_pct_high!).toBeGreaterThanOrEqual(r.predicted_change_pct!);
  });

  it("|pct| ≥ 1.5% → bucket = large", () => {
    const r = normalizeMultiSignalPrediction({
      direction: "up",
      confidence: 0.85,
      predicted_change_pct: 1.8,
      rationale: "x",
    });
    expect(r.magnitude_bucket).toBe("large");
  });

  it("low > high 时自动交换并强制夹住 pct", () => {
    const r = normalizeMultiSignalPrediction({
      direction: "up",
      confidence: 0.7,
      predicted_change_pct: 0.5,
      predicted_change_pct_low: 1.5,
      predicted_change_pct_high: 0.0,
      rationale: "x",
    });
    expect(r.predicted_change_pct_low!).toBeLessThanOrEqual(r.predicted_change_pct_high!);
    expect(r.predicted_change_pct_low!).toBeLessThanOrEqual(0.5);
    expect(r.predicted_change_pct_high!).toBeGreaterThanOrEqual(0.5);
  });
});
