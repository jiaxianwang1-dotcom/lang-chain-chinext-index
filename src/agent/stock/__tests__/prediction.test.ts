import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import {
  _setDbForTest,
  openDbForTest,
  upsertQuote,
  getLatestMemory,
  appendMemory,
} from "../db/index.js";
import { bootstrapPredictionMemory, predictNextTradingDay, predictAllTargets } from "../prediction/index.js";

let dbPath: string;
let db: Database.Database;

function seedQuotes(code: string, name: string, days: { date: string; close: number }[]) {
  let prev: number | null = null;
  for (const d of days) {
    const change = prev == null ? null : d.close - prev;
    const change_pct = prev == null ? null : ((d.close - prev) / prev) * 100;
    upsertQuote({
      index_code: code,
      index_name: name,
      trade_date: d.date,
      close_value: d.close,
      change,
      change_pct,
      change_reason: "测试原因",
      reason_source: "test",
    });
    prev = d.close;
  }
}

beforeEach(() => {
  dbPath = join(tmpdir(), `stock-pred-${Date.now()}-${Math.random()}.db`);
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

describe("bootstrapPredictionMemory", () => {
  it("写入 version=1 的长期记忆", async () => {
    seedQuotes("000001.SH", "上证指数", [
      { date: "2026-05-07", close: 3450 },
      { date: "2026-05-08", close: 3475 },
      { date: "2026-05-09", close: 3500 },
    ]);
    const m = await bootstrapPredictionMemory("000001.SH", {
      llmInvoke: async () =>
        JSON.stringify({
          summary: "近期上证指数温和上行，量能改善。",
          features: { trend: "up", latest_close: 3500 },
        }),
    });
    expect(m.version).toBe(1);
    expect(m.as_of_date).toBe("2026-05-09");
    expect(JSON.parse(m.features).trend).toBe("up");
  });

  it("LLM 输出非法时回退到兜底 summary", async () => {
    seedQuotes("000001.SH", "上证指数", [
      { date: "2026-05-08", close: 3475 },
      { date: "2026-05-09", close: 3500 },
    ]);
    const m = await bootstrapPredictionMemory("000001.SH", {
      llmInvoke: async () => "no idea",
    });
    expect(m.summary).toContain("近 1 年趋势");
  });
});

describe("predictNextTradingDay", () => {
  it("无记忆时自动 bootstrap，再预测，并写入 version=2", async () => {
    seedQuotes("000001.SH", "上证指数", [
      { date: "2026-05-07", close: 3450 },
      { date: "2026-05-08", close: 3475 },
      { date: "2026-05-09", close: 3500 },
    ]);
    const llm = vi
      .fn()
      .mockResolvedValueOnce(
        // bootstrap
        JSON.stringify({ summary: "上行趋势", features: { latest_close: 3500 } })
      )
      .mockResolvedValueOnce(
        // predict
        JSON.stringify({
          direction: "up",
          confidence: 0.65,
          rationale: "三连阳，量能温和放大。",
          updated_memory: { summary: "上行趋势延续", features: { latest_close: 3500, momentum: "+" } },
        })
      );

    const r = await predictNextTradingDay("000001.SH", { llmInvoke: llm });
    expect(r.direction).toBe("up");
    expect(r.confidence).toBeCloseTo(0.65, 5);
    expect(r.version).toBe(2);
    expect(llm).toHaveBeenCalledTimes(2);

    const latestMem = getLatestMemory("000001.SH");
    expect(latestMem?.version).toBe(2);
    expect(latestMem?.summary).toContain("上行趋势");
  });

  it("记忆已存在时只调用一次 LLM 做预测，并基于 as_of_date 后的新增数据", async () => {
    seedQuotes("000001.SH", "上证指数", [
      { date: "2026-05-07", close: 3450 },
      { date: "2026-05-08", close: 3475 },
      { date: "2026-05-09", close: 3500 },
    ]);
    appendMemory("000001.SH", "2026-05-08", "已有记忆", { x: 1 });

    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        direction: "down",
        confidence: 0.55,
        rationale: "短期获利盘释放。",
        updated_memory: { summary: "震荡偏弱", features: { x: 2 } },
      })
    );

    let capturedUserPrompt = "";
    const llmCapture = async (sys: string, user: string) => {
      capturedUserPrompt = user;
      return llm(sys, user);
    };

    const r = await predictNextTradingDay("000001.SH", { llmInvoke: llmCapture });
    expect(r.direction).toBe("down");
    expect(r.version).toBe(2);
    expect(llm).toHaveBeenCalledTimes(1);
    // 增量切片：as_of_date 是 2026-05-08，应只包含 2026-05-09
    expect(capturedUserPrompt).toContain("2026-05-09");
    expect(capturedUserPrompt).not.toContain("2026-05-07");
  });

  it("LLM 输出非法 JSON 时回退到 fallback 预测", async () => {
    seedQuotes("000001.SH", "上证指数", [{ date: "2026-05-09", close: 3500 }]);
    appendMemory("000001.SH", "2026-05-08", "x", {});
    const r = await predictNextTradingDay("000001.SH", {
      llmInvoke: async () => "i don't know",
    });
    expect(["up", "down"]).toContain(r.direction);
    expect(r.confidence).toBeCloseTo(0.5, 2);
  });
});

describe("predictAllTargets", () => {
  it("依次预测两个目标指数", async () => {
    seedQuotes("000001.SH", "上证指数", [{ date: "2026-05-09", close: 3500 }]);
    seedQuotes("399006.SZ", "创业板指", [{ date: "2026-05-09", close: 2200 }]);
    const llm = vi.fn().mockResolvedValue(
      JSON.stringify({
        direction: "up",
        confidence: 0.5,
        rationale: "x",
        updated_memory: { summary: "y", features: {} },
      })
    );
    // bootstrap + predict per index = 4 calls
    const results = await predictAllTargets({
      llmInvoke: async (sys, user) => {
        if (sys.includes("买涨/买跌")) {
          return llm(sys, user);
        }
        return JSON.stringify({ summary: "boot", features: {} });
      },
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.index_code).sort()).toEqual(["000001.SH", "399006.SZ"]);
  });
});
