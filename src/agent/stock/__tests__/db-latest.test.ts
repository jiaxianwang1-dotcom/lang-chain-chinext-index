import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import {
  _setDbForTest,
  openDbForTest,
  upsertExternalProxy,
  upsertFuturesBasis,
  getLatestExternalProxy,
  getLatestFuturesBasis,
} from "../db/index.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `dblatest-${Date.now()}-${Math.random()}.db`);
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

describe("getLatestExternalProxy: 按 symbol 分组各取最新", () => {
  it("CNH 落库到 5-13 而港股/ETF 还在 5-12 时，应当返回全部 5 个", () => {
    // 模拟生产场景：凌晨 CNH 接口已经给出 5-13 报价，但港股/ETF 仍是 5-12 收盘价
    upsertExternalProxy({ trade_date: "2026-05-12", symbol: "HSI", close_value: 26347.91, change_pct: -0.22, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-12", symbol: "HSTECH", close_value: 5070.61, change_pct: -0.7, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-12", symbol: "510300", close_value: 4.963, change_pct: -0.06, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-12", symbol: "159915", close_value: 3.94, change_pct: -0.18, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-13", symbol: "CNH", close_value: 6.7945, change_pct: 0.05, extra_json: null });

    const rows = getLatestExternalProxy();
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.size).toBe(5);
    expect(bySymbol.get("CNH")?.trade_date).toBe("2026-05-13");
    expect(bySymbol.get("HSI")?.trade_date).toBe("2026-05-12");
    expect(bySymbol.get("510300")?.close_value).toBe(4.963);
  });

  it("每个 symbol 有多日数据时，各自取最新一日", () => {
    upsertExternalProxy({ trade_date: "2026-05-10", symbol: "CNH", close_value: 6.80, change_pct: 0, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-13", symbol: "CNH", close_value: 6.7945, change_pct: 0.05, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-10", symbol: "HSI", close_value: 26000, change_pct: -0.5, extra_json: null });
    upsertExternalProxy({ trade_date: "2026-05-12", symbol: "HSI", close_value: 26347.91, change_pct: -0.22, extra_json: null });

    const rows = getLatestExternalProxy();
    expect(rows.find((r) => r.symbol === "CNH")?.trade_date).toBe("2026-05-13");
    expect(rows.find((r) => r.symbol === "HSI")?.trade_date).toBe("2026-05-12");
  });
});

describe("getLatestFuturesBasis: 按 contract 分组各取最新", () => {
  it("IF 已写入 T+1 而 IH/IC/IM 仍在 T 时，应当返回全部 4 个", () => {
    const make = (contract: string, trade_date: string, futures_close: number) => ({
      trade_date,
      contract,
      contract_code: `${contract}2509`,
      futures_close,
      spot_close: futures_close + 10,
      basis: -10,
      basis_pct: -0.2,
    });
    upsertFuturesBasis(make("IF", "2026-05-13", 4911.6));
    upsertFuturesBasis(make("IH", "2026-05-12", 3029.2));
    upsertFuturesBasis(make("IC", "2026-05-12", 8695.4));
    upsertFuturesBasis(make("IM", "2026-05-12", 8701.8));

    const rows = getLatestFuturesBasis();
    expect(rows).toHaveLength(4);
    const byContract = new Map(rows.map((r) => [r.contract, r]));
    expect(byContract.get("IF")?.trade_date).toBe("2026-05-13");
    expect(byContract.get("IM")?.trade_date).toBe("2026-05-12");
  });
});
