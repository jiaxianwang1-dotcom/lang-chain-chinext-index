import {
  defaultProvider,
  findIndexMeta,
  type DailyQuote,
  type QuoteProvider,
} from "../providers/index.js";
import { logStage } from "../utils/log.js";
import { getOrFetch } from "./cache.js";
import { parseRange, todayShanghai } from "./range.js";
import type { ParseRangeInput, QuoteRow, RangeKey } from "./types.js";

export type { QuoteRow, RangeKey, ParseRangeInput } from "./types.js";
export { parseRange, todayShanghai } from "./range.js";
export { TtlLruCache, _clearSharedCache } from "./cache.js";

const WINDOW_TTL_MS = 5_000;
const TODAY_TTL_MS = 30_000;
const AGGREGATE_THRESHOLD = 90;
const AGGREGATE_BUCKET = 5;

function toRow(q: DailyQuote, change: number | null, change_pct: number | null): QuoteRow {
  return {
    index_code: q.index_code,
    index_name: q.index_name,
    trade_date: q.trade_date,
    close_value: q.close_value,
    open_value: q.open_value ?? null,
    high_value: q.high_value ?? null,
    low_value: q.low_value ?? null,
    volume: q.volume ?? null,
    turnover: q.turnover ?? null,
    change,
    change_pct,
  };
}

/**
 * 链式计算 change / change_pct：第一行（窗口最早一天）为 null，
 * 之后每行 = (今日 close - 上一行 close) / 上一行 close * 100。
 *
 * 与 providers/ingestion.ts::computeChange 在数学上一致；这里直接内联
 * 避免循环依赖（ingestion 依赖 db）。
 */
function buildRowsWithChange(quotes: DailyQuote[]): QuoteRow[] {
  const sorted = [...quotes].sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
  const out: QuoteRow[] = [];
  let prevClose: number | null = null;
  for (const q of sorted) {
    let change: number | null = null;
    let change_pct: number | null = null;
    if (prevClose != null && Number.isFinite(prevClose) && prevClose !== 0) {
      change = q.close_value - prevClose;
      change_pct = (change / prevClose) * 100;
    }
    out.push(toRow(q, change, change_pct));
    prevClose = q.close_value;
  }
  return out;
}

export interface FetchQuoteWindowOptions {
  from?: string;
  to?: string;
  provider?: QuoteProvider;
  /** 仅供测试：注入"今日"以便确定性地组装 cache key。 */
  now?: Date;
}

/**
 * 按窗口拉取指定指数的实时日线，输出与 IndexQuoteRow 同形（去掉 id / created_at）。
 * 不写入任何持久化存储；5 秒内同 (indexCode, start, end) 的重复调用走缓存。
 */
export async function fetchQuoteWindow(
  indexCode: string,
  range: RangeKey,
  opts: FetchQuoteWindowOptions = {}
): Promise<QuoteRow[]> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new RangeError(`unsupported indexCode: ${indexCode}`);

  const parseInput: ParseRangeInput = { range, from: opts.from, to: opts.to };
  const { start, end } = parseRange(parseInput, opts.now);
  const provider = opts.provider ?? defaultProvider;

  const cacheKey = `q:${indexCode}:${start}:${end}`;
  return getOrFetch(cacheKey, WINDOW_TTL_MS, async () => {
    try {
      const quotes = await provider.fetchHistoricalQuotes(indexCode, start, end);
      return buildRowsWithChange(quotes);
    } catch (e) {
      logStage({
        stage: "realtime.fetch_failed",
        indexCode,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        from: start,
        to: end,
      });
      throw e;
    }
  });
}

export interface FetchTodayOptions {
  provider?: QuoteProvider;
  now?: Date;
}

/**
 * 拉取指定指数当日（含分钟级延迟）实时点位。非交易日返回 null。
 */
export async function fetchTodayIntraday(
  indexCode: string,
  opts: FetchTodayOptions = {}
): Promise<QuoteRow | null> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new RangeError(`unsupported indexCode: ${indexCode}`);

  const today = todayShanghai(opts.now);
  const provider = opts.provider ?? defaultProvider;
  const cacheKey = `t:${indexCode}:${today}`;

  return getOrFetch(cacheKey, TODAY_TTL_MS, async () => {
    try {
      const q = await provider.fetchDailyQuote(indexCode, today);
      if (!q) return null;
      // 当日单点没有"上一行"做 chain，change/change_pct 留空（前端可走 today 接口
      // 与窗口列表的最后一行 close 对齐时再算）
      return toRow(q, null, null);
    } catch (e) {
      logStage({
        stage: "realtime.fetch_today_failed",
        indexCode,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        date: today,
      });
      throw e;
    }
  });
}

/**
 * 长窗口降采样：当日线超过 90 行时按 5 个交易日为一周做 OHLCV 聚合，
 * 避免长窗口（如近一年）注入 LLM 时挤爆 token 预算。
 *
 * 聚合规则：
 *   open    = 桶内首个非空 open（缺失则 close）
 *   close   = 桶末 close
 *   high    = max(high or close)
 *   low     = min(low or close)
 *   volume  = sum
 *   turnover= sum
 *   change_pct = (桶末 close - 桶首 close) / 桶首 close * 100
 *   change     = 桶末 close - 桶首 close
 *
 * trade_date 取桶内最后一个交易日（语义上"该周收盘"）。
 */
export function aggregateForLlm(rows: QuoteRow[]): QuoteRow[] {
  if (rows.length <= AGGREGATE_THRESHOLD) return rows;
  const buckets: QuoteRow[] = [];
  for (let i = 0; i < rows.length; i += AGGREGATE_BUCKET) {
    const bucket = rows.slice(i, i + AGGREGATE_BUCKET);
    if (bucket.length === 0) continue;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];

    const firstOpen = bucket.find((b) => b.open_value != null)?.open_value ?? last.close_value;
    const high = Math.max(
      ...bucket.map((b) => (b.high_value != null ? b.high_value : b.close_value))
    );
    const low = Math.min(
      ...bucket.map((b) => (b.low_value != null ? b.low_value : b.close_value))
    );
    const volume = bucket.reduce<number | null>(
      (acc, b) => (b.volume == null ? acc : (acc ?? 0) + b.volume),
      null
    );
    const turnover = bucket.reduce<number | null>(
      (acc, b) => (b.turnover == null ? acc : (acc ?? 0) + b.turnover),
      null
    );

    const firstClose = first.close_value;
    const lastClose = last.close_value;
    const change = Number.isFinite(firstClose) && firstClose !== 0 ? lastClose - firstClose : null;
    const change_pct = change == null ? null : (change / firstClose) * 100;

    buckets.push({
      index_code: last.index_code,
      index_name: last.index_name,
      trade_date: last.trade_date,
      close_value: lastClose,
      open_value: firstOpen ?? null,
      high_value: Number.isFinite(high) ? high : null,
      low_value: Number.isFinite(low) ? low : null,
      volume,
      turnover,
      change,
      change_pct,
    });
  }
  return buckets;
}
