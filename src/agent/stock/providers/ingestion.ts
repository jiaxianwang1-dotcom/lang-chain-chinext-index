import {
  defaultProvider,
  listTargetIndexes,
  type DailyQuote,
  type QuoteProvider,
} from "./index.js";
import {
  upsertQuote,
  listExistingDates,
  getPreviousTradingDay,
  getQuote,
  type IndexQuoteRow,
} from "../db/index.js";
import { logStage } from "../utils/log.js";

export interface IngestionResult {
  inserted: number;
  skipped: number;
  failed: number;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toIso(d);
}

function computeChange(close: number, prevClose: number | null | undefined): {
  change: number | null;
  change_pct: number | null;
} {
  if (prevClose == null || !Number.isFinite(prevClose) || prevClose === 0) {
    return { change: null, change_pct: null };
  }
  const change = close - prevClose;
  const change_pct = (change / prevClose) * 100;
  return { change, change_pct };
}

/**
 * 一次性给已经入库的行补齐 OHLCV（开/高/低/量/额）。
 * 原理：upsertQuote 对 OHLCV 列使用 COALESCE，所以重跑历史拉取并对每条结果
 * 调用 upsertQuote，不会覆盖 close/change/change_reason/reason_source，
 * 只会把当前还是 NULL 的列填上。
 */
export async function refreshOhlcvForExistingQuotes(
  provider: QuoteProvider = defaultProvider
): Promise<{ updated: number; failed: number }> {
  const days = Number(process.env.STOCK_BACKFILL_DAYS ?? "365");
  const start = daysAgo(days);
  const end = toIso(new Date());
  let updated = 0;
  let failed = 0;

  for (const meta of listTargetIndexes()) {
    let quotes: DailyQuote[] = [];
    try {
      quotes = await provider.fetchHistoricalQuotes(meta.index_code, start, end);
    } catch (e) {
      logStage({
        stage: "ohlcv_refresh.fetch_failed",
        indexCode: meta.index_code,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      failed += 1;
      continue;
    }

    for (const q of quotes) {
      try {
        // 只 upsert OHLCV 相关字段；close/change 由 COALESCE 保证不被错误覆盖
        // 但 upsertQuote 必须接收 close_value（NOT NULL），所以传当前 close 没事
        // change/change_pct 用现有行的值或重新计算都行，这里复用本批的 quote
        const existing = getQuote(meta.index_code, q.trade_date);
        const change = existing?.change ?? null;
        const change_pct = existing?.change_pct ?? null;

        upsertQuote({
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
        });
        updated += 1;
      } catch (e) {
        failed += 1;
        logStage({
          stage: "ohlcv_refresh.upsert_failed",
          indexCode: meta.index_code,
          tradeDate: q.trade_date,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    logStage({
      stage: "ohlcv_refresh.index_done",
      indexCode: meta.index_code,
      ok: true,
      received: quotes.length,
    });
  }
  logStage({ stage: "ohlcv_refresh.summary", ok: true, updated, failed });
  return { updated, failed };
}

/**
 * 回填近 365 天的历史日线。已存在的 (index_code, trade_date) 会被跳过，
 * 不会覆盖已有的 change_reason。返回汇总结果。
 */
export async function backfillOneYear(
  provider: QuoteProvider = defaultProvider
): Promise<IngestionResult> {
  const days = Number(process.env.STOCK_BACKFILL_DAYS ?? "365");
  const start = daysAgo(days);
  const end = toIso(new Date());
  const total: IngestionResult = { inserted: 0, skipped: 0, failed: 0 };

  for (const meta of listTargetIndexes()) {
    const existing = listExistingDates(meta.index_code);
    let quotes: DailyQuote[] = [];
    try {
      quotes = await provider.fetchHistoricalQuotes(meta.index_code, start, end);
    } catch (e) {
      total.failed += 1;
      logStage({
        stage: "backfill.fetch_failed",
        indexCode: meta.index_code,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // 升序处理，便于计算 change 时 prev 已存在
    quotes.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
    let prevClose: number | null = null;
    for (const q of quotes) {
      // 优先使用本批数据计算 change，否则查 db
      let prev = prevClose;
      if (prev == null) {
        const dbPrev = getPreviousTradingDay(meta.index_code, q.trade_date);
        prev = dbPrev?.close_value ?? null;
      }
      const { change, change_pct } = computeChange(q.close_value, prev);

      if (existing.has(q.trade_date)) {
        total.skipped += 1;
      } else {
        try {
          upsertQuote({
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
          });
          total.inserted += 1;
        } catch (e) {
          total.failed += 1;
          logStage({
            stage: "backfill.upsert_failed",
            indexCode: meta.index_code,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            tradeDate: q.trade_date,
          });
        }
      }
      prevClose = q.close_value;
    }

    logStage({
      stage: "backfill.index_done",
      indexCode: meta.index_code,
      ok: true,
      counts: { received: quotes.length, inserted: total.inserted, skipped: total.skipped },
    });
  }

  logStage({ stage: "backfill.summary", ok: true, ...total });
  return total;
}

/**
 * 拉取当日实时点位并 upsert。当日为非交易日（无有效行情）时返回 `[]`。
 */
export async function ingestToday(
  provider: QuoteProvider = defaultProvider,
  today: string = toIso(new Date())
): Promise<IndexQuoteRow[]> {
  const out: IndexQuoteRow[] = [];
  for (const meta of listTargetIndexes()) {
    let quote: DailyQuote | null = null;
    try {
      quote = await provider.fetchDailyQuote(meta.index_code, today);
    } catch (e) {
      logStage({
        stage: "ingest.fetch_failed",
        indexCode: meta.index_code,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    if (!quote || quote.trade_date !== today) {
      logStage({
        stage: "ingest.skip_non_trading",
        indexCode: meta.index_code,
        ok: true,
        today,
        gotDate: quote?.trade_date ?? null,
      });
      continue;
    }

    const prev = getPreviousTradingDay(meta.index_code, today);
    const { change, change_pct } = computeChange(quote.close_value, prev?.close_value ?? null);
    upsertQuote({
      index_code: quote.index_code,
      index_name: quote.index_name,
      trade_date: quote.trade_date,
      close_value: quote.close_value,
      open_value: quote.open_value ?? null,
      high_value: quote.high_value ?? null,
      low_value: quote.low_value ?? null,
      volume: quote.volume ?? null,
      turnover: quote.turnover ?? null,
      change,
      change_pct,
    });
    const stored = getQuote(meta.index_code, today);
    if (stored) out.push(stored);
    logStage({
      stage: "ingest.upserted",
      indexCode: meta.index_code,
      ok: true,
      tradeDate: today,
      closeValue: quote.close_value,
      change,
      changePct: change_pct,
    });
  }
  return out;
}
