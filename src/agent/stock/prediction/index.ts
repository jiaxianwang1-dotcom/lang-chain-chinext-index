import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  appendMemory,
  getLatestMemory,
  getLatestQuote,
  getQuotesInRange,
  getMarginInRange,
  getBreadthInRange,
  getLatestSectorRotation,
  getLatestExternalProxy,
  getExternalProxyInRange,
  getLatestFuturesBasis,
  getNewsInRange,
  getActiveNews,
  type AnalysisMemoryRow,
  type IndexQuoteRow,
  type MarginBalanceRow,
  type MarketBreadthRow,
  type SectorQuoteRow,
  type ExternalProxyRow,
  type FuturesBasisRow,
  type MacroCalendarRow,
} from "../db/index.js";
import { findIndexMeta, listTargetIndexes } from "../providers/index.js";
import { getLhbForIndex } from "../providers/lhb.js";
import { computeAnomalySignals, type AnomalySignals } from "../signals/index.js";
import { getTodayNewsEvents, classifyTodayNews } from "../news/index.js";
import { getMacroEventsAround, ensureRecentMacroSeed } from "../providers/macro.js";
import { logStage } from "../utils/log.js";
import { todayShanghai } from "../realtime/range.js";
import { createKimiCliInvoke } from "./kimi-cli-invoke.js";

// ==================== Schemas ====================

const FeaturesSchema = z.record(z.unknown());
const MemoryShapeSchema = z.object({
  summary: z.string().min(1),
  features: FeaturesSchema,
});

const PredictionSchema = z.object({
  direction: z.enum(["up", "down"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  updated_memory: MemoryShapeSchema,
});

const DirectPredictionSchema = z.object({
  direction: z.enum(["up", "down"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

const SignalLeanEnum = z.enum(["up", "down", "neutral", "missing"]);
const MagnitudeBucketEnum = z.enum(["small", "medium", "large"]);

const MultiSignalPredictionSchema = z.object({
  direction: z.enum(["up", "down"]),
  confidence: z.number().min(0).max(1),
  /** P0：预测涨跌幅中位数（带符号 %）。例如 +0.85 表示预测上涨 0.85%。 */
  predicted_change_pct: z.number().min(-10).max(10).optional(),
  /** P0：预测涨跌幅区间下界。 */
  predicted_change_pct_low: z.number().min(-10).max(10).optional(),
  /** P0：预测涨跌幅区间上界。 */
  predicted_change_pct_high: z.number().min(-10).max(10).optional(),
  /** P0：档位。small<0.5% / medium 0.5~1.5% / large>=1.5%（绝对值）。 */
  magnitude_bucket: MagnitudeBucketEnum.optional(),
  rationale: z.string().min(1),
  signals: z
    .object({
      trend: SignalLeanEnum.optional(),
      volume: SignalLeanEnum.optional(),
      fund_flow: SignalLeanEnum.optional(),
      breadth: SignalLeanEnum.optional(),
      sector: SignalLeanEnum.optional(),
      lhb: SignalLeanEnum.optional(),
      news: SignalLeanEnum.optional(),
      macro: SignalLeanEnum.optional(),
      external: SignalLeanEnum.optional(),
      futures: SignalLeanEnum.optional(),
    })
    .optional(),
});

export type Prediction = z.infer<typeof PredictionSchema>;
export type DirectPrediction = z.infer<typeof DirectPredictionSchema>;
export type MultiSignalPrediction = z.infer<typeof MultiSignalPredictionSchema>;
export type MagnitudeBucket = z.infer<typeof MagnitudeBucketEnum>;

export interface PredictionResult {
  index_code: string;
  index_name: string;
  direction: "up" | "down";
  confidence: number;
  rationale: string;
  as_of_date: string;
  version: number;
  /** 实际入 prompt 的维度数（满分 10） */
  dimensions_used?: number;
  /** 各维度倾向 */
  signals?: Record<string, "up" | "down" | "neutral" | "missing">;
  /** P0：预测涨跌幅中位数（带符号 %）。例如 +0.85 表示预测上涨 0.85%。 */
  predicted_change_pct?: number;
  predicted_change_pct_low?: number;
  predicted_change_pct_high?: number;
  magnitude_bucket?: MagnitudeBucket;
}

// ==================== LLM ====================

export type LlmInvokeFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: process.env.KIMI_MODEL ?? "kimi-k2.6",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1" },
    temperature: process.env.KIMI_MODEL?.includes("k2.6") ? 1 : 0.2,
  });
  return _defaultLlm;
}

let _kimiCliInvoke: ReturnType<typeof createKimiCliInvoke> | null = null;

async function defaultInvokeLlm(systemPrompt: string, userPrompt: string): Promise<string> {
  if (process.env.USE_KIMI_CLI === "true") {
    if (!_kimiCliInvoke) {
      _kimiCliInvoke = createKimiCliInvoke({
        cliPath: process.env.KIMI_CLI_PATH,
        timeoutMs: process.env.KIMI_CLI_TIMEOUT_MS
          ? parseInt(process.env.KIMI_CLI_TIMEOUT_MS, 10)
          : 120_000,
      });
    }
    return _kimiCliInvoke(systemPrompt, userPrompt);
  }

  const llm = getDefaultLlm();
  const res = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

// ==================== Prompts ====================

const BOOTSTRAP_SYSTEM = `你是 A 股大盘趋势研究助手。基于过去 1 年的日线数据（含每日涨跌原因），生成一份"长期分析记忆"，供后续每日预测复用。
要求：
1) summary: ≤ 400 字中文，覆盖三个维度：趋势（上行/震荡/下行）、波动（量级/节奏）、关键宏观因素（政策、海外、行业）。
2) features: JSON 对象，结构自定义但建议包含 latest_close / 250d_high / 250d_low / volatility_pct / dominant_themes / risk_signals 等。
3) 严格输出 JSON：{"summary": "...", "features": {...}}。不要 Markdown，不要解释字段。`;

const PREDICT_SYSTEM = `你是 A 股大盘趋势预测助手。
你将得到：上一份长期分析记忆 + 上次记忆之后到今天的新增日线（含原因）。
任务：判断"下一交易日"的方向（买涨/买跌），并产出 updated_memory（合并旧记忆 + 新数据后的新一版记忆）。
要求：
1) direction: "up" 表示买涨，"down" 表示买跌。
2) confidence: 0~1 的小数，不要极端值（除非证据非常充分）。
3) rationale: ≤ 150 字中文，引用最近 1-3 天关键事件或趋势变化。
4) updated_memory: { summary, features }，与 bootstrap 同口径。
5) 严格输出 JSON：{"direction":"up","confidence":0.xx,"rationale":"...","updated_memory":{"summary":"...","features":{...}}}。
6) 不构成投资建议，但请基于数据给出结论，不要含糊。`;

const PREDICT_DIRECT_SYSTEM = `你是 A 股大盘短线方向判断助手。
输入：某只指数最近若干个交易日的真实日线，每行包含：
date / open / high / low / close / chg% / volume / reason
其中 volume 是当日成交量（已格式化为亿手/万手等）。reason 是当日盘后归因（可能为空或"无显著公开事件"）。

任务：基于上述 OHLCV + 归因做"实时分析"（技术面 + 资金面），判断"下一交易日"是"买涨"还是"买跌"，并给出置信度。

硬性纪律：
- 你只能引用上面表格里**实际出现**的数字。表格里没有的字段（例如 MACD、北向资金、换手率），**禁止编造**。
- 如果某行 volume 或 OHLC 是 "-"，说明该字段缺失，**不要假装它有值**。
- 不要给"中立 / 震荡 / 看不清"的结论；direction 必须二选一。

输出要求：
1) direction: "up"=买涨 / "down"=买跌，**必须二选一**。
2) confidence: 0~1 的小数。基于数据信号清晰度：
   - 信号非常明确（连续 3+ 日同向放量、突破前高/前低并伴随放量、收盘穿越关键均线且量能配合）→ 0.75-0.92
   - 中性偏向某方向（例如 K 线连阳但量能温和） → 0.6-0.75
   - 数据混乱、量价背离不明显 → 0.5-0.6
   **不要为了"显得谨慎"刻意压低**，也不要给 1.0。
3) rationale: ≤ 220 字中文。**必须**引用：
   (a) 最近 1-3 日的具体收盘点位与涨跌幅；
   (b) 量能变化（用表格中的 volume 字段，例如"5/8 量能 4.07亿手 较 5/7 的 3.21亿手 放大约 27%"）；
   (c) 至少一条来自 reason 列的真实事件，或一条来自 OHLC 的形态（如"5/9 高 4185 低 4150 收 4180，长下影"）。
   禁止泛泛之词如"震荡上行""市场情绪改善"。
4) 严格输出 JSON：{"direction":"up","confidence":0.xx,"rationale":"..."}。不要 Markdown，不要解释字段。`;

export function buildMultiSignalSystemPrompt(indexName = "大盘"): string {
  const prefix = indexName === "上证指数" || indexName === "大盘" ? "A 股大盘" : indexName;
  return `你是 ${prefix}短线方向 + 涨跌幅判断助手（多信号模式 v2）。

你将收到 **最多 10 个维度**的真实数据用于分析"下一交易日"方向（"up"=买涨 / "down"=买跌）以及预测涨跌幅区间：

【维度 1：价格趋势】近 30 日 OHLCV 明细 + 60/90 日统计摘要
【维度 2：量能】当日量比、近 30 日均量、量价配合
【维度 3：资金面】两融余额（融资净买入近 5 日序列，T-1 滞后）
【维度 4：市场广度】沪深创三市当日 涨/跌/平 家数 + 涨停数
【维度 5：行业轮动】当日涨幅榜板块 Top5 + 跌幅榜 Bottom5
【维度 6：龙虎榜异动】当日影响该指数的成分股净买入合计 + Top 3 个股
【维度 7：当日新闻事件】已经按 (category / sentiment / impact) 结构化分类的事件列表
【维度 8：宏观日历】近邻（前 7 天 / 后 5 天）的重大宏观事件，含 CN/US 数据公布日
【维度 9：外资情绪代理】CNH 离岸人民币 / 恒生指数 / 沪深 300 ETF / 创业板 ETF 当日表现（**注意：北向资金 2024-08 起停止公开，这里用代理指标替代**）
【维度 10：股指期货升贴水】IF/IH/IC/IM 主力连续合约相对现货的 basis 与 basis_pct（升水=机构看多远期 / 贴水=机构看空远期）

============ 硬性纪律（违反则视为不合格输出）============

A. **禁止编造**：你只能引用上述 10 维数据中**实际出现的数字与文本**。如果某维度被标注 "<数据缺失>"，rationale 中 MUST NOT 编造该维度的数字。
B. **direction 必须二选一**：不允许中立 / 震荡 / 看不清。
C. **维度覆盖**：rationale ≤ 280 字，**至少引用 4 个不同维度**的具体证据，且每条证据必须包含具体数字或专有名词（例：板块名 / 股票名 / 事件标题片段）。
D. **维度冲突时降低置信度**：当多个维度方向相反（例如价格上涨但融资资金净流出 + 当日新闻偏负面）时，confidence MUST 在 [0.55, 0.65]，且 rationale 必须明确指出"维度冲突"或"分歧"。
E. **置信度梯度**：
   - 多维度（≥ 5）一致同向 + 信号明确 → 0.75–0.90
   - 多维度一致但信号温和 → 0.65–0.75
   - 主导维度不足 / 冲突 → 0.55–0.65
   - 数据混乱 / 缺维度 ≥ 4 → 0.50–0.60
   不允许 0.95+ 极端值，也不允许刻意压低到 0.5 以下。

============ 涨跌幅与档位（P0 v2 新增） ============

F. **predicted_change_pct**: 带符号小数，单位 %。需与 direction 一致（up>0，down<0）。
   A 股指数单日 95% 概率落在 ±2.5%，超过 ±3% 必须由"维度 6 龙虎榜爆量 / 维度 4 涨停潮 / 维度 7 重大事件"明确支撑。
G. **区间预测**: predicted_change_pct_low 与 predicted_change_pct_high 给出 ~70% 置信区间。
   规则：区间宽度 = max(0.4, 1.2 - confidence)，例如 confidence=0.75 → 宽度 ≈ 0.45%。
   方向是 up 时：low ≥ -0.3，high > predicted_change_pct；
   方向是 down 时：high ≤ +0.3，low < predicted_change_pct。
   low 必须严格 ≤ high。
H. **magnitude_bucket**: 按 |predicted_change_pct| 判档位：
   |x| < 0.5%  → "small"
   0.5% ≤ |x| < 1.5% → "medium"
   |x| ≥ 1.5% → "large"

============ "异动信号"专项提醒 ============

- 量比 > 1.5 + 当日 |chg%| < 1.0 → "高量低波"，可能有人在静默吸筹/出货，需结合龙虎榜判断方向
- 量比 > 1.5 + 指数明显上行 → 放量上行，趋势加强信号
- 量比 < 0.7 + 微跌 → 缩量调整，下跌动能不足
- 龙虎榜净买入 > 50 亿（全市场成分） + 集中某板块 → 机构看好该板块，与维度 5 行业轮动交叉验证
- 期货深度贴水（IF/IC basis_pct < -0.8%）→ 机构悲观，倾向下行
- 期货明显升水（basis_pct > +0.3%）→ 机构看多，倾向上行
- CNH 走强（人民币贬值）→ 外资倾向流出，谨慎
- 恒指当日 +1% 以上 → 港股领涨往往传导到 A 股次日

============ 输出格式（严格 JSON，不要 Markdown）============

⚠️ 严禁复制下面的示例数值！confidence / predicted_change_pct / low / high 必须根据上文真实数据独立计算，每次输出都应不同。

{
  "direction": "up" | "down",
  "confidence": 0.xx,
  "predicted_change_pct": 0.yy,
  "predicted_change_pct_low": 0.zz,
  "predicted_change_pct_high": 0.ww,
  "magnitude_bucket": "small" | "medium" | "large",
  "rationale": "≤280 字中文，必须引用 4+ 维度的具体数字/专名",
  "signals": {
    "trend":     "up"|"down"|"neutral"|"missing",
    "volume":    "up"|"down"|"neutral"|"missing",
    "fund_flow": "up"|"down"|"neutral"|"missing",
    "breadth":   "up"|"down"|"neutral"|"missing",
    "sector":    "up"|"down"|"neutral"|"missing",
    "lhb":       "up"|"down"|"neutral"|"missing",
    "news":      "up"|"down"|"neutral"|"missing",
    "macro":     "up"|"down"|"neutral"|"missing",
    "external":  "up"|"down"|"neutral"|"missing",
    "futures":   "up"|"down"|"neutral"|"missing"
  }
}

signals 中每个维度必须真实反映你对该维度的判断；data 缺失时填 "missing"。`;
}

export const PREDICT_MULTI_SIGNAL_SYSTEM = buildMultiSignalSystemPrompt();

// ==================== Helpers ====================

function safeParseJson<T>(raw: string, schema: z.ZodSchema<T>, fallback: T): T {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/, "").trim(),
    (trimmed.match(/\{[\s\S]*\}/) ?? [""])[0],
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return schema.parse(JSON.parse(c));
    } catch {
      // try next
    }
  }
  return fallback;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

/** 把成交量（手）转成易读单位：< 1 亿 显示原值；≥ 1 亿 显示 X.XX亿手；≥ 1 万亿 显示 X.XX万亿手 */
function fmtVolume(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "万亿手";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return Math.round(v).toString() + "手";
}

function formatQuotesAsTable(rows: IndexQuoteRow[], limit = 80): string {
  // 太长会撑爆 prompt，回填阶段限制行数（取最近若干日 + 关键节点）
  const tail = rows.slice(-limit);
  // 列：日期 | 开 | 高 | 低 | 收 | 涨跌% | 量 | 原因
  const header = "date\topen\thigh\tlow\tclose\tchg%\tvolume\treason";
  const body = tail
    .map((r) => {
      const reason = (r.change_reason ?? "").replace(/\s+/g, " ").slice(0, 70);
      return [
        r.trade_date,
        fmtNum(r.open_value),
        fmtNum(r.high_value),
        fmtNum(r.low_value),
        fmtNum(r.close_value),
        r.change_pct == null ? "-" : (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%",
        fmtVolume(r.volume),
        reason,
      ].join("\t");
    })
    .join("\n");
  return `${header}\n${body}`;
}

// ==================== Bootstrap ====================

export interface PredictionOptions {
  llmInvoke?: LlmInvokeFn;
}

export async function bootstrapPredictionMemory(
  indexCode: string,
  opts: PredictionOptions = {}
): Promise<AnalysisMemoryRow> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new Error(`未知 index_code: ${indexCode}`);

  const latest = getLatestQuote(indexCode);
  if (!latest) throw new Error(`${indexCode} 无任何行情数据，无法 bootstrap`);

  // 取近 1 年（最多 260 个交易日）
  const start = (() => {
    const d = new Date(latest.trade_date);
    d.setUTCDate(d.getUTCDate() - 365);
    return d.toISOString().slice(0, 10);
  })();
  const all = getQuotesInRange(indexCode, start, latest.trade_date);

  const userPrompt = [
    `指数: ${meta.index_name} (${meta.index_code})`,
    `数据起止: ${all[0]?.trade_date ?? "-"} ~ ${latest.trade_date}`,
    `共 ${all.length} 个交易日。`,
    `近期日线（最多 80 行）:`,
    formatQuotesAsTable(all),
  ].join("\n");

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(BOOTSTRAP_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "predict.bootstrap_llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const parsed = safeParseJson(raw, MemoryShapeSchema, {
    summary: `（兜底）${meta.index_name} 近 1 年趋势数据已归档，待后续观察。`,
    features: {
      latest_close: latest.close_value,
      data_points: all.length,
    },
  });

  const memory = appendMemory(indexCode, latest.trade_date, parsed.summary, parsed.features);
  logStage({ stage: "predict.bootstrap_done", indexCode, ok: true, version: memory.version });
  return memory;
}

// ==================== 多维度数据组装 ====================

function daysBefore(date: string, n: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function quantile(arr: number[], q: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function formatLongWindowSummary(rows: IndexQuoteRow[], windowName: string): string {
  if (rows.length === 0) return `[${windowName}] <数据缺失>`;
  const closes = rows.map((r) => r.close_value).filter((v) => v != null) as number[];
  const vols = rows.map((r) => r.volume).filter((v) => v != null && v > 0) as number[];
  const last = closes[closes.length - 1];
  const first = closes[0];
  const max = Math.max(...closes);
  const min = Math.min(...closes);
  const median = quantile(closes, 0.5);
  const cumPct = first > 0 ? ((last - first) / first) * 100 : 0;
  // 当前点位的分位数
  const sortedClosesAsc = [...closes].sort((a, b) => a - b);
  const rank = sortedClosesAsc.findIndex((v) => v >= last);
  const percentile = rank < 0 ? 100 : (rank / sortedClosesAsc.length) * 100;
  const meanVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : null;

  const parts = [
    `[${windowName} ${rows[0].trade_date}~${rows[rows.length - 1].trade_date}, ${rows.length} 个交易日]`,
    `close: max ${max.toFixed(2)} / min ${min.toFixed(2)} / median ${median?.toFixed(2)} / 当前 ${last.toFixed(2)}`,
    `当前点位分位: ${percentile.toFixed(0)}%`,
    `区间累计 ${cumPct >= 0 ? "+" : ""}${cumPct.toFixed(2)}%`,
  ];
  if (meanVol != null) {
    parts.push(`均量: ${fmtVolume(meanVol)}`);
  }
  return parts.join(" | ");
}

function formatMargin5Day(margins: MarginBalanceRow[]): string {
  if (margins.length === 0) return "<两融数据缺失>";
  const lines = ["date\t融资余额(亿)\t融资净买入(亿)\t融券余额(亿)"];
  for (const m of margins.slice(-5)) {
    lines.push(
      [
        m.trade_date,
        m.finance_balance != null ? (m.finance_balance / 1e8).toFixed(0) : "-",
        m.finance_net != null ? (m.finance_net >= 0 ? "+" : "") + (m.finance_net / 1e8).toFixed(2) : "-",
        m.short_balance != null ? (m.short_balance / 1e8).toFixed(0) : "-",
      ].join("\t")
    );
  }
  // 累计 5 日净买
  const sumNet = margins
    .slice(-5)
    .map((m) => m.finance_net ?? 0)
    .reduce((a, b) => a + b, 0);
  lines.push(`近 5 日累计融资净买入: ${sumNet >= 0 ? "+" : ""}${(sumNet / 1e8).toFixed(2)}亿`);
  return lines.join("\n");
}

function formatBreadth5Day(rows: MarketBreadthRow[]): string {
  if (rows.length === 0) return "<广度数据缺失>";
  // 按 trade_date 分组
  const byDate = new Map<string, MarketBreadthRow[]>();
  for (const r of rows) {
    const arr = byDate.get(r.trade_date) ?? [];
    arr.push(r);
    byDate.set(r.trade_date, arr);
  }
  const dates = [...byDate.keys()].sort().slice(-5);
  const lines = ["date\t上证(涨/跌/平/涨停)\t深证(涨/跌/平/涨停)\t创业板(涨/跌/平/涨停)"];
  for (const d of dates) {
    const groups = byDate.get(d) ?? [];
    const fmt = (s: string) => {
      const x = groups.find((g) => g.scope === s);
      if (!x) return "-";
      return `${x.advancing ?? "-"}/${x.declining ?? "-"}/${x.unchanged ?? "-"}/${x.limit_up ?? "-"}`;
    };
    lines.push(`${d}\t${fmt("sse")}\t${fmt("szse")}\t${fmt("chinext")}`);
  }
  return lines.join("\n");
}

function formatSectorTopBottom(rows: SectorQuoteRow[]): string {
  if (rows.length === 0) return "<板块数据缺失>";
  const top = rows.filter((r) => r.rank_type === "top5").sort((a, b) => a.rank_pos - b.rank_pos);
  const bot = rows.filter((r) => r.rank_type === "bottom5").sort((a, b) => a.rank_pos - b.rank_pos);
  const lines: string[] = [];
  lines.push(
    "涨幅 Top5: " +
      top
        .map((r) => `${r.sector_name}+${r.change_pct?.toFixed(2)}%`)
        .join(" / ")
  );
  lines.push(
    "跌幅 Bottom5: " +
      bot
        .map((r) => `${r.sector_name}${r.change_pct?.toFixed(2)}%`)
        .join(" / ")
  );
  return lines.join("\n");
}

function formatLhbSummary(
  date: string,
  indexCode: string
): string {
  try {
    const r = getLhbForIndex(date, indexCode);
    if (r.count === 0) return "<当日无影响该指数的龙虎榜个股（或数据未到）>";
    const sign = r.net_amount_sum >= 0 ? "+" : "";
    const lines = [
      `${date} 影响该指数的龙虎榜成分股: ${r.count} 只，净买入合计 ${sign}${(r.net_amount_sum / 1e8).toFixed(2)}亿`,
    ];
    for (const t of r.top_3) {
      lines.push(
        `  - ${t.code} ${t.name} 净额 ${t.net_amount >= 0 ? "+" : ""}${(t.net_amount / 1e8).toFixed(2)}亿  原因: ${(t.explanation ?? "").slice(0, 40)}`
      );
    }
    return lines.join("\n");
  } catch {
    return "<龙虎榜数据缺失>";
  }
}

function formatNewsToday(asOfDate: string): string {
  const today = todayShanghai();

  // 1. [lastTradingDate, today] 范围内的新事件（覆盖上一交易日收盘后到当前的所有新闻）
  const rangeEvents = getNewsInRange(asOfDate, today, 20);

  // 2. 仍在有效期内的历史大事件（impact_days > 1，跨天持续影响）
  const activeEvents = getActiveNews(today, 20);

  // 3. 合并去重：按 title，保留最新 as_of_date 的版本
  const byTitle = new Map<string, ReturnType<typeof getTodayNewsEvents>[number]>();
  for (const e of [...rangeEvents, ...activeEvents]) {
    const existing = byTitle.get(e.title);
    if (!existing || e.as_of_date > existing.as_of_date) {
      byTitle.set(e.title, e);
    }
  }

  // 4. 按 sentiment 绝对值降序，取前 15 条（避免 prompt 过长）
  const events = Array.from(byTitle.values())
    .sort((a, b) => Math.abs(b.sentiment ?? 0) - Math.abs(a.sentiment ?? 0))
    .slice(0, 15);

  if (events.length === 0) return "<无相关新闻事件>";
  const lines: string[] = [];
  for (const e of events) {
    const s = e.sentiment != null ? (e.sentiment >= 0 ? "+" : "") + e.sentiment.toFixed(2) : "0";
    const dayTag = e.as_of_date === today ? "" : ` (${e.as_of_date})`;
    lines.push(`[${e.category} ${s} ${e.impact_indices ?? "-"}]${dayTag} ${e.title}`);
    if (e.rationale) lines.push(`  ↳ ${e.rationale}`);
  }
  return lines.join("\n");
}

function formatAnomalyNotes(s: AnomalySignals): string {
  return s.notes.map((n) => "  - " + n).join("\n");
}

function inferBucket(absPct: number): MagnitudeBucket {
  if (absPct < 0.5) return "small";
  if (absPct < 1.5) return "medium";
  return "large";
}

/**
 * 规范化 LLM 输出：保证 direction / predicted_change_pct / range / bucket 自洽。
 *
 * 规则：
 *   1. 若缺 predicted_change_pct：用 (direction==up ? +0.4 : -0.4) 兜底
 *   2. predicted_change_pct 与 direction 符号需一致；不一致时取符号校正
 *   3. low/high 缺失则按 confidence 推算区间宽度
 *   4. magnitude_bucket 缺失或与 |pct| 不匹配则按 inferBucket 重算
 */
export function normalizeMultiSignalPrediction(p: MultiSignalPrediction): MultiSignalPrediction {
  // 检测 prompt 示例值污染：LLM 直接复制了示例中的 0.85
  if (p.predicted_change_pct === 0.85 && p.confidence === 0.78) {
    logStage({
      stage: "predict.prompt_value_pollution_detected",
      ok: false,
      warning: "LLM 疑似复制了 prompt 示例值 (predicted_change_pct=0.85, confidence=0.78)",
    });
  }

  let pct = p.predicted_change_pct;
  if (pct == null || !Number.isFinite(pct)) {
    pct = p.direction === "up" ? 0.4 : -0.4;
  }
  // 方向校正
  if (p.direction === "up" && pct < 0) pct = Math.abs(pct);
  if (p.direction === "down" && pct > 0) pct = -Math.abs(pct);

  // 区间
  const halfWidth = Math.max(0.2, (1.2 - Math.min(0.95, Math.max(0.5, p.confidence))) / 2);
  let low = p.predicted_change_pct_low;
  let high = p.predicted_change_pct_high;
  if (low == null || high == null || !Number.isFinite(low) || !Number.isFinite(high)) {
    low = pct - halfWidth;
    high = pct + halfWidth;
  }
  if (low > high) [low, high] = [high, low];
  // 区间必须夹住 pct
  if (pct < low) low = pct;
  if (pct > high) high = pct;

  const bucket = inferBucket(Math.abs(pct));

  return {
    ...p,
    predicted_change_pct: Number(pct.toFixed(3)),
    predicted_change_pct_low: Number(low.toFixed(3)),
    predicted_change_pct_high: Number(high.toFixed(3)),
    magnitude_bucket: bucket,
  };
}

interface MultiSignalContext {
  indexCode: string;
  indexName: string;
  asOfDate: string;
  windowDays: number;
  recent30: IndexQuoteRow[];
  earliest30: string;
  margin30: MarginBalanceRow[];
  breadth30: MarketBreadthRow[];
  sector: SectorQuoteRow[];
  signals: AnomalySignals;
  /** 维度 8：宏观日历（前 7 后 5） */
  macroEvents: MacroCalendarRow[];
  /** 维度 9：外资代理（最新一日） */
  externalProxy: ExternalProxyRow[];
  /** 维度 9：CNH 近 3 日序列（用于看趋势） */
  externalCnhRecent: ExternalProxyRow[];
  /** 维度 10：股指期货升贴水（最新一日） */
  futuresBasis: FuturesBasisRow[];
  dimensionsAvailable: number;
}

export function gatherMultiSignalContext(
  indexCode: string,
  windowDays: number
): MultiSignalContext {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new Error(`未知 index_code: ${indexCode}`);
  const latest = getLatestQuote(indexCode);
  if (!latest) throw new Error(`${indexCode} 无任何行情数据，无法预测`);

  const startNatural = daysBefore(latest.trade_date, Math.ceil(windowDays * 1.6));
  const recent30 = getQuotesInRange(indexCode, startNatural, latest.trade_date).slice(-windowDays);
  if (recent30.length === 0) throw new Error(`${indexCode} 区间内无行情数据，无法预测`);

  const earliest30 = recent30[0].trade_date;

  // 维度 3：两融（取 30 自然日范围）
  const margin30 = getMarginInRange(daysBefore(latest.trade_date, 45), latest.trade_date);
  // 维度 4：广度（取 7 自然日，确保拿到近 5 个交易日）
  const breadth30 = getBreadthInRange(daysBefore(latest.trade_date, 10), latest.trade_date);
  // 维度 5：板块（最近一日）
  const sector = getLatestSectorRotation();
  // 维度 7：异动（含 lhb_active）
  const signals = computeAnomalySignals(indexCode);

  // 维度 8：宏观日历（自动补种子，确保最少有启发式事件）
  try {
    ensureRecentMacroSeed(latest.trade_date);
  } catch {
    // 启发式失败不阻塞
  }
  const macroEvents = getMacroEventsAround(latest.trade_date);

  // 维度 9：外资代理（最新 + 近 3 日 CNH 序列）
  const externalProxy = getLatestExternalProxy();
  const externalCnhRecent = getExternalProxyInRange(
    daysBefore(latest.trade_date, 7),
    latest.trade_date
  ).filter((r) => r.symbol === "CNH");

  // 维度 10：股指期货升贴水
  const futuresBasis = getLatestFuturesBasis();

  // 计数：trend(总有) + volume(总有) + 7 个外部维度
  let dims = 2; // trend + volume
  if (margin30.length > 0) dims += 1;
  if (breadth30.length > 0) dims += 1;
  if (sector.length > 0) dims += 1;
  if (signals.lhb_active) dims += 1;
  const today = todayShanghai();
  // 新闻维度：覆盖 [lastTradingDate, today] 新事件 + 仍在有效期内的历史大事件
  const rangeNews = getNewsInRange(latest.trade_date, today, 1);
  const activeNews = getActiveNews(today, 1);
  const hasNewsToday = rangeNews.length > 0 || activeNews.length > 0;
  if (hasNewsToday) dims += 1;
  if (macroEvents.length > 0) dims += 1;
  if (externalProxy.length > 0) dims += 1;
  if (futuresBasis.length > 0) dims += 1;

  return {
    indexCode,
    indexName: meta.index_name,
    asOfDate: latest.trade_date,
    windowDays: recent30.length,
    recent30,
    earliest30,
    margin30,
    breadth30,
    sector,
    signals,
    macroEvents,
    externalProxy,
    externalCnhRecent,
    futuresBasis,
    dimensionsAvailable: dims,
  };
}

function formatMacroEvents(events: MacroCalendarRow[], asOfDate: string): string {
  if (events.length === 0) return "<近邻宏观事件：数据缺失或近期无重大事件>";
  const lines = [`date\timportance\tcountry\tevent\tactual/expectation`];
  for (const e of events.slice(0, 12)) {
    const rel = e.event_date === asOfDate
      ? "(今日)"
      : e.event_date < asOfDate
      ? "(已发布)"
      : "(待发布)";
    const ae = e.actual ?? e.expectation ?? "-";
    lines.push(
      [
        `${e.event_date}${rel}`,
        "★".repeat(e.importance),
        e.country ?? "-",
        e.event_name,
        ae,
      ].join("\t")
    );
  }
  return lines.join("\n");
}

function formatExternalProxy(
  latest: ExternalProxyRow[],
  cnhRecent: ExternalProxyRow[]
): string {
  if (latest.length === 0) return "<外资代理：数据缺失。提示：北向资金已停止披露，建议运行 ingestExternalProxies()>";
  const byKey = new Map(latest.map((r) => [r.symbol, r]));
  const cnh = byKey.get("CNH");
  const hsi = byKey.get("HSI");
  const hstech = byKey.get("HSTECH");
  const etf300 = byKey.get("510300");
  const etfCyb = byKey.get("159915");

  const fmtPct = (v: number | null | undefined): string =>
    v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const fmtVal = (v: number | null | undefined, digits = 2): string =>
    v == null ? "-" : v.toFixed(digits);

  const lines: string[] = [];
  if (cnh) {
    lines.push(
      `离岸人民币 CNH: ${fmtVal(cnh.close_value, 4)} (当日 ${fmtPct(cnh.change_pct)})  ※ CNH 走弱(↓)意味外资进场成本下降`
    );
  }
  if (cnhRecent.length >= 2) {
    const seq = cnhRecent
      .slice(-3)
      .map((r) => `${r.trade_date.slice(5)}=${fmtVal(r.close_value, 4)}`)
      .join(" → ");
    lines.push(`CNH 近 3 日: ${seq}`);
  }
  if (hsi) lines.push(`恒生指数 HSI: ${fmtVal(hsi.close_value)} (${fmtPct(hsi.change_pct)})`);
  if (hstech)
    lines.push(`恒生科技 HSTECH: ${fmtVal(hstech.close_value)} (${fmtPct(hstech.change_pct)})`);
  if (etf300)
    lines.push(`沪深 300 ETF (510300): ${fmtVal(etf300.close_value)} (${fmtPct(etf300.change_pct)})`);
  if (etfCyb)
    lines.push(`创业板 ETF (159915): ${fmtVal(etfCyb.close_value)} (${fmtPct(etfCyb.change_pct)})`);
  if (lines.length === 0) return "<外资代理：数据缺失>";
  return lines.join("\n");
}

function formatFuturesBasis(rows: FuturesBasisRow[]): string {
  if (rows.length === 0) return "<股指期货升贴水：数据缺失>";
  const lines = [`contract\t合约代码\t期货收盘\t现货收盘\tbasis\tbasis_pct\t信号`];
  for (const r of rows) {
    let sig = "中性";
    if (r.basis_pct != null) {
      if (r.basis_pct > 0.3) sig = "明显升水(看多)";
      else if (r.basis_pct < -0.8) sig = "深度贴水(看空)";
      else if (r.basis_pct < -0.3) sig = "温和贴水(谨慎)";
    }
    lines.push(
      [
        r.contract,
        r.contract_code ?? "-",
        r.futures_close?.toFixed(2) ?? "-",
        r.spot_close?.toFixed(2) ?? "-",
        r.basis == null ? "-" : (r.basis >= 0 ? "+" : "") + r.basis.toFixed(2),
        r.basis_pct == null ? "-" : (r.basis_pct >= 0 ? "+" : "") + r.basis_pct.toFixed(3) + "%",
        sig,
      ].join("\t")
    );
  }
  return lines.join("\n");
}

export function buildMultiSignalUserPrompt(ctx: MultiSignalContext): string {
  // 60/90 日摘要（如果数据够）
  const longWindowStart60 = daysBefore(ctx.asOfDate, 90);
  const longWindowStart90 = daysBefore(ctx.asOfDate, 130);
  const win60 = getQuotesInRange(ctx.indexCode, longWindowStart60, ctx.asOfDate);
  const win90 = getQuotesInRange(ctx.indexCode, longWindowStart90, ctx.asOfDate);

  const sections: string[] = [];
  sections.push(`========== 当前指数 ==========`);
  sections.push(`${ctx.indexName} (${ctx.indexCode})  截至: ${ctx.asOfDate}`);
  sections.push(`数据窗口: ${ctx.earliest30} ~ ${ctx.asOfDate}, 共 ${ctx.windowDays} 个交易日（详细明细）`);
  sections.push("");

  sections.push(`========== 维度 1：价格趋势（30 日明细 + 长窗摘要）==========`);
  sections.push(formatQuotesAsTable(ctx.recent30, ctx.windowDays));
  sections.push("");
  sections.push(formatLongWindowSummary(win60, "近 60 日"));
  sections.push(formatLongWindowSummary(win90, "近 90 日"));
  sections.push("");

  sections.push(`========== 维度 2/7：当日量能 + 异动信号 ==========`);
  sections.push(formatAnomalyNotes(ctx.signals));
  sections.push("");

  sections.push(`========== 维度 3：资金面（两融余额，T-1 滞后）==========`);
  sections.push(formatMargin5Day(ctx.margin30));
  sections.push("");

  sections.push(`========== 维度 4：市场广度（沪/深/创 涨跌平 + 涨停数）==========`);
  sections.push(formatBreadth5Day(ctx.breadth30));
  sections.push("");

  sections.push(`========== 维度 5：行业轮动（当日板块涨跌榜）==========`);
  sections.push(formatSectorTopBottom(ctx.sector));
  sections.push("");

  sections.push(`========== 维度 6：龙虎榜异动（影响该指数的成分股）==========`);
  sections.push(formatLhbSummary(ctx.asOfDate, ctx.indexCode));
  sections.push("");

  sections.push(`========== 维度 7：当日已分类新闻事件 ==========`);
  sections.push(formatNewsToday(ctx.asOfDate));
  sections.push("");

  sections.push(`========== 维度 8：宏观日历（近邻事件） ==========`);
  sections.push(formatMacroEvents(ctx.macroEvents, ctx.asOfDate));
  sections.push("");

  sections.push(`========== 维度 9：外资情绪代理（替代北向资金） ==========`);
  sections.push(formatExternalProxy(ctx.externalProxy, ctx.externalCnhRecent));
  sections.push("");

  sections.push(`========== 维度 10：股指期货升贴水 ==========`);
  sections.push(formatFuturesBasis(ctx.futuresBasis));
  sections.push("");

  sections.push(`========== 任务 ==========`);
  sections.push(
    `基于以上 10 维真实数据判断"下一交易日"方向（buy=up / buy=down）并预测涨跌幅。`
  );
  sections.push(
    `rationale 必须引用至少 4 个不同维度的具体数字/专名；维度冲突时降低 confidence；维度缺失（标注 <数据缺失>）的字段不准编造。`
  );
  sections.push(
    `predicted_change_pct 与 direction 必须方向一致；predicted_change_pct_low ≤ predicted_change_pct ≤ predicted_change_pct_high。`
  );
  sections.push(
    `magnitude_bucket 按 |predicted_change_pct| 判档位：<0.5%=small / 0.5~1.5%=medium / ≥1.5%=large。`
  );
  sections.push(
    `signals 字段每项必须诚实反映你对该维度的判断，缺失数据填 "missing"。`
  );

  return sections.join("\n");
}

// ==================== Predict next ====================

export interface PredictNextOptions extends PredictionOptions {
  /** 喂给模型的最近交易日条数，默认 30。*/
  windowDays?: number;
  /** 是否使用多信号模式（默认 true）。设 false 退回旧版单维度 prompt。 */
  multiSignal?: boolean;
}

/**
 * 多信号实时分析：在原 OHLCV + 归因基础上，额外整合两融 / 广度 / 板块 / 龙虎榜 /
 * 当日新闻事件 / 异动信号共 7 个维度喂给 LLM。任一维度缺失都不阻塞，仅降级。
 *
 * 不读取 `index_analysis_memory` 中的旧记忆作为输入。
 * 预测结果（含 signals / dimensions_used）写入 `index_analysis_memory.features.last_prediction`。
 */
export async function predictNextTradingDay(
  indexCode: string,
  opts: PredictNextOptions = {}
): Promise<PredictionResult> {
  const windowDays = opts.windowDays ?? 30;
  const useMulti = opts.multiSignal !== false;

  // === 旧版单维度路径（仅用于回归测试 / 显式降级）===
  if (!useMulti) {
    return predictDirectLegacy(indexCode, opts, windowDays);
  }

  // 预测前若当日新闻为空，自动触发采集（非交易日/首次运行时常缺失）
  const latestQuote = getLatestQuote(indexCode);
  if (latestQuote) {
    const today = todayShanghai();
    const tradeDate = latestQuote.trade_date;
    // 新闻是实时的，按自然日检查；非交易日时 today 可能晚于 tradeDate
    const newsDate = today > tradeDate ? today : tradeDate;
    const existingNews = getTodayNewsEvents(newsDate, 1);
    if (existingNews.length === 0) {
      logStage({ stage: "predict.news_empty_auto_classify", ok: true, indexCode, newsDate });
      try {
        await classifyTodayNews(newsDate);
      } catch (e) {
        logStage({ stage: "predict.news_auto_classify_failed", ok: false, indexCode, newsDate, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const ctx = gatherMultiSignalContext(indexCode, windowDays);
  const userPrompt = buildMultiSignalUserPrompt(ctx);

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(buildMultiSignalSystemPrompt(ctx.indexName), userPrompt);
  } catch (e) {
    logStage({
      stage: "predict.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 调试：LLM 返回了内容但解析失败时，把原始输出记入日志
  if (raw) {
    logStage({
      stage: "predict.llm_raw",
      indexCode,
      ok: true,
      raw_length: raw.length,
      raw_preview: raw.slice(0, 200),
    });
  }

  const lastDay = ctx.recent30[ctx.recent30.length - 1];
  const lastPct = lastDay.change_pct ?? 0;
  const fallback: MultiSignalPrediction = {
    direction: lastPct >= 0 ? "up" : "down",
    confidence: 0.5,
    predicted_change_pct: lastPct >= 0 ? 0.3 : -0.3,
    predicted_change_pct_low: lastPct >= 0 ? -0.1 : -0.7,
    predicted_change_pct_high: lastPct >= 0 ? 0.7 : 0.1,
    magnitude_bucket: "small",
    rationale: "（兜底）LLM 不可用或解析失败，按最近一日方向给出弱信号。",
    signals: {
      trend: "missing",
      volume: "missing",
      fund_flow: "missing",
      breadth: "missing",
      sector: "missing",
      lhb: "missing",
      news: "missing",
      macro: "missing",
      external: "missing",
      futures: "missing",
    },
  };
  const parsed = raw ? safeParseJson(raw, MultiSignalPredictionSchema, fallback) : fallback;
  if (parsed === fallback && raw) {
    logStage({
      stage: "predict.parse_failed",
      indexCode,
      ok: false,
      raw_preview: raw.slice(0, 300),
    });
  }
  const normalized = normalizeMultiSignalPrediction(parsed);

  const features: Record<string, unknown> = {
    last_prediction: {
      direction: normalized.direction,
      confidence: normalized.confidence,
      rationale: normalized.rationale,
      predicted_change_pct: normalized.predicted_change_pct,
      predicted_change_pct_low: normalized.predicted_change_pct_low,
      predicted_change_pct_high: normalized.predicted_change_pct_high,
      magnitude_bucket: normalized.magnitude_bucket,
      signals: normalized.signals ?? {},
      dimensions_used: ctx.dimensionsAvailable,
      based_on_trade_date: ctx.asOfDate,
      window_days: ctx.windowDays,
      window_start: ctx.earliest30,
      predicted_at: new Date().toISOString(),
      mode: "multi-signal-v2",
    },
  };
  const summaryBody = `基于 10 维多信号实时分析（${ctx.dimensionsAvailable}/10 维度齐备）：${
    normalized.direction === "up" ? "买涨" : "买跌"
  }（置信度 ${(normalized.confidence * 100).toFixed(1)}%，预测 ${
    normalized.predicted_change_pct != null
      ? (normalized.predicted_change_pct >= 0 ? "+" : "") +
        normalized.predicted_change_pct.toFixed(2) +
        "%"
      : "-"
  }）。${normalized.rationale}`;
  const newMemory = appendMemory(indexCode, ctx.asOfDate, summaryBody, features);

  const result: PredictionResult = {
    index_code: indexCode,
    index_name: ctx.indexName,
    direction: normalized.direction,
    confidence: normalized.confidence,
    rationale: normalized.rationale,
    as_of_date: ctx.asOfDate,
    version: newMemory.version,
    dimensions_used: ctx.dimensionsAvailable,
    signals: normalized.signals,
    predicted_change_pct: normalized.predicted_change_pct,
    predicted_change_pct_low: normalized.predicted_change_pct_low,
    predicted_change_pct_high: normalized.predicted_change_pct_high,
    magnitude_bucket: normalized.magnitude_bucket,
  };
  logStage({
    stage: "predict.done",
    indexCode,
    ok: true,
    direction: result.direction,
    confidence: result.confidence,
    version: result.version,
    dimensions_used: ctx.dimensionsAvailable,
    mode: "multi-signal-30d",
  });
  return result;
}

/** 旧版单维度预测，保留供降级与单元测试。 */
async function predictDirectLegacy(
  indexCode: string,
  opts: PredictNextOptions,
  windowDays: number
): Promise<PredictionResult> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new Error(`未知 index_code: ${indexCode}`);

  const latest = getLatestQuote(indexCode);
  if (!latest) throw new Error(`${indexCode} 无任何行情数据，无法预测`);

  const startNatural = daysBefore(latest.trade_date, Math.ceil(windowDays * 1.6));
  const recent = getQuotesInRange(indexCode, startNatural, latest.trade_date).slice(-windowDays);

  if (recent.length === 0) {
    throw new Error(`${indexCode} 区间内无行情数据，无法预测`);
  }

  const earliest = recent[0].trade_date;
  const userPrompt = [
    `指数: ${meta.index_name} (${meta.index_code})`,
    `数据窗口: ${earliest} ~ ${latest.trade_date}, 共 ${recent.length} 个交易日`,
    `近 ${recent.length} 日行情明细（列含义见 system prompt）：`,
    formatQuotesAsTable(recent, windowDays),
    ``,
    `请基于上述真实 OHLCV + 归因做实时分析，判断下一交易日方向（买涨 / 买跌）。`,
    `必须引用具体收盘点位、涨跌幅、以及表格里实际出现的成交量数字；不准编造表格里没有的指标。`,
  ].join("\n");

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(PREDICT_DIRECT_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "predict.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const fallback: DirectPrediction = {
    direction: latest.change_pct != null && latest.change_pct >= 0 ? "up" : "down",
    confidence: 0.5,
    rationale: "（兜底）LLM 不可用或解析失败，按最近一日方向给出弱信号。",
  };

  const parsed = raw ? safeParseJson(raw, DirectPredictionSchema, fallback) : fallback;

  const features: Record<string, unknown> = {
    last_prediction: {
      direction: parsed.direction,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      based_on_trade_date: latest.trade_date,
      window_days: recent.length,
      window_start: earliest,
      predicted_at: new Date().toISOString(),
      mode: "direct-30d",
    },
  };
  const summaryBody = `基于 ${earliest}~${latest.trade_date} 共 ${recent.length} 个交易日的实时分析：${
    parsed.direction === "up" ? "买涨" : "买跌"
  }（置信度 ${(parsed.confidence * 100).toFixed(1)}%）。${parsed.rationale}`;
  const newMemory = appendMemory(indexCode, latest.trade_date, summaryBody, features);

  return {
    index_code: indexCode,
    index_name: meta.index_name,
    direction: parsed.direction,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    as_of_date: latest.trade_date,
    version: newMemory.version,
  };
}

export async function predictAllTargets(opts: PredictionOptions = {}): Promise<PredictionResult[]> {
  const out: PredictionResult[] = [];
  for (const meta of listTargetIndexes()) {
    out.push(await predictNextTradingDay(meta.index_code, opts));
  }
  return out;
}

/**
 * 多信号 JSON 解析（带兜底），供卡片路径复用。
 */
export function safeParseMultiSignal(
  raw: string,
  fallback: MultiSignalPrediction
): MultiSignalPrediction {
  return safeParseJson(raw, MultiSignalPredictionSchema, fallback);
}

// 暴露给测试
export const _internal = { safeParseJson, formatQuotesAsTable };
