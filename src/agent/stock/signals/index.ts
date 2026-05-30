import { getQuotesInRange, getLatestQuote, type IndexQuoteRow } from "../db/index.js";
import { getLhbForIndex } from "../providers/lhb.js";

/**
 * 本地异动信号计算（不依赖外部 API）。
 *
 * 输入：单只指数 index_code
 * 输出：量比、高量低波、跳空缺口、连涨连跌、RSI、龙虎榜等异动信号
 */

export interface AnomalySignals {
  trade_date: string;
  volume_ratio: number | null;
  is_high_volume: boolean;
  is_low_volume: boolean;
  abnormal_silent: boolean;
  lhb_active: boolean;
  lhb_count: number;
  lhb_net_amount: number;
  /** 近期缺口描述 */
  gap_note: string;
  /** 连涨/连跌天数 */
  streak_count: number;
  streak_direction: "up" | "down" | "flat";
  /** RSI(14) 最新值 */
  rsi: number | null;
  /** 20日 realized volatility */
  realized_volatility: number | null;
  notes: string[];
}

function avgVolume(rows: IndexQuoteRow[]): number | null {
  const vs = rows.map((r) => r.volume).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (vs.length === 0) return null;
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function rsiLatest(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function findRecentGap(rows: IndexQuoteRow[]): string {
  if (rows.length < 3) return "无足够数据";
  for (let i = rows.length - 1; i >= 1; i--) {
    const today = rows[i];
    const prev = rows[i - 1];
    if (today.high_value == null || prev.low_value == null || today.low_value == null || prev.high_value == null) continue;
    if (today.low_value > prev.high_value) {
      const gap = today.low_value - prev.high_value;
      return `${today.trade_date} 向上缺口 ${gap.toFixed(2)} 点`;
    }
    if (today.high_value < prev.low_value) {
      const gap = prev.low_value - today.high_value;
      return `${today.trade_date} 向下缺口 ${gap.toFixed(2)} 点`;
    }
  }
  return "近期无显著缺口";
}

function consecutiveDays(rows: IndexQuoteRow[]): { direction: "up" | "down" | "flat"; count: number } {
  if (rows.length < 2) return { direction: "flat", count: 0 };
  let dir: "up" | "down" | "flat" = "flat";
  let count = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    const chg = rows[i].change_pct ?? 0;
    const currDir = chg > 0.01 ? "up" : chg < -0.01 ? "down" : "flat";
    if (count === 0) {
      dir = currDir;
      count = 1;
      continue;
    }
    if (currDir === dir || (Math.abs(chg) <= 0.01 && dir !== "flat")) {
      count++;
    } else {
      break;
    }
  }
  return { direction: dir, count };
}

function realizedVolatility(rows: IndexQuoteRow[], days = 20): number | null {
  const pcts = rows
    .slice(-days)
    .map((r) => r.change_pct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (pcts.length < 5) return null;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pcts.length;
  return Math.sqrt(variance);
}

export function computeAnomalySignals(indexCode: string): AnomalySignals {
  const latest = getLatestQuote(indexCode);
  if (!latest) {
    return {
      trade_date: "",
      volume_ratio: null,
      is_high_volume: false,
      is_low_volume: false,
      abnormal_silent: false,
      lhb_active: false,
      lhb_count: 0,
      lhb_net_amount: 0,
      gap_note: "<无行情数据>",
      streak_count: 0,
      streak_direction: "flat",
      rsi: null,
      realized_volatility: null,
      notes: ["<无行情数据，无法计算异动>"],
    };
  }

  const trade_date = latest.trade_date;
  const startNatural = (() => {
    const d = new Date(trade_date);
    d.setUTCDate(d.getUTCDate() - 50); // 自然日 50 天 → 大致取到 30 个交易日
    return d.toISOString().slice(0, 10);
  })();
  const endBefore = (() => {
    const d = new Date(trade_date);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const recent = getQuotesInRange(indexCode, startNatural, endBefore).slice(-30);
  const mean = avgVolume(recent);
  const todayVol = latest.volume;
  const ratio = mean != null && todayVol != null && mean > 0 ? todayVol / mean : null;

  const is_high_volume = ratio != null && ratio > 1.5;
  const is_low_volume = ratio != null && ratio < 0.7;
  const todayChgAbs = latest.change_pct != null ? Math.abs(latest.change_pct) : 0;
  const abnormal_silent = is_high_volume && todayChgAbs < 1.0;

  // 技术指标
  const allRecent = getQuotesInRange(indexCode, startNatural, trade_date);
  const closes = allRecent.map((r) => r.close_value).filter((v): v is number => Number.isFinite(v));
  const gap_note = findRecentGap(allRecent);
  const streak = consecutiveDays(allRecent);
  const rsi = rsiLatest(closes);
  const rv = realizedVolatility(allRecent, 20);

  // 龙虎榜异动（用最近一天 lhb 数据；如果当日还没出，会拿不到）
  let lhb_active = false;
  let lhb_count = 0;
  let lhb_net_amount = 0;
  try {
    const lhb = getLhbForIndex(trade_date, indexCode);
    if (lhb.count > 0) {
      lhb_active = true;
      lhb_count = lhb.count;
      lhb_net_amount = lhb.net_amount_sum;
    }
  } catch {
    // 龙虎榜数据缺失不阻塞
  }

  const notes: string[] = [];
  if (ratio != null) {
    notes.push(
      `量比 ${ratio.toFixed(2)}（今日 ${(todayVol! / 1e8).toFixed(2)}亿手 / 近30日均 ${(mean! / 1e8).toFixed(2)}亿手）`
    );
  } else {
    notes.push("量比 = 缺失（近 30 日均量数据不足）");
  }
  if (is_high_volume) notes.push("⚠ 显著放量");
  if (is_low_volume) notes.push("⚠ 显著缩量");
  if (abnormal_silent) {
    notes.push(
      `⚠ 量价背离：高量但当日 chg% 仅 ${latest.change_pct?.toFixed(2)}% — 疑似有人在静默吸筹/出货`
    );
  }
  notes.push(`缺口: ${gap_note}`);
  if (streak.count >= 3) {
    notes.push(
      `⚠ 连续${streak.direction === "up" ? "上涨" : "下跌"}${streak.count}天 — 均值回归风险上升`
    );
  }
  if (rsi != null) {
    notes.push(`RSI(14)=${rsi.toFixed(1)}${rsi > 70 ? " (超买)" : rsi < 30 ? " (超卖)" : ""}`);
  }
  if (rv != null) {
    notes.push(`20日 realized vol=${rv.toFixed(3)}%`);
  }
  if (lhb_active) {
    notes.push(
      `龙虎榜：${lhb_count} 只成分股上榜，净买入合计 ${(lhb_net_amount / 1e8).toFixed(2)}亿`
    );
  } else {
    notes.push("龙虎榜：当日无成分股上榜（或数据未到）");
  }

  return {
    trade_date,
    volume_ratio: ratio,
    is_high_volume,
    is_low_volume,
    abnormal_silent,
    lhb_active,
    lhb_count,
    lhb_net_amount,
    gap_note,
    streak_count: streak.count,
    streak_direction: streak.direction,
    rsi,
    realized_volatility: rv,
    notes,
  };
}
