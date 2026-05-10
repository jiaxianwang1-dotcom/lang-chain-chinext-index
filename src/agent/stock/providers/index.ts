import { sleep } from "../utils/log.js";

export interface DailyQuote {
  index_code: string;
  index_name: string;
  trade_date: string; // YYYY-MM-DD
  close_value: number;
  open_value?: number;
  high_value?: number;
  low_value?: number;
  /** 成交量（东方财富口径：手；指数为成交手数总和） */
  volume?: number;
  /** 成交额（元） */
  turnover?: number;
}

export interface QuoteProvider {
  fetchDailyQuote(indexCode: string, date: string): Promise<DailyQuote | null>;
  fetchHistoricalQuotes(indexCode: string, startDate: string, endDate: string): Promise<DailyQuote[]>;
}

export interface IndexMeta {
  index_code: string;
  index_name: string;
  /** 东方财富 secid，例如 "1.000001"（沪市）或 "0.399006"（深市）。*/
  eastmoney_secid: string;
  /** 腾讯实时行情 code，例如 "sh000001" / "sz399006"。*/
  tencent_code: string;
}

const TARGET_INDEXES: IndexMeta[] = [
  {
    index_code: "000001.SH",
    index_name: "上证指数",
    eastmoney_secid: "1.000001",
    tencent_code: "sh000001",
  },
  {
    index_code: "399006.SZ",
    index_name: "创业板指",
    eastmoney_secid: "0.399006",
    tencent_code: "sz399006",
  },
];

export function listTargetIndexes(): IndexMeta[] {
  return TARGET_INDEXES;
}

export function findIndexMeta(indexCode: string): IndexMeta | null {
  return TARGET_INDEXES.find((i) => i.index_code === indexCode) ?? null;
}

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
};

/** 三级指数退避重试：1s / 2s / 4s。最多 3 次（含首次共 4 次）。*/
export async function fetchWithRetry(url: string, init?: RequestInit, attempt = 0): Promise<Response> {
  const maxAttempts = 3;
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...DEFAULT_HEADERS, ...(init?.headers ?? {}) },
    });
    if (!res.ok && res.status >= 500 && attempt < maxAttempts) {
      await sleep(1000 * Math.pow(2, attempt));
      return fetchWithRetry(url, init, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < maxAttempts) {
      await sleep(1000 * Math.pow(2, attempt));
      return fetchWithRetry(url, init, attempt + 1);
    }
    throw e;
  }
}

/** YYYY-MM-DD → YYYYMMDD（东方财富）。*/
function dateToCompact(date: string): string {
  return date.replace(/-/g, "");
}
function compactToDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * 默认实现：腾讯财经实时点位 + 东方财富日线。
 *
 * - 实时点位：https://qt.gtimg.cn/q=sh000001 → 文本，分号分隔
 * - 历史日线：https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&...
 */
export class TencentEastmoneyProvider implements QuoteProvider {
  async fetchDailyQuote(indexCode: string, date: string): Promise<DailyQuote | null> {
    const meta = findIndexMeta(indexCode);
    if (!meta) throw new Error(`未知 index_code: ${indexCode}`);

    const today = new Date().toISOString().slice(0, 10);
    if (date === today) {
      const live = await this.fetchTencentLive(meta);
      if (live) return live;
    }

    // 非今日或腾讯接口失败，降级到东方财富历史日线
    const history = await this.fetchEastmoneyKline(meta, date, date);
    return history.find((q) => q.trade_date === date) ?? null;
  }

  async fetchHistoricalQuotes(
    indexCode: string,
    startDate: string,
    endDate: string
  ): Promise<DailyQuote[]> {
    const meta = findIndexMeta(indexCode);
    if (!meta) throw new Error(`未知 index_code: ${indexCode}`);
    return this.fetchEastmoneyKline(meta, startDate, endDate);
  }

  private async fetchTencentLive(meta: IndexMeta): Promise<DailyQuote | null> {
    const url = `https://qt.gtimg.cn/q=${meta.tencent_code}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const text = await res.text();
    // v_sh000001="1~上证指数~000001~3500.00~3490.00~3500.00~..."
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;
    const fields = match[1].split("~");
    if (fields.length < 31) return null;
    // 腾讯指数实时字段（经验值 / 公开接口约定）：
    //   [3]=current(close), [4]=prev_close, [5]=open, [6]=volume(手),
    //   [33]=high, [34]=low, [37]=turnover(万元), [30]=update_ts
    const close = parseFloat(fields[3]);
    if (!Number.isFinite(close) || close === 0) return null;
    const tradeDateRaw = fields[30] ?? "";
    const tradeDate =
      tradeDateRaw.length >= 8
        ? compactToDate(tradeDateRaw.slice(0, 8))
        : new Date().toISOString().slice(0, 10);
    const safeNum = (v: string | undefined): number | undefined => {
      if (!v) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      index_code: meta.index_code,
      index_name: meta.index_name,
      trade_date: tradeDate,
      close_value: close,
      open_value: safeNum(fields[5]),
      high_value: safeNum(fields[33]),
      low_value: safeNum(fields[34]),
      volume: safeNum(fields[6]),
      // 腾讯返回的是万元 → 转元；解析失败则忽略
      turnover: (() => {
        const v = safeNum(fields[37]);
        return v == null ? undefined : v * 10000;
      })(),
    };
  }

  private async fetchEastmoneyKline(
    meta: IndexMeta,
    startDate: string,
    endDate: string
  ): Promise<DailyQuote[]> {
    const params = new URLSearchParams({
      secid: meta.eastmoney_secid,
      ut: "fa5fd1943c7b386f172d6893dbfba10b",
      fields1: "f1,f2,f3,f4,f5",
      // f51=date f52=open f53=close f54=high f55=low f56=volume(手) f57=turnover(元) f58=amplitude
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
      klt: "101", // 日线
      fqt: "0",
      beg: dateToCompact(startDate),
      end: dateToCompact(endDate),
      _: String(Date.now()),
    });
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: { klines?: string[]; name?: string };
    };
    const klines = json.data?.klines ?? [];
    const out: DailyQuote[] = [];
    for (const line of klines) {
      // "2026-05-09,open,close,high,low,volume,turnover,amplitude,..."
      const parts = line.split(",");
      if (parts.length < 3) continue;
      const tradeDate = parts[0];
      const close = parseFloat(parts[2]);
      if (!tradeDate || !Number.isFinite(close)) continue;

      const safeNum = (idx: number): number | undefined => {
        const v = parts[idx];
        if (v == null || v === "") return undefined;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : undefined;
      };
      out.push({
        index_code: meta.index_code,
        index_name: meta.index_name,
        trade_date: tradeDate,
        close_value: close,
        open_value: safeNum(1),
        high_value: safeNum(3),
        low_value: safeNum(4),
        volume: safeNum(5),
        turnover: safeNum(6),
      });
    }
    return out;
  }
}

export const defaultProvider: QuoteProvider = new TencentEastmoneyProvider();
