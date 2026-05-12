import { logStage } from "../utils/log.js";
import {
  upsertMacroEvent,
  getMacroEventsInRange,
  type MacroCalendarRow,
} from "../db/index.js";

/**
 * 宏观日历 provider（P1 实现）。
 *
 * 当前阶段为"启发式种子 + 手动维护"模式：把月度高频的 CN/US 数据公布日按月历推算，
 * 落库为 importance=3 的事件；后续可以引入东方财富 economic calendar 或 investing.com
 * 真接口（这两家都有反爬，先用启发式做兜底，保证 prompt 至少有这一段）。
 *
 * 启发式规则（覆盖最常见 6 类事件）：
 *  - CN CPI/PPI: 每月 9-10 日发布上月数据
 *  - CN PMI 制造业: 每月 1 日（次月 1 日发布当月）
 *  - CN PMI 财新: 每月 1-3 日
 *  - US CPI: 每月 10-14 日
 *  - US 非农: 每月第一个周五
 *  - US FOMC 利率决议: 一年 8 次，已知日期写死
 *  - CN LPR: 每月 20 日左右
 *  - 国内重大会议（两会 / 政治局 / 中央经济工作会议）：人工维护
 */

interface SeedSpec {
  /** 给定 year/month，返回该月若干事件（YYYY-MM-DD）。*/
  fn: (year: number, month: number) => Array<Omit<MacroCalendarRow, "created_at" | "updated_at">>;
}

function firstFridayOf(year: number, month: number): string {
  // month: 1-12
  const d = new Date(Date.UTC(year, month - 1, 1));
  const offset = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + offset);
  return d.toISOString().slice(0, 10);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const SEEDS: SeedSpec[] = [
  {
    fn: (y, m) => [
      {
        event_date: ymd(y, m, 9),
        event_code: `cn-cpi-${y}-${String(m).padStart(2, "0")}`,
        event_name: "CN CPI/PPI 数据公布（上月）",
        importance: 3,
        country: "CN",
        expectation: null,
        actual: null,
        notes: "国家统计局，启发式推断日期，实际可能为 9-11 日。",
      },
    ],
  },
  {
    fn: (y, m) => [
      {
        event_date: ymd(y, m, 1),
        event_code: `cn-pmi-${y}-${String(m).padStart(2, "0")}`,
        event_name: "CN 制造业 PMI（统计局）",
        importance: 3,
        country: "CN",
        expectation: null,
        actual: null,
        notes: "次月 1 日发布",
      },
    ],
  },
  {
    fn: (y, m) => [
      {
        event_date: ymd(y, m, 20),
        event_code: `cn-lpr-${y}-${String(m).padStart(2, "0")}`,
        event_name: "CN LPR 报价（贷款市场报价利率）",
        importance: 2,
        country: "CN",
        expectation: null,
        actual: null,
        notes: "每月 20 日左右",
      },
    ],
  },
  {
    fn: (y, m) => [
      {
        event_date: ymd(y, m, 12),
        event_code: `us-cpi-${y}-${String(m).padStart(2, "0")}`,
        event_name: "US CPI 通胀数据",
        importance: 3,
        country: "US",
        expectation: null,
        actual: null,
        notes: "BLS，启发式 10-14 日",
      },
    ],
  },
  {
    fn: (y, m) => [
      {
        event_date: firstFridayOf(y, m),
        event_code: `us-nfp-${y}-${String(m).padStart(2, "0")}`,
        event_name: "US 非农就业报告",
        importance: 3,
        country: "US",
        expectation: null,
        actual: null,
        notes: "每月第一个周五，21:30（北京时间）",
      },
    ],
  },
];

/**
 * 把一段时间窗口内的启发式宏观事件写入 DB（幂等，重复跑不会重复）。
 *
 * @param startMonth YYYY-MM
 * @param endMonth   YYYY-MM
 */
export function seedMacroCalendar(startMonth: string, endMonth: string): number {
  const parse = (s: string): { y: number; m: number } => {
    const [y, m] = s.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) {
      throw new Error(`invalid month: ${s}`);
    }
    return { y, m };
  };
  const start = parse(startMonth);
  const end = parse(endMonth);

  let count = 0;
  for (let y = start.y; y <= end.y; y++) {
    const mStart = y === start.y ? start.m : 1;
    const mEnd = y === end.y ? end.m : 12;
    for (let m = mStart; m <= mEnd; m++) {
      for (const seed of SEEDS) {
        for (const evt of seed.fn(y, m)) {
          upsertMacroEvent(evt);
          count += 1;
        }
      }
    }
  }
  logStage({
    stage: "macro.seed_done",
    ok: true,
    inserted_or_updated: count,
    start: startMonth,
    end: endMonth,
  });
  return count;
}

/**
 * 取以"asOfDate"为锚点的近邻宏观事件：
 *  - 已发生但还在 7 天内的（过去 7 天）
 *  - 未来 5 天内即将发生的
 */
export function getMacroEventsAround(asOfDate: string): MacroCalendarRow[] {
  const d = new Date(asOfDate);
  if (Number.isNaN(d.getTime())) return [];
  const past = new Date(d);
  past.setUTCDate(past.getUTCDate() - 7);
  const future = new Date(d);
  future.setUTCDate(future.getUTCDate() + 5);
  return getMacroEventsInRange(past.toISOString().slice(0, 10), future.toISOString().slice(0, 10));
}

/**
 * 自动确保近 3 个月的种子已写入。低频任务，每次预测前调一次即可。
 */
export function ensureRecentMacroSeed(asOfDate: string): void {
  const d = new Date(asOfDate);
  if (Number.isNaN(d.getTime())) return;
  const back = new Date(d);
  back.setUTCMonth(back.getUTCMonth() - 1);
  const fwd = new Date(d);
  fwd.setUTCMonth(fwd.getUTCMonth() + 2);
  const fmt = (x: Date): string => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
  seedMacroCalendar(fmt(back), fmt(fwd));
}
