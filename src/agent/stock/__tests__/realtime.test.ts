import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  fetchQuoteWindow,
  fetchTodayIntraday,
  aggregateForLlm,
  parseRange,
  todayShanghai,
  _clearSharedCache,
  type QuoteRow,
} from "../realtime/index.js";
import type { DailyQuote, QuoteProvider } from "../providers/index.js";

class MockProvider implements QuoteProvider {
  public dailyCalls = 0;
  public histCalls = 0;
  constructor(
    public daily: Record<string, DailyQuote | null> = {},
    public history: Record<string, DailyQuote[]> = {}
  ) {}
  async fetchDailyQuote(code: string, date: string): Promise<DailyQuote | null> {
    this.dailyCalls += 1;
    return this.daily[`${code}|${date}`] ?? null;
  }
  async fetchHistoricalQuotes(code: string): Promise<DailyQuote[]> {
    this.histCalls += 1;
    return this.history[code] ?? [];
  }
}

beforeEach(() => {
  _clearSharedCache();
});

describe("parseRange", () => {
  it("把预设窗口映射为 [start, end] 且 end = 今日 Asia/Shanghai", () => {
    const now = new Date("2026-05-11T02:00:00Z"); // 上海 10:00
    const r = parseRange({ range: "1m" }, now);
    expect(r.end).toBe("2026-05-11");
    expect(r.start).toBe("2026-04-11");
  });

  it("custom 区间 to >= from 校验", () => {
    expect(() => parseRange({ range: "custom", from: "2026-03-01", to: "2026-02-01" })).toThrow(
      RangeError
    );
  });

  it("custom 缺失 from / to 抛错", () => {
    expect(() => parseRange({ range: "custom", from: "2026-03-01" })).toThrow(RangeError);
  });

  it("custom 区间超过 1 年抛错", () => {
    expect(() =>
      parseRange({ range: "custom", from: "2024-01-01", to: "2026-05-11" })
    ).toThrow(/exceeds 1 year/);
  });

  it("非法 range 抛错", () => {
    // @ts-expect-error 故意传非法值
    expect(() => parseRange({ range: "2y" })).toThrow(RangeError);
  });
});

describe("fetchQuoteWindow", () => {
  it("拉取窗口数据，字段名与 IndexQuoteRow 对齐", async () => {
    const provider = new MockProvider({}, {
      "000001.SH": [
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-09", close_value: 3000, open_value: 2990, high_value: 3010, low_value: 2980 },
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-10", close_value: 3030, open_value: 3000, high_value: 3035, low_value: 2995 },
      ],
    });
    const rows = await fetchQuoteWindow("000001.SH", "10d", { provider });
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "change",
        "change_pct",
        "close_value",
        "high_value",
        "index_code",
        "index_name",
        "low_value",
        "open_value",
        "trade_date",
        "turnover",
        "volume",
      ].sort()
    );
  });

  it("链式计算 change / change_pct，第一行为 null", async () => {
    const provider = new MockProvider({}, {
      "000001.SH": [
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-05", close_value: 3000 },
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-06", close_value: 3030 },
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-07", close_value: 3015 },
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-08", close_value: 3060 },
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-09", close_value: 3050 },
      ],
    });
    const rows = await fetchQuoteWindow("000001.SH", "10d", { provider });
    expect(rows[0].change).toBeNull();
    expect(rows[0].change_pct).toBeNull();
    expect(rows[1].change_pct).toBeCloseTo(1.0, 5);
    expect(rows[2].change_pct).toBeCloseTo(-0.4950495, 4);
    expect(rows[3].change_pct).toBeCloseTo(1.4925373, 4);
    expect(rows[4].change_pct).toBeCloseTo(-0.3267974, 4);
  });

  it("5 秒内重复请求合并为一次 provider 调用", async () => {
    const provider = new MockProvider({}, {
      "000001.SH": [
        { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-09", close_value: 3000 },
      ],
    });
    await fetchQuoteWindow("000001.SH", "10d", { provider });
    await fetchQuoteWindow("000001.SH", "10d", { provider });
    await fetchQuoteWindow("000001.SH", "10d", { provider });
    expect(provider.histCalls).toBe(1);
  });

  it("不同窗口不命中缓存", async () => {
    const provider = new MockProvider({}, { "000001.SH": [] });
    await fetchQuoteWindow("000001.SH", "10d", { provider });
    await fetchQuoteWindow("000001.SH", "1m", { provider });
    expect(provider.histCalls).toBe(2);
  });

  it("非法 indexCode 抛 RangeError 且不调 provider", async () => {
    const provider = new MockProvider();
    await expect(fetchQuoteWindow("ABCDE", "1m", { provider })).rejects.toThrow(/unsupported/);
    expect(provider.histCalls).toBe(0);
  });
});

describe("fetchTodayIntraday", () => {
  it("交易日返回点位", async () => {
    const now = new Date("2026-05-11T02:00:00Z");
    const today = todayShanghai(now);
    const provider = new MockProvider({
      [`000001.SH|${today}`]: {
        index_code: "000001.SH",
        index_name: "上证指数",
        trade_date: today,
        close_value: 3500,
        open_value: 3490,
        high_value: 3510,
        low_value: 3480,
      },
    });
    const row = await fetchTodayIntraday("000001.SH", { provider, now });
    expect(row).not.toBeNull();
    expect(row?.close_value).toBe(3500);
    expect(row?.trade_date).toBe(today);
  });

  it("非交易日返回 null", async () => {
    const provider = new MockProvider();
    const row = await fetchTodayIntraday("000001.SH", { provider });
    expect(row).toBeNull();
  });
});

describe("aggregateForLlm", () => {
  it("≤ 90 行不聚合", () => {
    const rows: QuoteRow[] = Array.from({ length: 90 }, (_, i) => ({
      index_code: "000001.SH",
      index_name: "上证指数",
      trade_date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      close_value: 3000 + i,
      open_value: 3000 + i,
      high_value: 3010 + i,
      low_value: 2990 + i,
      volume: 1000,
      turnover: 1e9,
      change: null,
      change_pct: null,
    }));
    expect(aggregateForLlm(rows)).toBe(rows);
  });

  it("> 90 行按 5 个交易日聚合，行数符合预期", () => {
    const N = 100;
    const rows: QuoteRow[] = Array.from({ length: N }, (_, i) => ({
      index_code: "000001.SH",
      index_name: "上证指数",
      trade_date: `2026-day-${i}`,
      close_value: 3000 + i,
      open_value: 3000 + i,
      high_value: 3010 + i,
      low_value: 2990 + i,
      volume: 1000,
      turnover: 1e9,
      change: null,
      change_pct: null,
    }));
    const out = aggregateForLlm(rows);
    expect(out.length).toBe(Math.ceil(N / 5));
    expect(out[out.length - 1].close_value).toBe(rows[rows.length - 1].close_value);
    // 桶内 high = max(close+10) 在该桶 = 桶末 close + 10；low = min(close-10) 在桶首
    expect(out[0].high_value).toBe(3014);
    expect(out[0].low_value).toBe(2990);
  });
});
