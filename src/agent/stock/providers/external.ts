import { fetchWithRetry } from "./index.js";
import { upsertExternalProxy, type ExternalProxyRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 外资情绪代理 provider（P1 实现）。
 *
 * 用于替代已失效的"北向资金"指标。监管口径下港交所自 2024-08 起不再披露日内
 * 北向资金流向，相关公开接口返回缓存死值；以下 3 类公开实时数据反而能更稳定
 * 反映外资 / 离岸资金对 A 股的态度：
 *
 *   1. 离岸人民币（CNH）汇率 — 通过新浪 sinajs `hf_CNH`；CNH 走弱意味
 *      外资进场成本下降 / 资金回流，反之亦然。
 *   2. 港股指数 — 恒生指数 / 恒生科技指数（腾讯接口 `hkHSI` / `hkHSTECH`），
 *      与 A 股外资偏好高度相关。
 *   3. 沪深 300 ETF（510300）+ 创业板 ETF（159915）— 当日涨跌（同上腾讯 sh/sz 接口），
 *      反映"真金白银"申赎情绪。
 *
 * 全部接口均为公开 + 免费 + 实时：失败时静默降级（写 0 条），不阻塞预测。
 */

// 每个 symbol 配置主源（国内 IP 最稳）+ 雅虎降级源（境内境外都能访问）。
// 主源失败（空字符串 / 5xx / 网络错）时自动 fallback 到雅虎，保证 IDC / 境外服务器上不开天窗。
const SYMBOLS = {
  CNH: { source: "sina_fx", code: "fx_susdcnh", yahoo: "CNH=X" },
  HSI: { source: "tencent", code: "hkHSI", yahoo: "^HSI" },
  HSTECH: { source: "tencent", code: "hkHSTECH", yahoo: "^HSTECH" },
  "510300": { source: "tencent", code: "sh510300", yahoo: "510300.SS" },
  "159915": { source: "tencent", code: "sz159915", yahoo: "159915.SZ" },
} as const;

type SymbolKey = keyof typeof SYMBOLS;

interface FetchedQuote {
  symbol: string;
  close_value: number | null;
  change_pct: number | null;
  trade_date: string;
  extra?: Record<string, unknown>;
}

async function fetchSinaFxCNH(): Promise<FetchedQuote | null> {
  // 2024-08 起 hf_CNH 接口返回空。改用同站 `fx_susdcnh`（外汇频道）：
  //   var hq_str_fx_susdcnh="HH:MM:SS,bid,ask,prev_close,vol,open,high,low,last,
  //                          name(GB18030),pct?,delta,delta_pct,,52w_high,52w_low,,YYYY-MM-DD";
  // 字段索引经实测：[3]=prev_close, [8]=last, 末尾形如 \d{4}-\d{2}-\d{2} 的字段=trade_date。
  const url = "https://hq.sinajs.cn/list=fx_susdcnh";
  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://finance.sina.com.cn" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const match = text.match(/="([^"]+)"/);
  if (!match || match[1].trim().length === 0) return null;
  const fields = match[1].split(",");
  if (fields.length < 9) return null;
  const last = parseFloat(fields[8]);
  const prev = parseFloat(fields[3]);
  if (!Number.isFinite(last) || last === 0) return null;
  const change_pct =
    Number.isFinite(prev) && prev > 0 ? ((last - prev) / prev) * 100 : null;
  const dateField = fields.find((f) => /^\d{4}-\d{2}-\d{2}$/.test(f));
  const trade_date = dateField ?? new Date().toISOString().slice(0, 10);
  return {
    symbol: "CNH",
    close_value: last,
    change_pct,
    trade_date,
    extra: { bid: fields[1], ask: fields[2], prev_close: fields[3] },
  };
}

// 同时兼容腾讯返回的两种日期格式：
//   A 股紧凑：20260512151503
//   港股带分隔符：2026/05/12 18:31:03
function parseTencentDate(raw: string): string {
  const s = (raw ?? "").trim();
  const slash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slash) {
    return `${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}`;
  }
  if (/^\d{8}/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return new Date().toISOString().slice(0, 10);
}

async function fetchTencentLite(symbol: string, code: string): Promise<FetchedQuote | null> {
  // 腾讯接口字段 [3]=current, [4]=prev_close, [30]=update_ts
  // 港股 hkHSI 与 A 股口径一致
  const url = `https://qt.gtimg.cn/q=${code}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const text = await res.text();
  const match = text.match(/="([^"]+)"/);
  if (!match) return null;
  const fields = match[1].split("~");
  if (fields.length < 31) return null;
  const last = parseFloat(fields[3]);
  const prev = parseFloat(fields[4]);
  if (!Number.isFinite(last) || last === 0) return null;
  const change_pct =
    Number.isFinite(prev) && prev > 0 ? ((last - prev) / prev) * 100 : null;
  const trade_date = parseTencentDate(fields[30] ?? "");
  return { symbol, close_value: last, change_pct, trade_date };
}

// 雅虎财经备用源：境内境外均可达，结构化 JSON 自带 prev_close。
// 适用所有 5 个外资代理 symbol，参考 https://query1.finance.yahoo.com/v8/finance/chart/<sym>
async function fetchYahooQuote(yahooSymbol: string, displaySymbol: string): Promise<FetchedQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?interval=1d&range=5d`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const text = await res.text();
  let json: {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          regularMarketTime?: number;
        };
      }>;
    };
  };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const meta = json?.chart?.result?.[0]?.meta;
  const last = meta?.regularMarketPrice;
  if (!Number.isFinite(last) || !last || last === 0) return null;
  const prev = meta?.chartPreviousClose;
  const change_pct =
    Number.isFinite(prev) && (prev ?? 0) > 0 ? ((last - (prev as number)) / (prev as number)) * 100 : null;
  const tradeDate = Number.isFinite(meta?.regularMarketTime)
    ? new Date((meta!.regularMarketTime as number) * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return {
    symbol: displaySymbol,
    close_value: last,
    change_pct,
    trade_date: tradeDate,
    extra: { source: "yahoo", yahoo_symbol: yahooSymbol },
  };
}

async function fetchOne(key: SymbolKey): Promise<FetchedQuote | null> {
  const spec = SYMBOLS[key];
  // 主源
  try {
    const primary =
      spec.source === "sina_fx"
        ? await fetchSinaFxCNH()
        : await fetchTencentLite(key, spec.code);
    if (primary) return primary;
    // 主源返回 null（典型：sina IDC 屏蔽返回空字符串、腾讯境外阻塞），继续走 fallback
    logStage({
      stage: `external.primary_empty_${key}`,
      ok: false,
      primary: spec.source,
      note: "fallback to yahoo",
    });
  } catch (e) {
    logStage({
      stage: `external.primary_failed_${key}`,
      ok: false,
      primary: spec.source,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // 雅虎降级
  try {
    const fallback = await fetchYahooQuote(spec.yahoo, key);
    if (fallback) return fallback;
  } catch (e) {
    logStage({
      stage: `external.fallback_failed_${key}`,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export interface ExternalIngestResult {
  inserted: number;
  failed: number;
  trade_date: string;
  by_symbol: Record<string, { close: number | null; pct: number | null } | null>;
}

export async function ingestExternalProxies(asOfDate?: string): Promise<ExternalIngestResult> {
  const trade_date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const result: ExternalIngestResult = {
    inserted: 0,
    failed: 0,
    trade_date,
    by_symbol: {},
  };

  for (const key of Object.keys(SYMBOLS) as SymbolKey[]) {
    const q = await fetchOne(key);
    if (!q) {
      result.failed += 1;
      result.by_symbol[key] = null;
      continue;
    }
    try {
      const row: ExternalProxyRow = {
        trade_date: q.trade_date || trade_date,
        symbol: q.symbol,
        close_value: q.close_value,
        change_pct: q.change_pct,
        extra_json: q.extra ? JSON.stringify(q.extra) : null,
      };
      upsertExternalProxy(row);
      result.inserted += 1;
      result.by_symbol[key] = { close: q.close_value, pct: q.change_pct };
    } catch (e) {
      result.failed += 1;
      logStage({
        stage: `external.upsert_${key}_failed`,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logStage({
    stage: "external.ingest_done",
    ok: result.failed === 0,
    trade_date,
    inserted: result.inserted,
    failed: result.failed,
    detail: result.by_symbol,
  });
  return result;
}
