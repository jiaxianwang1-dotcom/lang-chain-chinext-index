import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import { _setDbForTest, openDbForTest, getQuote, getQuotesInRange, listExistingDates } from "../db/index.js";
import { backfillOneYear, ingestToday } from "../providers/ingestion.js";
import type { DailyQuote, QuoteProvider } from "../providers/index.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `stock-ingestion-${Date.now()}-${Math.random()}.db`);
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

class MockProvider implements QuoteProvider {
  constructor(
    public daily: Record<string, DailyQuote | null> = {},
    public history: Record<string, DailyQuote[]> = {}
  ) {}
  async fetchDailyQuote(code: string, date: string) {
    return this.daily[`${code}|${date}`] ?? null;
  }
  async fetchHistoricalQuotes(code: string) {
    return this.history[code] ?? [];
  }
}

describe("backfillOneYear", () => {
  it("插入未存在的日期，跳过已存在记录", async () => {
    const provider = new MockProvider(
      {},
      {
        "000001.SH": [
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-08", close_value: 3000 },
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-09", close_value: 3030 },
        ],
        "399006.SZ": [
          { index_code: "399006.SZ", index_name: "创业板指", trade_date: "2025-05-09", close_value: 2000 },
        ],
      }
    );

    const r1 = await backfillOneYear(provider);
    expect(r1.inserted).toBe(3);
    expect(r1.skipped).toBe(0);

    const second = await backfillOneYear(provider);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);

    const sse = getQuote("000001.SH", "2025-05-09");
    expect(sse?.close_value).toBe(3030);
    expect(sse?.change).toBe(30);
    expect(sse?.change_pct).toBeCloseTo(1, 5);
  });

  it("数据源失败时记录错误但不抛出", async () => {
    const provider: QuoteProvider = {
      async fetchDailyQuote() {
        return null;
      },
      async fetchHistoricalQuotes() {
        throw new Error("network down");
      },
    };
    const r = await backfillOneYear(provider);
    expect(r.failed).toBeGreaterThanOrEqual(2);
    expect(r.inserted).toBe(0);
  });
});

describe("ingestToday", () => {
  it("非交易日（无行情或日期不匹配）跳过", async () => {
    const today = "2026-05-09";
    const provider = new MockProvider({
      "000001.SH|2026-05-09": null,
      "399006.SZ|2026-05-09": null,
    });
    const result = await ingestToday(provider, today);
    expect(result).toHaveLength(0);
  });

  it("正常交易日 upsert 并基于上一交易日计算 change", async () => {
    const today = "2026-05-09";
    // 先把上一交易日塞进去
    const provider = new MockProvider(
      {
        "000001.SH|2026-05-09": {
          index_code: "000001.SH",
          index_name: "上证指数",
          trade_date: "2026-05-09",
          close_value: 3500,
        },
        "399006.SZ|2026-05-09": {
          index_code: "399006.SZ",
          index_name: "创业板指",
          trade_date: "2026-05-09",
          close_value: 2200,
        },
      },
      {
        "000001.SH": [
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2026-05-08", close_value: 3450 },
        ],
        "399006.SZ": [
          { index_code: "399006.SZ", index_name: "创业板指", trade_date: "2026-05-08", close_value: 2200 },
        ],
      }
    );
    await backfillOneYear(provider);
    const result = await ingestToday(provider, today);
    expect(result).toHaveLength(2);
    const sse = getQuote("000001.SH", today);
    expect(sse?.close_value).toBe(3500);
    expect(sse?.change).toBeCloseTo(50, 5);
  });
});

describe("fetchWithRetry", () => {
  it("5xx 时按指数退避重试 3 次", async () => {
    const { fetchWithRetry } = await import("../providers/index.js");
    let attempt = 0;
    const original = global.fetch;
    global.fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) {
        return new Response("err", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/x");
    expect(res.status).toBe(200);
    expect(attempt).toBe(3);

    global.fetch = original;
  }, 20000);
});

describe("listExistingDates", () => {
  it("返回 set 用于去重", async () => {
    const provider = new MockProvider(
      {},
      {
        "000001.SH": [
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-08", close_value: 3000 },
        ],
        "399006.SZ": [],
      }
    );
    await backfillOneYear(provider);
    expect(listExistingDates("000001.SH").has("2025-05-08")).toBe(true);
    expect(listExistingDates("000001.SH").has("2099-01-01")).toBe(false);
  });
});

describe("getQuotesInRange", () => {
  it("按日期升序返回区间数据", async () => {
    const provider = new MockProvider(
      {},
      {
        "000001.SH": [
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-08", close_value: 3000 },
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-09", close_value: 3030 },
          { index_code: "000001.SH", index_name: "上证指数", trade_date: "2025-05-10", close_value: 3050 },
        ],
        "399006.SZ": [],
      }
    );
    await backfillOneYear(provider);
    const rows = getQuotesInRange("000001.SH", "2025-05-08", "2025-05-09");
    expect(rows.map((r) => r.trade_date)).toEqual(["2025-05-08", "2025-05-09"]);
  });
});
