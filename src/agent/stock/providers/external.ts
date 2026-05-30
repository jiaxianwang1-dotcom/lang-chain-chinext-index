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

// 三级降级链：
//   1. 主源（sina / 腾讯）— 国内 IP 最稳、字段全
//   2. 东方财富 push2 — sina/腾讯被屏蔽时（IDC 服务器常见）；境内境外多数可达
//   3. 雅虎 — 主要为境外服务器兜底（雅虎在 IDC 段也常 429，最后一道保险）
//
// 东方财富 push2 字段说明：
//   f43=最新价（按品种缩放：港股 ×100、外汇 ×10000、A股 ETF ×1000）
//   f60=昨收（同缩放）
//   f170=涨跌幅 ×100（即 -22 表示 -0.22%）
//   不同 secid 前缀代表市场：1=沪、0=深、100=港股指数、133=外汇
const SYMBOLS = {
  CNH: {
    source: "sina_fx",
    code: "fx_susdcnh",
    eastmoney: { secid: "133.USDCNH", priceScale: 10000, pctScale: 100 },
    yahoo: "CNH=X",
  },
  HSI: {
    source: "tencent",
    code: "hkHSI",
    eastmoney: { secid: "100.HSI", priceScale: 100, pctScale: 100 },
    yahoo: "^HSI",
  },
  HSTECH: {
    source: "tencent",
    code: "hkHSTECH",
    eastmoney: null,
    yahoo: "^HSTECH",
  },
  "510300": {
    source: "tencent",
    code: "sh510300",
    eastmoney: { secid: "1.510300", priceScale: 1000, pctScale: 100 },
    yahoo: "510300.SS",
  },
  "159915": {
    source: "tencent",
    code: "sz159915",
    eastmoney: { secid: "0.159915", priceScale: 1000, pctScale: 100 },
    yahoo: "159915.SZ",
  },
  // P3 新增：富时中国 A50 指数期货（新加坡交易所，反映外资隔夜情绪）
  A50: {
    source: "yahoo_only",
    code: "a50",
    eastmoney: null,
    yahoo: "CN=F",
  },
  // P3 新增：中概互联网 ETF（反映美股中概情绪）
  KWEB: {
    source: "yahoo_only",
    code: "kweb",
    eastmoney: null,
    yahoo: "KWEB",
  },
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

// 东方财富 push2 备用源：sina/腾讯被 IDC 段屏蔽时（云服务器常见）能兜底。
// 返回的字段都是放大整数：港股 ×100、外汇 ×10000、A 股 ETF ×1000、涨跌幅 ×100。
async function fetchEastmoneyPush(
  symbol: string,
  cfg: { secid: string; priceScale: number; pctScale: number }
): Promise<FetchedQuote | null> {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(
    cfg.secid
  )}&fields=f43,f60,f170`;
  const res = await fetchWithRetry(url, {
    headers: { Referer: "https://quote.eastmoney.com/" },
  });
  if (!res.ok) return null;
  let json: { rc?: number; data?: { f43?: number; f60?: number; f170?: number } | null };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }
  const d = json?.data;
  if (!d || d.f43 == null || d.f43 === 0) return null;
  const last = d.f43 / cfg.priceScale;
  const prev = d.f60 != null && d.f60 !== 0 ? d.f60 / cfg.priceScale : null;
  const change_pct =
    d.f170 != null && Number.isFinite(d.f170)
      ? d.f170 / cfg.pctScale
      : prev && prev > 0
        ? ((last - prev) / prev) * 100
        : null;
  return {
    symbol,
    close_value: last,
    change_pct,
    trade_date: new Date().toISOString().slice(0, 10),
    extra: { source: "eastmoney_push2", secid: cfg.secid },
  };
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

  // yahoo_only 品种（A50期货、中概股ETF）直接走雅虎，跳过国内源
  if (spec.source === "yahoo_only") {
    try {
      const q = await fetchYahooQuote(spec.yahoo, key);
      if (q) return q;
    } catch (e) {
      logStage({
        stage: `external.yahoo_only_failed_${key}`,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  }

  // 1) 主源（sina/腾讯）
  try {
    const primary =
      spec.source === "sina_fx"
        ? await fetchSinaFxCNH()
        : await fetchTencentLite(key, spec.code);
    if (primary) return primary;
    logStage({
      stage: `external.primary_empty_${key}`,
      ok: false,
      primary: spec.source,
      note: "fallback to eastmoney",
    });
  } catch (e) {
    logStage({
      stage: `external.primary_failed_${key}`,
      ok: false,
      primary: spec.source,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // 2) 东方财富 push2 降级
  if (spec.eastmoney) {
    try {
      const em = await fetchEastmoneyPush(key, spec.eastmoney);
      if (em) return em;
      logStage({
        stage: `external.eastmoney_empty_${key}`,
        ok: false,
        note: "fallback to yahoo",
      });
    } catch (e) {
      logStage({
        stage: `external.eastmoney_failed_${key}`,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // 3) 雅虎降级
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
