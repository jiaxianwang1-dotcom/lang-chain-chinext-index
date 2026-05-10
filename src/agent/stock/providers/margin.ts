import { fetchWithRetry } from "./index.js";
import { upsertMargin, getLatestMargin, type MarginBalanceRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 两融余额 provider。
 *
 * 数据源：东方财富 datacenter `RPTA_RZRQ_LSHJ`
 *   https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ
 *   - DIM_DATE: 交易日（"YYYY-MM-DD HH:MM:SS"）
 *   - NEW: 当日大盘指数
 *   - RZYE: 融资余额（元）
 *   - RZMRE: 融资买入额
 *   - RZCHE: 融资偿还额
 *   - RZJME: 融资净买入
 *   - RZJME3D / RZJME5D: 3日 / 5日累计净买入
 *   - RQYE: 融券余额
 *   - RQJMG: 融券净买入（实测一般为负）
 *   - RZRQYE: 两融总余额
 *
 * 数据 T+1 滞后属于市场监管口径。
 */

const EM_BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";

interface RawRow {
  DIM_DATE: string;
  NEW: number | null;
  RZYE: number | null;
  RZMRE: number | null;
  RZCHE: number | null;
  RZJME: number | null;
  RZJME3D: number | null;
  RZJME5D: number | null;
  RQYE: number | null;
  RQJMG: number | null;
  RZRQYE: number | null;
}

interface PageResp {
  result?: { pages: number; data: RawRow[] };
  success?: boolean;
}

function parseDate(dim: string): string {
  // "2026-05-07 00:00:00" → "2026-05-07"
  return (dim || "").slice(0, 10);
}

function rawToRow(r: RawRow): MarginBalanceRow {
  return {
    trade_date: parseDate(r.DIM_DATE),
    finance_balance: r.RZYE ?? null,
    finance_buy: r.RZMRE ?? null,
    finance_repay: r.RZCHE ?? null,
    finance_net: r.RZJME ?? null,
    finance_net_3d: r.RZJME3D ?? null,
    finance_net_5d: r.RZJME5D ?? null,
    short_balance: r.RQYE ?? null,
    short_net: r.RQJMG ?? null,
    total_balance: r.RZRQYE ?? null,
    market_index: r.NEW ?? null,
    raw_json: JSON.stringify(r),
  };
}

export async function fetchMarginPage(
  pageNumber: number,
  pageSize: number
): Promise<RawRow[]> {
  const params = new URLSearchParams({
    reportName: "RPTA_RZRQ_LSHJ",
    columns: "ALL",
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortColumns: "DIM_DATE",
    sortTypes: "-1",
  });
  const url = `${EM_BASE}?${params.toString()}`;
  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://data.eastmoney.com/" },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as PageResp;
  return json.result?.data ?? [];
}

export interface MarginIngestResult {
  inserted: number;
  failed: number;
}

/**
 * 回填近 N 天的两融数据。每页 50 条，按日期降序拉取，遇到 trade_date 早于截止则停止。
 */
export async function backfillMarginHistory(
  days = 365
): Promise<MarginIngestResult> {
  const cutoff = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  })();

  const result: MarginIngestResult = { inserted: 0, failed: 0 };
  const pageSize = 50;
  let page = 1;
  let stop = false;

  while (!stop && page < 50) {
    let rows: RawRow[] = [];
    try {
      rows = await fetchMarginPage(page, pageSize);
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: "margin.fetch_failed",
        ok: false,
        page,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    if (rows.length === 0) break;
    for (const raw of rows) {
      const row = rawToRow(raw);
      if (!row.trade_date) continue;
      if (row.trade_date < cutoff) {
        stop = true;
        break;
      }
      try {
        upsertMargin(row);
        result.inserted += 1;
      } catch (e) {
        result.failed += 1;
        logStage({
          stage: "margin.upsert_failed",
          ok: false,
          tradeDate: row.trade_date,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    page += 1;
  }
  logStage({
    stage: "margin.backfill_done",
    ok: result.failed === 0,
    inserted: result.inserted,
    failed: result.failed,
    cutoff,
  });
  return result;
}

/**
 * 增量入库：拉最近 1-2 页（约 50-100 条），与库内最新日期对比，只 upsert 新的。
 */
export async function ingestLatestMargin(): Promise<MarginIngestResult> {
  const result: MarginIngestResult = { inserted: 0, failed: 0 };
  const latest = getLatestMargin();
  let rows: RawRow[] = [];
  try {
    rows = await fetchMarginPage(1, 30);
  } catch (e) {
    result.failed += 1;
    logStage({
      stage: "margin.fetch_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return result;
  }

  for (const raw of rows) {
    const row = rawToRow(raw);
    if (!row.trade_date) continue;
    if (latest && row.trade_date <= latest.trade_date) continue;
    try {
      upsertMargin(row);
      result.inserted += 1;
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: "margin.upsert_failed",
        ok: false,
        tradeDate: row.trade_date,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  logStage({
    stage: "margin.ingest_done",
    ok: result.failed === 0,
    inserted: result.inserted,
    failed: result.failed,
  });
  return result;
}
