import type { ParseRangeInput, ParsedRange, RangeKey } from "./types.js";

const VALID_RANGES: RangeKey[] = ["3d", "10d", "1m", "2m", "3m", "1y", "custom"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_DAYS = 366;

/** 把 YYYY-MM-DD 解析为 UTC Date（避免时区漂移）。 */
function parseDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid date: ${s}`);
  return d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 取"今日"（按 Asia/Shanghai 时区，UTC+8）。这样在 UTC 16:00 之前
 * 与服务器所在时区无关，仍然能正确识别中国交易日的"今日"。
 */
export function todayShanghai(now: Date = new Date()): string {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghai.toISOString().slice(0, 10);
}

/** 把日历天数往前推 n 天，返回 YYYY-MM-DD。 */
function daysBefore(end: string, n: number): string {
  const d = parseDate(end);
  d.setUTCDate(d.getUTCDate() - n);
  return toIso(d);
}

const PRESET_DAYS: Record<Exclude<RangeKey, "custom">, number> = {
  "3d": 3,
  "10d": 10,
  "1m": 30,
  "2m": 60,
  "3m": 90,
  "1y": 365,
};

/**
 * 把 RangeKey + (from/to) 解析为日期窗口。
 *
 * - 预设窗口：end = 今日（Asia/Shanghai），start = end - PRESET_DAYS。
 * - custom：必须同时提供 from 与 to，要求 to >= from 且区间 ≤ 366 天。
 * - 非法输入抛 RangeError，服务端用它返回 400。
 */
export function parseRange(input: ParseRangeInput, now: Date = new Date()): ParsedRange {
  const { range } = input;
  if (!VALID_RANGES.includes(range)) {
    throw new RangeError(`invalid range: ${String(range)}`);
  }

  if (range === "custom") {
    const { from, to } = input;
    if (!from || !to) throw new RangeError("custom range requires both from and to");
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new RangeError("from / to must be YYYY-MM-DD");
    }
    const fromD = parseDate(from);
    const toD = parseDate(to);
    if (toD.getTime() < fromD.getTime()) {
      throw new RangeError("custom range: to must be >= from");
    }
    const spanDays = Math.floor((toD.getTime() - fromD.getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_CUSTOM_DAYS) {
      throw new RangeError("custom range exceeds 1 year");
    }
    return { start: from, end: to };
  }

  const end = todayShanghai(now);
  const start = daysBefore(end, PRESET_DAYS[range]);
  return { start, end };
}
