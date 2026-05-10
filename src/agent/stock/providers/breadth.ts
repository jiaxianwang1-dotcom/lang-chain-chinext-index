import { fetchWithRetry } from "./index.js";
import { upsertBreadth, type MarketBreadthRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 市场广度 provider。
 *
 * 数据源 1：东方财富 ulist.np 一次拉三大指数当日 涨/跌/平 家数（实时）
 *   https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006&fields=f1,f2,f3,f4,f12,f13,f14,f104,f105,f106
 *   - f104 = 上涨家数
 *   - f105 = 下跌家数
 *   - f106 = 平家数
 *
 * 数据源 2：东方财富 ZTPool 当日涨停股完整列表
 *   https://push2ex.eastmoney.com/getTopicZTPool?date=YYYYMMDD&pagesize=200
 *   - data.tc 是当日涨停总数（沪深合计）
 *   - data.pool[].m: 1=沪 0=深
 *   - data.pool[].c: 股票代码（30 开头进创业板）
 *
 * 数据源 3：东方财富 DTPool 当日跌停（实测有时返回 null，做降级）
 */

const ULIST_URL =
  "https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001,0.399006&fields=f1,f2,f3,f4,f12,f13,f14,f104,f105,f106&fltt=2";

const ZT_BASE = "https://push2ex.eastmoney.com/getTopicZTPool";
const DT_BASE = "https://push2ex.eastmoney.com/getTopicDTPool";

interface UlistDiff {
  f12: string; // code (000001 / 399001 / 399006)
  f104: number | null;
  f105: number | null;
  f106: number | null;
}

interface UlistResp {
  data?: { diff?: UlistDiff[] };
}

interface ZTPoolItem {
  c: string; // stock code
  m: number; // market: 1=sh, 0=sz
  n?: string; // name
  zdp?: number;
  lbc?: number;
  hybk?: string;
  fbt?: number;
}

interface ZTPoolResp {
  data?: { tc?: number; pool?: ZTPoolItem[] } | null;
}

const SCOPE_BY_CODE: Record<string, MarketBreadthRow["scope"]> = {
  "000001": "sse",
  "399001": "szse",
  "399006": "chinext",
};

interface PartialAdvDecBy {
  sse?: { advancing: number | null; declining: number | null; unchanged: number | null };
  szse?: { advancing: number | null; declining: number | null; unchanged: number | null };
  chinext?: { advancing: number | null; declining: number | null; unchanged: number | null };
}

async function fetchUlist(): Promise<PartialAdvDecBy> {
  const res = await fetchWithRetry(`${ULIST_URL}&_=${Date.now()}`);
  if (!res.ok) return {};
  const json = (await res.json()) as UlistResp;
  const diff = json.data?.diff ?? [];
  const out: PartialAdvDecBy = {};
  for (const d of diff) {
    const scope = SCOPE_BY_CODE[d.f12];
    if (!scope) continue;
    out[scope] = {
      advancing: d.f104 ?? null,
      declining: d.f105 ?? null,
      unchanged: d.f106 ?? null,
    };
  }
  return out;
}

interface LimitCounts {
  sse: number;
  szse: number;
  chinext: number;
  total: number;
}

async function fetchZTPool(date: string): Promise<{ counts: LimitCounts; raw: ZTPoolItem[] }> {
  const compact = date.replace(/-/g, "");
  const params = new URLSearchParams({
    ut: "7eea3edcaed734bea9cbfc24409ed989",
    dpt: "wz.ztzt",
    Pageindex: "0",
    pagesize: "300",
    sort: "fbt:asc",
    date: compact,
    _: String(Date.now()),
  });
  const res = await fetchWithRetry(`${ZT_BASE}?${params.toString()}`, {
    headers: { Referer: "https://data.eastmoney.com/" },
  });
  if (!res.ok) return { counts: { sse: 0, szse: 0, chinext: 0, total: 0 }, raw: [] };
  const json = (await res.json()) as ZTPoolResp;
  const pool = json.data?.pool ?? [];
  let sse = 0,
    szse = 0,
    chinext = 0;
  for (const it of pool) {
    if (it.c?.startsWith("30")) chinext += 1;
    if (it.m === 1) sse += 1;
    else if (it.m === 0) szse += 1;
  }
  return { counts: { sse, szse, chinext, total: pool.length }, raw: pool };
}

async function fetchDTPool(date: string): Promise<{ sse: number | null; szse: number | null; chinext: number | null }> {
  const compact = date.replace(/-/g, "");
  const params = new URLSearchParams({
    ut: "7eea3edcaed734bea9cbfc24409ed989",
    dpt: "wz.dtdt",
    Pageindex: "0",
    pagesize: "300",
    sort: "fund:asc",
    date: compact,
    _: String(Date.now()),
  });
  try {
    const res = await fetchWithRetry(`${DT_BASE}?${params.toString()}`, {
      headers: { Referer: "https://data.eastmoney.com/" },
    });
    if (!res.ok) return { sse: null, szse: null, chinext: null };
    const json = (await res.json()) as ZTPoolResp;
    if (!json.data || !json.data.pool) return { sse: null, szse: null, chinext: null };
    const pool = json.data.pool;
    let sse = 0,
      szse = 0,
      chinext = 0;
    for (const it of pool) {
      if (it.c?.startsWith("30")) chinext += 1;
      if (it.m === 1) sse += 1;
      else if (it.m === 0) szse += 1;
    }
    return { sse, szse, chinext };
  } catch {
    return { sse: null, szse: null, chinext: null };
  }
}

export interface BreadthIngestResult {
  inserted: number;
  failed: number;
  trade_date: string;
}

/**
 * 拉取并入库当日市场广度（涨跌家数 + 涨停数 + 跌停数）。
 * - 默认使用本地"今天"作为 trade_date；非交易日数据可能为零，但仍写入（符合 fail-safe）
 * - 任一子接口失败时其他维度仍会入库
 */
export async function ingestMarketBreadth(date?: string): Promise<BreadthIngestResult> {
  const trade_date = date ?? new Date().toISOString().slice(0, 10);
  const result: BreadthIngestResult = { inserted: 0, failed: 0, trade_date };

  let advDec: PartialAdvDecBy = {};
  try {
    advDec = await fetchUlist();
  } catch (e) {
    result.failed += 1;
    logStage({
      stage: "breadth.ulist_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  let limit = { sse: 0, szse: 0, chinext: 0, total: 0 };
  let ztRaw: ZTPoolItem[] = [];
  try {
    const r = await fetchZTPool(trade_date);
    limit = r.counts;
    ztRaw = r.raw;
  } catch (e) {
    result.failed += 1;
    logStage({
      stage: "breadth.ztpool_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const dt = await fetchDTPool(trade_date);

  const scopes: MarketBreadthRow["scope"][] = ["sse", "szse", "chinext"];
  for (const sc of scopes) {
    const ad = advDec[sc] ?? { advancing: null, declining: null, unchanged: null };
    const lu = limit[sc] ?? null;
    const ld = dt[sc] ?? null;
    try {
      upsertBreadth({
        trade_date,
        scope: sc,
        advancing: ad.advancing,
        declining: ad.declining,
        unchanged: ad.unchanged,
        limit_up: lu,
        limit_down: ld,
        raw_json: sc === "sse" && ztRaw.length > 0 ? JSON.stringify(ztRaw.slice(0, 30)) : null,
      });
      result.inserted += 1;
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: "breadth.upsert_failed",
        ok: false,
        scope: sc,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logStage({
    stage: "breadth.ingest_done",
    ok: result.failed === 0,
    trade_date,
    inserted: result.inserted,
    failed: result.failed,
    limit,
  });
  return result;
}
