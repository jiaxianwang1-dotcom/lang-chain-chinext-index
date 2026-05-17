import {
  getDb,
  upsertLotteryDraw,
  getLotteryDrawsInRange,
  getLatestLotteryDraw,
  type LotteryDrawRow,
} from "../stock/db/index.js";
import { todayShanghai } from "../stock/realtime/range.js";

// ==================== 彩票规则常量 ====================

export const LOTTERY_CONFIG = {
  daletou: {
    name: "大乐透",
    redCount: 5,
    redRange: [1, 35] as [number, number],
    blueCount: 2,
    blueRange: [1, 12] as [number, number],
    drawDays: [1, 3, 6] as number[], // 周一、三、六
  },
  shuangseqiu: {
    name: "双色球",
    redCount: 6,
    redRange: [1, 33] as [number, number],
    blueCount: 1,
    blueRange: [1, 16] as [number, number],
    drawDays: [2, 4, 0] as number[], // 周二、四、日
  },
} as const;

export type LotteryType = keyof typeof LOTTERY_CONFIG;

// ==================== 模拟历史数据生成 ====================
// 用于首次启动时填充数据库，使演示可立即运行。
// 真实场景可替换为对接中国体彩/福彩官方 API。

function generateRandomBalls(count: number, min: number, max: number): number[] {
  const pool = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  // Fisher-Yates shuffle 取前 count 个
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

function getDrawDayDates(daysOfWeek: number[], endDate: string, count: number): string[] {
  const dates: string[] = [];
  const end = new Date(`${endDate}T00:00:00Z`);
  let d = new Date(end);
  while (dates.length < count) {
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ...
    if (daysOfWeek.includes(dow)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.reverse();
}

export function seedLotteryHistory(opts?: { days?: number; endDate?: string }): void {
  const endDate = opts?.endDate ?? todayShanghai();
  const days = opts?.days ?? 90;

  for (const [type, cfg] of Object.entries(LOTTERY_CONFIG)) {
    const existing = getLatestLotteryDraw(type);
    if (existing) continue; // 已有数据则跳过

    const dates = getDrawDayDates(cfg.drawDays, endDate, Math.ceil(days / 7 * cfg.drawDays.length));
    let periodBase = 25000;
    for (const date of dates) {
      periodBase++;
      const red = generateRandomBalls(cfg.redCount, cfg.redRange[0], cfg.redRange[1]);
      const blue = generateRandomBalls(cfg.blueCount, cfg.blueRange[0], cfg.blueRange[1]);
      upsertLotteryDraw({
        lottery_type: type as LotteryType,
        draw_date: date,
        draw_period: String(periodBase),
        red_balls: JSON.stringify(red),
        blue_balls: JSON.stringify(blue),
      });
    }
  }
}

// ==================== 数据查询 ====================

export function getLotteryHistory(type: LotteryType, startDate: string, endDate: string): LotteryDrawRow[] {
  return getLotteryDrawsInRange(type, startDate, endDate);
}

export function getLatestLotteryDrawSafe(type: LotteryType): LotteryDrawRow | null {
  return getLatestLotteryDraw(type);
}

// ==================== 统计分析（用于 AI Prompt）====================

export interface BallFrequency {
  number: number;
  count: number;
}

export interface LotteryStats {
  totalDraws: number;
  redFrequencies: BallFrequency[];
  blueFrequencies: BallFrequency[];
  hotReds: number[]; // 出现次数最多的前 8 个
  coldReds: number[]; // 出现次数最少的前 8 个
  hotBlues: number[];
  coldBlues: number[];
  oddEvenRatio: { odd: number; even: number }; // 红球奇偶占比
  bigSmallRatio: { big: number; small: number }; // 红球大小占比（大乐透: >17, 双色球: >16）
  consecutiveRate: number; // 连号出现比例
  zoneDistribution: [number, number, number]; // 三个区间分布计数
  recentDraws: LotteryDrawRow[];
}

function countFrequencies(draws: LotteryDrawRow[], extractor: (d: LotteryDrawRow) => number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const d of draws) {
    for (const n of extractor(d)) {
      map.set(n, (map.get(n) ?? 0) + 1);
    }
  }
  return map;
}

function toFreqArray(map: Map<number, number>, range: [number, number]): BallFrequency[] {
  const result: BallFrequency[] = [];
  for (let n = range[0]; n <= range[1]; n++) {
    result.push({ number: n, count: map.get(n) ?? 0 });
  }
  return result.sort((a, b) => b.count - a.count);
}

export function computeLotteryStats(type: LotteryType, draws: LotteryDrawRow[]): LotteryStats {
  const cfg = LOTTERY_CONFIG[type];
  const redFreq = countFrequencies(draws, (d) => JSON.parse(d.red_balls) as number[]);
  const blueFreq = countFrequencies(draws, (d) => JSON.parse(d.blue_balls) as number[]);

  const redFreqArr = toFreqArray(redFreq, cfg.redRange);
  const blueFreqArr = toFreqArray(blueFreq, cfg.blueRange);

  const hotReds = redFreqArr.slice(0, 8).map((f) => f.number);
  const coldReds = redFreqArr.slice(-8).map((f) => f.number);
  const hotBlues = blueFreqArr.slice(0, 5).map((f) => f.number);
  const coldBlues = blueFreqArr.slice(-5).map((f) => f.number);

  // 奇偶比
  let odd = 0;
  let even = 0;
  for (const d of draws) {
    for (const n of JSON.parse(d.red_balls) as number[]) {
      if (n % 2 === 1) odd++;
      else even++;
    }
  }

  // 大小比
  const mid = type === "daletou" ? 17 : 16;
  let big = 0;
  let small = 0;
  for (const d of draws) {
    for (const n of JSON.parse(d.red_balls) as number[]) {
      if (n > mid) big++;
      else small++;
    }
  }

  // 连号率
  let consecutiveCount = 0;
  for (const d of draws) {
    const reds = JSON.parse(d.red_balls) as number[];
    let hasConsecutive = false;
    for (let i = 1; i < reds.length; i++) {
      if (reds[i] === reds[i - 1] + 1) {
        hasConsecutive = true;
        break;
      }
    }
    if (hasConsecutive) consecutiveCount++;
  }

  // 三区分布（大乐透: 1-12, 13-24, 25-35; 双色球: 1-11, 12-22, 23-33）
  const zoneSize = type === "daletou" ? 12 : 11;
  const zones: [number, number, number] = [0, 0, 0];
  for (const d of draws) {
    for (const n of JSON.parse(d.red_balls) as number[]) {
      if (n <= zoneSize) zones[0]++;
      else if (n <= zoneSize * 2) zones[1]++;
      else zones[2]++;
    }
  }

  return {
    totalDraws: draws.length,
    redFrequencies: redFreqArr,
    blueFrequencies: blueFreqArr,
    hotReds,
    coldReds,
    hotBlues,
    coldBlues,
    oddEvenRatio: { odd, even },
    bigSmallRatio: { big, small },
    consecutiveRate: draws.length > 0 ? consecutiveCount / draws.length : 0,
    zoneDistribution: zones,
    recentDraws: draws.slice(-10),
  };
}

// ==================== Prompt 数据格式化 ====================

export function formatDrawsForPrompt(draws: LotteryDrawRow[]): string {
  return draws
    .map((d) => {
      const reds = JSON.parse(d.red_balls) as number[];
      const blues = JSON.parse(d.blue_balls) as number[];
      return `  ${d.draw_date} [${d.draw_period ?? "?"}]: 红球/前区 ${reds.join(", ")} | 蓝球/后区 ${blues.join(", ")}`;
    })
    .join("\n");
}

export function formatStatsForPrompt(stats: LotteryStats, type: LotteryType): string {
  const cfg = LOTTERY_CONFIG[type];
  const totalRedBalls = stats.totalDraws * cfg.redCount;
  const totalBlueBalls = stats.totalDraws * cfg.blueCount;

  return `
【统计摘要】（基于最近 ${stats.totalDraws} 期开奖数据）

1. 热号（出现频次最高）:
   - 红球/前区 Top8: ${stats.hotReds.join(", ")}
   - 蓝球/后区 Top5: ${stats.hotBlues.join(", ")}

2. 冷号（出现频次最低）:
   - 红球/前区 Bottom8: ${stats.coldReds.join(", ")}
   - 蓝球/后区 Bottom5: ${stats.coldBlues.join(", ")}

3. 奇偶比（红球/前区）:
   - 奇数: ${stats.oddEvenRatio.odd} (${((stats.oddEvenRatio.odd / totalRedBalls) * 100).toFixed(1)}%)
   - 偶数: ${stats.oddEvenRatio.even} (${((stats.oddEvenRatio.even / totalRedBalls) * 100).toFixed(1)}%)

4. 大小比（红球/前区）:
   - 大号(>${type === "daletou" ? 17 : 16}): ${stats.bigSmallRatio.big} (${((stats.bigSmallRatio.big / totalRedBalls) * 100).toFixed(1)}%)
   - 小号(≤${type === "daletou" ? 17 : 16}): ${stats.bigSmallRatio.small} (${((stats.bigSmallRatio.small / totalRedBalls) * 100).toFixed(1)}%)

5. 连号出现率: ${(stats.consecutiveRate * 100).toFixed(1)}%（${stats.totalDraws}期中${Math.round(stats.consecutiveRate * stats.totalDraws)}期出现连号）

6. 三区分布（红球/前区）:
   - 一区(${type === "daletou" ? "1-12" : "1-11"}): ${stats.zoneDistribution[0]} (${((stats.zoneDistribution[0] / totalRedBalls) * 100).toFixed(1)}%)
   - 二区(${type === "daletou" ? "13-24" : "12-22"}): ${stats.zoneDistribution[1]} (${((stats.zoneDistribution[1] / totalRedBalls) * 100).toFixed(1)}%)
   - 三区(${type === "daletou" ? "25-35" : "23-33"}): ${stats.zoneDistribution[2]} (${((stats.zoneDistribution[2] / totalRedBalls) * 100).toFixed(1)}%)

7. 最近10期详细开奖号码:
${formatDrawsForPrompt(stats.recentDraws)}
`;
}
