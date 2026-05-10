import { fetchWithRetry } from "./index.js";
import { upsertLhb, getLhbByDate, type LhbRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 龙虎榜个股 provider。
 *
 * 数据源：东方财富 datacenter
 *   reportName=RPT_DAILYBILLBOARD_DETAILSNEW
 *   filter=(TRADE_DATE='YYYY-MM-DD')
 *
 * 字段映射见 db/index.ts LhbRow。
 */

const EM_BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";

interface RawLhb {
  TRADE_DATE: string;
  SECURITY_CODE: string;
  SECURITY_NAME_ABBR?: string;
  CLOSE_PRICE?: number | null;
  CHANGE_RATE?: number | null;
  BILLBOARD_NET_AMT?: number | null;
  BILLBOARD_BUY_AMT?: number | null;
  BILLBOARD_SELL_AMT?: number | null;
  MARKET?: string;
  EXPLANATION?: string;
}

interface PageResp {
  result?: { pages: number; data: RawLhb[] };
}

function parseDate(t: string): string {
  return (t || "").slice(0, 10);
}

function rawToRow(r: RawLhb): LhbRow {
  return {
    trade_date: parseDate(r.TRADE_DATE),
    security_code: r.SECURITY_CODE,
    security_name: r.SECURITY_NAME_ABBR ?? null,
    close_price: r.CLOSE_PRICE ?? null,
    change_rate: r.CHANGE_RATE ?? null,
    net_amount: r.BILLBOARD_NET_AMT ?? null,
    buy_amount: r.BILLBOARD_BUY_AMT ?? null,
    sell_amount: r.BILLBOARD_SELL_AMT ?? null,
    market: r.MARKET ?? null,
    explanation: r.EXPLANATION ?? null,
    raw_json: JSON.stringify(r),
  };
}

export async function fetchLhbPage(
  date: string,
  pageNumber: number,
  pageSize: number
): Promise<RawLhb[]> {
  const params = new URLSearchParams({
    reportName: "RPT_DAILYBILLBOARD_DETAILSNEW",
    columns: "ALL",
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortColumns: "BILLBOARD_NET_AMT",
    sortTypes: "-1",
    filter: `(TRADE_DATE='${date}')`,
  });
  const url = `${EM_BASE}?${params.toString()}`;
  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://data.eastmoney.com/" },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as PageResp;
  return json.result?.data ?? [];
}

export interface LhbIngestResult {
  inserted: number;
  failed: number;
  trade_date: string;
}

export async function ingestLhb(date: string): Promise<LhbIngestResult> {
  const result: LhbIngestResult = { inserted: 0, failed: 0, trade_date: date };
  const pageSize = 50;

  for (let page = 1; page < 20; page++) {
    let raws: RawLhb[] = [];
    try {
      raws = await fetchLhbPage(date, page, pageSize);
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: "lhb.fetch_failed",
        ok: false,
        page,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
    if (raws.length === 0) break;

    for (const raw of raws) {
      const row = rawToRow(raw);
      if (!row.trade_date || !row.security_code) continue;
      try {
        upsertLhb(row);
        result.inserted += 1;
      } catch (e) {
        result.failed += 1;
        logStage({
          stage: "lhb.upsert_failed",
          ok: false,
          tradeDate: row.trade_date,
          securityCode: row.security_code,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (raws.length < pageSize) break;
  }

  logStage({
    stage: "lhb.ingest_done",
    ok: result.failed === 0,
    trade_date: date,
    inserted: result.inserted,
    failed: result.failed,
  });
  return result;
}

/**
 * 当日龙虎榜聚合统计：上榜数、净买入合计、净卖出合计、净买入 Top 3。
 */
export interface LhbActivity {
  trade_date: string;
  total_count: number;
  net_buy_total: number;
  net_sell_total: number;
  top_3_by_net_amount: Array<{
    code: string;
    name: string | null;
    net_amount: number;
    explanation: string | null;
  }>;
}

export function getLhbActivity(date: string): LhbActivity {
  const rows = getLhbByDate(date);
  let net_buy_total = 0;
  let net_sell_total = 0;
  for (const r of rows) {
    const n = r.net_amount ?? 0;
    if (n >= 0) net_buy_total += n;
    else net_sell_total += n; // 负数累加
  }
  const top_3 = [...rows]
    .sort((a, b) => Math.abs(b.net_amount ?? 0) - Math.abs(a.net_amount ?? 0))
    .slice(0, 3)
    .map((r) => ({
      code: r.security_code,
      name: r.security_name,
      net_amount: r.net_amount ?? 0,
      explanation: r.explanation,
    }));
  return {
    trade_date: date,
    total_count: rows.length,
    net_buy_total,
    net_sell_total,
    top_3_by_net_amount: top_3,
  };
}

/**
 * 是否为目标指数成分股。规则：
 * - 上证指数 000001.SH：股票代码 60 / 68 / 90 开头
 * - 创业板指 399006.SZ：30 开头
 * - 深证成指 399001.SZ：00 / 30 开头
 */
export function isIndexConstituent(stockCode: string, indexCode: string): boolean {
  const c = stockCode;
  if (indexCode === "000001.SH") return /^(60|68|90)/.test(c);
  if (indexCode === "399006.SZ") return /^30/.test(c);
  if (indexCode === "399001.SZ") return /^(00|30)/.test(c);
  return false;
}

/**
 * 当日龙虎榜中影响目标指数的个股聚合：净买入合计 + 个股 Top 3。
 */
export function getLhbForIndex(date: string, indexCode: string): {
  count: number;
  net_amount_sum: number;
  top_3: Array<{ code: string; name: string | null; net_amount: number; explanation: string | null }>;
} {
  const rows = getLhbByDate(date).filter((r) => isIndexConstituent(r.security_code, indexCode));
  let sum = 0;
  for (const r of rows) sum += r.net_amount ?? 0;
  const top3 = [...rows]
    .sort((a, b) => Math.abs(b.net_amount ?? 0) - Math.abs(a.net_amount ?? 0))
    .slice(0, 3)
    .map((r) => ({
      code: r.security_code,
      name: r.security_name,
      net_amount: r.net_amount ?? 0,
      explanation: r.explanation,
    }));
  return { count: rows.length, net_amount_sum: sum, top_3: top3 };
}
