import { fetchWithRetry } from "./index.js";
import { replaceSectorRotation, type SectorQuoteRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 板块轮动 provider。
 *
 * 数据源：东方财富板块行情接口
 *   https://push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2&fields=f3,f4,f6,f8,f12,f14&po=1&fid=f3
 *   - fs=m:90+t:2 行业 + 概念 + 二三级 + 地域，约 496 条
 *   - po=1 表示按 fid 字段降序
 *   - fid=f3 涨跌幅
 *   - f3 涨跌幅 / f4 现价 / f6 成交额 / f8 换手率 / f12 BK代码 / f14 板块名
 *
 * 实战中"涨幅榜 Top5 + 跌幅榜 Bottom5"已足以反映"今天什么主题在动"，
 * 不强求严格的申万一级分类（东方财富没有干净接口）。
 *
 * 轻度过滤：剔除地域板块（名称含"板块"二字，如"广东板块"），
 * 因为地域板块涨跌反映的是省份热度，不是行业主题。
 */

const CLIST_URL =
  "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A2&fields=f3,f4,f6,f8,f12,f14";

interface RawSector {
  f3: number;
  f4: number;
  f6: number;
  f8: number;
  f12: string;
  f14: string;
}

interface ClistResp {
  data?: { total?: number; diff?: RawSector[] };
}

function isExcluded(name: string): boolean {
  // 地域板块（名称带"板块"且不是行业），以及Ⅱ/Ⅲ二三级标记
  if (/板块$/.test(name)) return true;
  if (/[ⅡⅢ]$/.test(name)) return true; // 航天装备Ⅱ / 航空装备Ⅲ
  return false;
}

async function fetchAllSectors(): Promise<RawSector[]> {
  const res = await fetchWithRetry(`${CLIST_URL}&_=${Date.now()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as ClistResp;
  return json.data?.diff ?? [];
}

export interface SectorIngestResult {
  inserted: number;
  failed: number;
  trade_date: string;
}

export async function ingestSectorRotation(
  date?: string
): Promise<SectorIngestResult> {
  const trade_date = date ?? new Date().toISOString().slice(0, 10);
  const result: SectorIngestResult = { inserted: 0, failed: 0, trade_date };

  let raws: RawSector[] = [];
  try {
    raws = await fetchAllSectors();
  } catch (e) {
    result.failed += 1;
    logStage({
      stage: "sector.fetch_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return result;
  }

  // 过滤 + 排序
  const filtered = raws.filter((r) => r.f14 && !isExcluded(r.f14));
  // f3 已按 po=1 降序。但保险起见再排一遍
  const desc = [...filtered].sort((a, b) => b.f3 - a.f3);

  const top5 = desc.slice(0, 5);
  const bottom5 = desc.slice(-5).reverse(); // 跌幅最大的在最前

  const rows: SectorQuoteRow[] = [];
  top5.forEach((r, i) =>
    rows.push({
      trade_date,
      sector_code: r.f12,
      sector_name: r.f14,
      change_pct: r.f3,
      total_value: r.f4,
      total_amount: r.f6,
      turnover_pct: r.f8,
      rank_type: "top5",
      rank_pos: i + 1,
    })
  );
  bottom5.forEach((r, i) =>
    rows.push({
      trade_date,
      sector_code: r.f12,
      sector_name: r.f14,
      change_pct: r.f3,
      total_value: r.f4,
      total_amount: r.f6,
      turnover_pct: r.f8,
      rank_type: "bottom5",
      rank_pos: i + 1,
    })
  );

  try {
    replaceSectorRotation(trade_date, rows);
    result.inserted = rows.length;
  } catch (e) {
    result.failed += 1;
    logStage({
      stage: "sector.upsert_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  logStage({
    stage: "sector.ingest_done",
    ok: result.failed === 0,
    trade_date,
    inserted: result.inserted,
    top5: top5.map((r) => `${r.f14}+${r.f3.toFixed(2)}%`),
    bottom5: bottom5.map((r) => `${r.f14}${r.f3.toFixed(2)}%`),
  });
  return result;
}
