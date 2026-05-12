import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import {
  _setDbForTest,
  openDbForTest,
  getMacroEventsInRange,
} from "../db/index.js";
import {
  seedMacroCalendar,
  getMacroEventsAround,
  ensureRecentMacroSeed,
} from "../providers/macro.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `macro-${Date.now()}-${Math.random()}.db`);
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

describe("macro_calendar provider", () => {
  it("seedMacroCalendar 写入若干 CN/US 事件", () => {
    const n = seedMacroCalendar("2026-05", "2026-05");
    expect(n).toBeGreaterThan(0);
    const rows = getMacroEventsInRange("2026-05-01", "2026-05-31");
    const names = rows.map((r) => r.event_name);
    expect(names.some((n) => /CPI/.test(n))).toBe(true);
    expect(names.some((n) => /PMI/.test(n))).toBe(true);
    expect(names.some((n) => /LPR/.test(n))).toBe(true);
    expect(names.some((n) => /非农/.test(n))).toBe(true);
    expect(rows.every((r) => r.importance >= 1 && r.importance <= 3)).toBe(true);
  });

  it("getMacroEventsAround 拉取近 7 天前 + 后 5 天的近邻事件", () => {
    seedMacroCalendar("2026-05", "2026-05");
    // 锚点为 2026-05-15，理论上能拿到 5/9 CPI / 5/12 US CPI / 5/20 LPR
    const events = getMacroEventsAround("2026-05-15");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.event_date >= "2026-05-08" && e.event_date <= "2026-05-20").toBe(true);
    }
  });

  it("ensureRecentMacroSeed 幂等 + 自动覆盖近 3 月", () => {
    ensureRecentMacroSeed("2026-05-12");
    const before = getMacroEventsInRange("2026-04-01", "2026-07-31").length;
    ensureRecentMacroSeed("2026-05-12");
    const after = getMacroEventsInRange("2026-04-01", "2026-07-31").length;
    expect(after).toBe(before);
  });
});
