import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import Database from "better-sqlite3";

import { _setDbForTest, openDbForTest, upsertQuote, getQuote } from "../db/index.js";
import { analyzeChangeReason, _internal } from "../analysis/index.js";

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `stock-analysis-${Date.now()}-${Math.random()}.db`);
  db = openDbForTest(dbPath);
  _setDbForTest(db);

  upsertQuote({
    index_code: "000001.SH",
    index_name: "上证指数",
    trade_date: "2026-05-08",
    close_value: 3450,
    change: null,
    change_pct: null,
  });
  upsertQuote({
    index_code: "000001.SH",
    index_name: "上证指数",
    trade_date: "2026-05-09",
    close_value: 3500,
    change: 50,
    change_pct: 1.45,
  });
});

afterEach(() => {
  db.close();
  _setDbForTest(null);
  try {
    rmSync(dbPath);
  } catch {}
});

describe("analyzeChangeReason", () => {
  it("LLM 返回合法 JSON 时写回 change_reason 与 reason_source", async () => {
    const result = await analyzeChangeReason("000001.SH", "2026-05-09", {
      webSearch: async () => "央行 LPR 持平,北向资金净流入 50 亿。",
      llmInvoke: async () =>
        JSON.stringify({
          reason: "受北向资金净流入支撑，市场情绪偏暖。",
          sources: ["https://example.com/news/1"],
        }),
    });
    expect(result.reason).toContain("北向资金");
    const row = getQuote("000001.SH", "2026-05-09");
    expect(row?.change_reason).toContain("北向资金");
    expect(row?.reason_source).toContain("https://example.com/news/1");
  });

  it("LLM 输出包含 markdown 代码块时也能解析", async () => {
    const result = await analyzeChangeReason("000001.SH", "2026-05-09", {
      webSearch: async () => "热点：AI 板块走强",
      llmInvoke: async () =>
        "```json\n" +
        JSON.stringify({ reason: "AI 板块情绪带动指数上涨。", sources: ["https://x.com/1"] }) +
        "\n```",
    });
    expect(result.reason).toContain("AI");
  });

  it("搜索为空 + LLM 返回乱码时回退到保守描述", async () => {
    await analyzeChangeReason("000001.SH", "2026-05-09", {
      webSearch: async () => "",
      llmInvoke: async () => "对不起，无法回答",
    });
    const row = getQuote("000001.SH", "2026-05-09");
    expect(row?.change_reason).toMatch(/资金面|技术面|公开事件/);
    expect(row?.reason_source).toBe("无外部来源");
  });

  it("LLM 调用失败也不抛错，回退到保守描述", async () => {
    await analyzeChangeReason("000001.SH", "2026-05-09", {
      webSearch: async () => "搜索摘要",
      llmInvoke: async () => {
        throw new Error("rate limited");
      },
    });
    const row = getQuote("000001.SH", "2026-05-09");
    expect(row?.change_reason).toMatch(/资金面|技术面|公开事件/);
  });
});

describe("safeParseJson", () => {
  it("从纯 JSON 解析", () => {
    const r = _internal.safeParseJson('{"reason":"a","sources":["x"]}');
    expect(r.reason).toBe("a");
  });
  it("从 markdown 代码块解析", () => {
    const r = _internal.safeParseJson('```json\n{"reason":"b","sources":[]}\n```');
    expect(r.reason).toBe("b");
  });
  it("解析失败时回退", () => {
    const r = _internal.safeParseJson("hello world");
    expect(r.sources).toEqual(["无外部来源"]);
  });
});
