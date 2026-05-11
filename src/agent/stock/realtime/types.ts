/**
 * realtime-quote-service 公共类型。
 * 字段集合与 db/index.ts 的 IndexQuoteRow 对齐，保证下游 prompt / 表格 / JSON
 * 可以在"读 DB"与"读实时"之间无缝切换。
 */

export type RangeKey = "3d" | "10d" | "1m" | "2m" | "3m" | "1y" | "custom";

export interface QuoteRow {
  index_code: string;
  index_name: string;
  trade_date: string; // YYYY-MM-DD
  close_value: number;
  open_value: number | null;
  high_value: number | null;
  low_value: number | null;
  volume: number | null;
  turnover: number | null;
  change: number | null;
  change_pct: number | null;
}

export interface ParsedRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export interface ParseRangeInput {
  range: RangeKey;
  from?: string;
  to?: string;
}
