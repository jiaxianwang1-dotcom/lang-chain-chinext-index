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
} from "../db/index.js";
import {
  bootstrapPredictionMemory,
  predictNextTradingDay,
  predictAllTargets,
} from "../prediction/index.js";

let dbPath: string;
let db: Database.Database;

function seedQuotes(
  code: string,
  name: string,
  days: { date: string; close: number; open?: number; high?: number; low?: number; volume?: number }[]
) {
  let prev: number | null = null;
  for (const d of days) {
    const change = prev == null ? null : d.close - prev;
    const change_pct = prev == null ? null : ((d.close - prev) / prev) * 100;
    upsertQuote({
      index_code: code,
      index_name: name,
      trade_date: d.date,
      close_value: d.close,
      open_value: d.open ?? null,
      high_value: d.high ?? null,
      low_value: d.low ?? null,
      volume: d.volume ?? null,
      change,
      change_pct,
      change_reason: "测试原因",
      reason_source: "test",
    });
    prev = d.close;
  }
}

function genDays(start: string, n: number, base: number, step: number) {
  const out: { date: string; close: number }[] = [];
  const d = new Date(start);
  for (let i = 0; i < n; i++) {
    out.push({ date: d.toISOString().slice(0, 10), close: base + step * i });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
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

describe("predictNextTradingDay (legacy 单维度模式 multiSignal=false)", () => {
  it("基于近 30 天数据预测，不读取任何长期记忆", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    let capturedSystem = "";
    let capturedUser = "";
    const llm = vi.fn(async (sys: string, user: string) => {
      capturedSystem = sys;
      capturedUser = user;
      return JSON.stringify({
        direction: "up",
        confidence: 0.82,
        rationale: "近 30 日上证指数稳定上行，最近一日收盘 3570，较 30 日前 +5.0%。",
      });
    });

    const r = await predictNextTradingDay("000001.SH", { llmInvoke: llm, multiSignal: false });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(r.direction).toBe("up");
    expect(r.confidence).toBeCloseTo(0.82, 5);
    expect(capturedSystem).toContain("实时分析");
    expect(capturedSystem).not.toMatch(/上一份长期记忆/);
    expect(capturedUser).not.toMatch(/v1|version=|长期记忆|上一份/);
    expect(capturedUser).toContain("数据窗口");
  });

  it("不依赖 bootstrap：即使没有任何长期记忆也能直接预测", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    expect(getLatestMemory("000001.SH")).toBeNull();

    const r = await predictNextTradingDay("000001.SH", {
      llmInvoke: async () =>
        JSON.stringify({ direction: "down", confidence: 0.6, rationale: "短期动量减弱。" }),
      multiSignal: false,
    });

    expect(r.version).toBe(1);
    const stored = getLatestMemory("000001.SH");
    expect(stored?.version).toBe(1);
    const features = JSON.parse(stored!.features);
    expect(features.last_prediction.direction).toBe("down");
    expect(features.last_prediction.window_days).toBe(30);
    expect(features.last_prediction.mode).toBe("direct-30d");
  });

  it("每次调用都生成新版本，不复用旧记忆", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    const llm = vi.fn(async () =>
      JSON.stringify({ direction: "up", confidence: 0.7, rationale: "x" })
    );
    const r1 = await predictNextTradingDay("000001.SH", { llmInvoke: llm, multiSignal: false });
    const r2 = await predictNextTradingDay("000001.SH", { llmInvoke: llm, multiSignal: false });
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
  });

  it("窗口长度可通过 windowDays 参数调整", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 50, 3400, 5));
    let captured = "";
    await predictNextTradingDay("000001.SH", {
      llmInvoke: async (_sys, user) => {
        captured = user;
        return JSON.stringify({ direction: "up", confidence: 0.7, rationale: "x" });
      },
      windowDays: 10,
      multiSignal: false,
    });
    expect(captured).toContain("共 10 个交易日");
  });

  it("LLM 输出非法 JSON 时回退到 fallback 预测", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    const r = await predictNextTradingDay("000001.SH", {
      llmInvoke: async () => "i don't know",
      multiSignal: false,
    });
    expect(["up", "down"]).toContain(r.direction);
    expect(r.confidence).toBeCloseTo(0.5, 2);
  });

  it("无任何行情数据时抛错", async () => {
    await expect(predictNextTradingDay("000001.SH", { multiSignal: false })).rejects.toThrow(/无任何行情/);
  });

  it("OHLCV 字段会进入 user prompt 表格，并被持久化", async () => {
    const baseDays = genDays("2026-04-01", 32, 3400, 5);
    const recentDays = [
      { date: "2026-05-03", open: 3560, high: 3580, low: 3555, close: 3575, volume: 3.1e8 },
      { date: "2026-05-04", open: 3575, high: 3600, low: 3570, close: 3595, volume: 3.5e8 },
      { date: "2026-05-05", open: 3595, high: 3620, low: 3590, close: 3615, volume: 4.07e8 },
    ];
    seedQuotes("000001.SH", "上证指数", [...baseDays, ...recentDays]);

    let capturedUser = "";
    let capturedSystem = "";
    await predictNextTradingDay("000001.SH", {
      llmInvoke: async (sys, user) => {
        capturedSystem = sys;
        capturedUser = user;
        return JSON.stringify({
          direction: "up",
          confidence: 0.78,
          rationale:
            "5/3-5/5 收盘 3575→3595→3615，逐日上行；5/5 量能 4.07亿手 较 5/3 的 3.10亿手 显著放大。",
        });
      },
      multiSignal: false,
    });

    expect(capturedSystem).toContain("open / high / low / close");
    expect(capturedSystem).toContain("volume");
    expect(capturedSystem).toMatch(/禁止编造/);
    expect(capturedUser).toContain("date\topen\thigh\tlow\tclose");
    expect(capturedUser).toContain("3580.00");
    expect(capturedUser).toContain("3615.00");
    expect(capturedUser).toMatch(/4\.07亿手/);
    expect(capturedUser).toMatch(/3\.50亿手/);
  });
});

describe("predictNextTradingDay (multi-signal 多维度模式 默认)", () => {
  it("默认走 multi-signal：system prompt 含 7 维度说明，features.mode = multi-signal-30d", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    let capturedSystem = "";
    let capturedUser = "";
    const llm = vi.fn(async (sys: string, user: string) => {
      capturedSystem = sys;
      capturedUser = user;
      return JSON.stringify({
        direction: "up",
        confidence: 0.7,
        rationale: "趋势 + 量能 + 资金面 + 板块均偏多，最近一日收盘 3570。",
        signals: {
          trend: "up",
          volume: "up",
          fund_flow: "missing",
          breadth: "missing",
          sector: "missing",
          lhb: "missing",
          news: "missing",
        },
      });
    });

    const r = await predictNextTradingDay("000001.SH", { llmInvoke: llm });
    expect(r.direction).toBe("up");
    expect(r.dimensions_used).toBeGreaterThanOrEqual(2);
    expect(capturedSystem).toMatch(/多信号/);
    expect(capturedSystem).toMatch(/维度.*[1-7]/);
    expect(capturedSystem).toMatch(/维度冲突/);
    expect(capturedUser).toMatch(/维度 1：价格趋势/);
    expect(capturedUser).toMatch(/维度 3：资金面/);
    expect(capturedUser).toMatch(/维度 7：当日已分类新闻事件/);

    const stored = getLatestMemory("000001.SH");
    const f = JSON.parse(stored!.features);
    expect(f.last_prediction.mode).toBe("multi-signal-v2");
    expect(f.last_prediction.signals).toBeDefined();
    expect(f.last_prediction.dimensions_used).toBeGreaterThanOrEqual(2);
  });

  it("外部维度全部缺失时降级写 missing，不抛异常", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    const r = await predictNextTradingDay("000001.SH", {
      llmInvoke: async () =>
        JSON.stringify({
          direction: "down",
          confidence: 0.55,
          rationale: "维度严重不足。",
          signals: {
            trend: "down",
            volume: "missing",
            fund_flow: "missing",
            breadth: "missing",
            sector: "missing",
            lhb: "missing",
            news: "missing",
          },
        }),
    });
    expect(r.direction).toBe("down");
    // 测试库里没 margin/breadth/sector/news/lhb/external/futures，
    // 但 macro 维度有启发式种子，因此 dimensions = trend + volume + macro = 3
    expect(r.dimensions_used).toBe(3);
  });
});

describe("predictAllTargets", () => {
  it("依次预测两个目标指数，不需要 bootstrap", async () => {
    seedQuotes("000001.SH", "上证指数", genDays("2026-04-01", 35, 3400, 5));
    seedQuotes("399006.SZ", "创业板指", genDays("2026-04-01", 35, 2200, 3));
    const llm = vi.fn(async () =>
      JSON.stringify({ direction: "up", confidence: 0.65, rationale: "x" })
    );
    const results = await predictAllTargets({ llmInvoke: llm });
    expect(results).toHaveLength(2);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.index_code).sort()).toEqual(["000001.SH", "399006.SZ"]);
  });
});

describe("bootstrapPredictionMemory (legacy, 保留导出)", () => {
  it("仍可独立使用，但已不在主流程中调用", async () => {
    seedQuotes("000001.SH", "上证指数", [
      { date: "2026-05-08", close: 3475 },
      { date: "2026-05-09", close: 3500 },
    ]);
    const m = await bootstrapPredictionMemory("000001.SH", {
      llmInvoke: async () =>
        JSON.stringify({ summary: "上行", features: { latest_close: 3500 } }),
    });
    expect(m.version).toBe(1);
  });
});
