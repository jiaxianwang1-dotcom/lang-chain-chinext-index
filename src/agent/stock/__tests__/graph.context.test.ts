import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";

import { buildContextSystemMessage } from "../graph/index.js";
import type { QuoteRow } from "../realtime/index.js";

function row(date: string, close: number): QuoteRow {
  return {
    index_code: "000001.SH",
    index_name: "上证指数",
    trade_date: date,
    close_value: close,
    open_value: close - 1,
    high_value: close + 1,
    low_value: close - 2,
    volume: 1000,
    turnover: 1e9,
    change: null,
    change_pct: null,
  };
}

describe("buildContextSystemMessage", () => {
  it("返回 SystemMessage，header 含字段口径说明", () => {
    const msg = buildContextSystemMessage([
      { indexCode: "000001.SH", rows: [row("2026-05-09", 3000), row("2026-05-10", 3030)] },
    ]);
    expect(msg).toBeInstanceOf(SystemMessage);
    const text = String(msg.content);
    expect(text).toContain("实时盘中数据");
    expect(text).toContain("trade_date");
    expect(text).toContain("close_value");
  });

  it("数据 JSON 行数 = 输入行数；包含全部字段名", () => {
    const rows = [row("2026-05-09", 3000), row("2026-05-10", 3030), row("2026-05-11", 3050)];
    const msg = buildContextSystemMessage([{ indexCode: "000001.SH", rows }]);
    const text = String(msg.content);
    // JSON 部分提取并解析
    const jsonMatch = text.match(/\[\{[\s\S]+?\}\]/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![0]) as QuoteRow[];
    expect(parsed.length).toBe(rows.length);
    for (const k of [
      "index_code",
      "index_name",
      "trade_date",
      "close_value",
      "open_value",
      "high_value",
      "low_value",
      "volume",
      "turnover",
      "change",
      "change_pct",
    ]) {
      expect(parsed[0]).toHaveProperty(k);
    }
  });

  it("空输入仅返回说明语，不报错", () => {
    const msg1 = buildContextSystemMessage([]);
    const msg2 = buildContextSystemMessage([{ indexCode: "000001.SH", rows: [] }]);
    expect(String(msg1.content)).toContain("实时数据暂时不可用");
    expect(String(msg2.content)).toContain("实时数据暂时不可用");
  });

  it("aggregated=true 时 header 标注周聚合", () => {
    const msg = buildContextSystemMessage(
      [{ indexCode: "000001.SH", rows: [row("2026-05-09", 3000)] }],
      { rangeLabel: "近一年", aggregated: true }
    );
    const text = String(msg.content);
    expect(text).toContain("近一年");
    expect(text).toContain("周聚合");
  });
});
