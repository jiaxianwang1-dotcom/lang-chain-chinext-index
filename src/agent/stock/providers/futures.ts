import { fetchWithRetry } from "./index.js";
import { upsertFuturesBasis, type FuturesBasisRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 股指期货升贴水 provider（P1 实现）。
 *
 * 数据源：新浪期货实时主力合约
 *   https://hq.sinajs.cn/list=nf_IF0,nf_IH0,nf_IC0,nf_IM0
 *   nf_IF0 是"主力连续"合约，字段约定见
 *   https://finance.sina.com.cn/zixun/2010-12-22/090108911340.shtml
 *
 *   字段顺序经验：
 *     [0]=合约名 [1]=time [2]=open [3]=high [4]=low
 *     [5]=昨结算 [6]=买价 [7]=卖价 [8]=current [9]=结算 [10]=昨收
 *     [11]=持仓 [12]=成交量 [13]=持仓变化 [14]=代码 [15]=date ...
 *
 * 现货指数取相同时段的实时点位，对应关系：
 *   IF → 沪深 300（用 510300 ETF 复刻 / 或直接用沪深 300 现货 sh000300）
 *   IH → 上证 50（sh000016）
 *   IC → 中证 500（sh000905）
 *   IM → 中证 1000（sh000852）
 *
 * 升贴水 basis = futures - spot：
 *   - basis > 0 升水（机构看多远期，乐观）
 *   - basis < 0 贴水（机构看空远期，悲观）
 */

const FUTURES = [
  { contract: "IF", futures_code: "nf_IF0", spot_code: "sh000300" },
  { contract: "IH", futures_code: "nf_IH0", spot_code: "sh000016" },
  { contract: "IC", futures_code: "nf_IC0", spot_code: "sh000905" },
  { contract: "IM", futures_code: "nf_IM0", spot_code: "sh000852" },
] as const;

interface ParsedFutures {
  contract_code: string;
  close: number;
  trade_date: string;
}

async function fetchSinaFutures(code: string): Promise<ParsedFutures | null> {
  const url = `https://hq.sinajs.cn/list=${code}`;
  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://finance.sina.com.cn" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const match = text.match(/="([^"]+)"/);
  if (!match) return null;
  const fields = match[1].split(",");
  if (fields.length < 16) return null;
  // 新浪股指期货主力连续（2024+）字段顺序经实测：
  //   [0]=open [1]=high [2]=low [3]=current [4]=volume [5]=turnover
  //   [6]=持仓 [7]=current（重复）
  //   [40]=YYYY-MM-DD [41]=HH:MM:SS
  // 兼容老接口：若 [3] 异常，则在前 8 个字段里找一个非零、看起来像价格（>100）的数。
  const candidates = [fields[3], fields[7], fields[8]]
    .map((s) => parseFloat(s))
    .filter((n) => Number.isFinite(n) && n > 100);
  if (candidates.length === 0) return null;
  const current = candidates[0];
  // 旧接口在 fields[14] 提供合约代码，新接口此处是数字。fallback 到入参 code。
  const codeCandidate = (fields[14] ?? "").toString().trim();
  const contract_code = /^[A-Z]{2}\d{4}$/.test(codeCandidate) ? codeCandidate : code;
  const dateField =
    fields.slice(15).find((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)) ??
    new Date().toISOString().slice(0, 10);
  return { contract_code, close: current, trade_date: dateField };
}

async function fetchTencentSpot(code: string): Promise<number | null> {
  const url = `https://qt.gtimg.cn/q=${code}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const text = await res.text();
  const match = text.match(/="([^"]+)"/);
  if (!match) return null;
  const fields = match[1].split("~");
  if (fields.length < 4) return null;
  const last = parseFloat(fields[3]);
  return Number.isFinite(last) && last > 0 ? last : null;
}

export interface FuturesIngestResult {
  inserted: number;
  failed: number;
  trade_date: string;
  by_contract: Record<string, { basis: number | null; basis_pct: number | null } | null>;
}

export async function ingestFuturesBasis(asOfDate?: string): Promise<FuturesIngestResult> {
  const trade_date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const result: FuturesIngestResult = {
    inserted: 0,
    failed: 0,
    trade_date,
    by_contract: {},
  };

  for (const f of FUTURES) {
    try {
      const [futures, spot] = await Promise.all([
        fetchSinaFutures(f.futures_code),
        fetchTencentSpot(f.spot_code),
      ]);
      if (!futures || spot == null) {
        result.failed += 1;
        result.by_contract[f.contract] = null;
        continue;
      }
      const basis = futures.close - spot;
      const basis_pct = spot > 0 ? (basis / spot) * 100 : null;
      const row: FuturesBasisRow = {
        trade_date: futures.trade_date || trade_date,
        contract: f.contract,
        contract_code: futures.contract_code,
        futures_close: futures.close,
        spot_close: spot,
        basis,
        basis_pct,
      };
      upsertFuturesBasis(row);
      result.inserted += 1;
      result.by_contract[f.contract] = { basis, basis_pct };
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: `futures.fetch_${f.contract}_failed`,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logStage({
    stage: "futures.ingest_done",
    ok: result.failed === 0,
    trade_date,
    inserted: result.inserted,
    failed: result.failed,
    detail: result.by_contract,
  });
  return result;
}
