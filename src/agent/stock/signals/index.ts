import { getQuotesInRange, getLatestQuote, type IndexQuoteRow } from "../db/index.js";
import { getLhbForIndex } from "../providers/lhb.js";

/**
 * 本地异动信号计算（不依赖外部 API）。
 *
 * 输入：单只指数 index_code
 * 输出：
 *   - volume_ratio: 当日 volume / 近 30 日均 volume
 *   - is_high_volume: volume_ratio > 1.5
 *   - is_low_volume: volume_ratio < 0.7
 *   - abnormal_silent: 高量但 |chg%| < 1.0  → "有人在动但价格没怎么动"
 *   - lhb_active: 当日龙虎榜中影响该指数的成分股数量 > 0
 *   - lhb_net_amount: 影响该指数的成分股净买入合计
 *   - notes: 文字描述（用于直接拼到 prompt）
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
  notes: string[];
}

function avgVolume(rows: IndexQuoteRow[]): number | null {
  const vs = rows.map((r) => r.volume).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (vs.length === 0) return null;
  return vs.reduce((a, b) => a + b, 0) / vs.length;
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
    notes,
  };
}
