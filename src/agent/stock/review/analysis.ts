import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  getPrediction,
  getQuote,
  upsertAnalysis,
  type PredictionReviewRow,
  type IndexPredictionRow,
} from "../db/index.js";
import { logStage } from "../utils/log.js";
import { createKimiCliInvoke } from "../prediction/kimi-cli-invoke.js";

/**
 * AI 预测准确率分析（P3 实现）。
 *
 * 工作原理：对每一条已 review 的预测（已有 actual），让 LLM 基于：
 *   - 预测时的 prompt（多维度数据快照）
 *   - 预测结果（方向 / 涨跌幅 / 区间 / 置信度 / rationale）
 *   - 实际结果（方向 / 涨跌幅）
 * 分析：
 *   1. 预测准确还是不准确
 *   2. 如果准确：哪些维度的判断起到了关键作用
 *   3. 如果不准确：哪些信号被忽视 / 误读，有什么突发因素
 *
 * 幂等：每次都重新覆盖（分析模型升级时可吸收）。
 */

// ==================== Schema ====================

const AnalysisOutputSchema = z.object({
  is_accurate: z.boolean(),
  analysis_summary: z.string().min(1).max(300),
  key_factors: z.array(z.string()).max(5),
  missed_signals: z.array(z.string()).max(5),
});

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

// ==================== LLM ====================

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: process.env.KIMI_MODEL ?? "kimi-k2.6",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1" },
    temperature: process.env.KIMI_MODEL?.includes("k2.6") ? 1 : 0.2,
    maxTokens: 2048,
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

export type LlmInvokeFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

// ==================== Prompts ====================

const ANALYSIS_SYSTEM = `你是 A 股预测复盘分析助手。你的任务是基于预测时的输入数据、预测结果和实际收盘结果，分析预测"为什么准"或"为什么不准"。

输出严格 JSON 格式：
{
  "is_accurate": true | false,
  "analysis_summary": "≤200字中文，核心结论",
  "key_factors": ["起关键作用的维度或事件", ...],
  "missed_signals": ["被忽视的信号", ...]
}

判断规则：
- is_accurate = true：当且仅当方向命中（up/down 与实际一致）且幅度误差 < 1.0%
- is_accurate = false：方向不中，或方向虽中但幅度误差 ≥ 1.0%

分析要求：
1. analysis_summary 必须引用具体的预测数字和实际数字（如"预测+0.5%，实际+1.2%"）
2. key_factors：列出 1-3 个对预测结果影响最大的维度（如"新闻事件利好被正确捕捉"、"量能放大配合趋势"）
3. missed_signals：列出 1-3 个被忽视或误读的信号（如"忽略了期货深度贴水警告"、"龙虎榜资金流出未被重视"）
4. 如果预测准确，missed_signals 可为空数组 []
5. 所有字符串值内部 MUST NOT 包含未转义的英文双引号

只输出 JSON，不要 Markdown 代码块。`;

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

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function buildAnalysisUserPrompt(
  pred: IndexPredictionRow,
  review: PredictionReviewRow,
  promptSnapshot: string | null
): string {
  const parts: string[] = [];

  parts.push(`========== 预测结果 ==========`);
  parts.push(`指数: ${pred.index_code}`);
  parts.push(`目标日: ${pred.target_date}`);
  parts.push(`预测方向: ${pred.direction}`);
  parts.push(`预测涨跌幅: ${fmtPct(pred.predicted_change_pct)}`);
  parts.push(`预测区间: ${fmtPct(pred.predicted_change_pct_low ?? null)} ~ ${fmtPct(pred.predicted_change_pct_high ?? null)}`);
  parts.push(`置信度: ${pred.confidence != null ? (pred.confidence * 100).toFixed(0) + "%" : "-"}`);
  parts.push(`预测理由: ${pred.rationale ?? "-"}`);
  parts.push(`使用维度数: ${pred.dimensions_used ?? "-"}/10`);
  if (pred.signals_json) {
    try {
      const signals = JSON.parse(pred.signals_json);
      parts.push(`各维度信号: ${JSON.stringify(signals)}`);
    } catch {
      // ignore
    }
  }
  parts.push("");

  parts.push(`========== 实际结果 ==========`);
  parts.push(`实际方向: ${review.actual_direction}`);
  parts.push(`实际涨跌幅: ${fmtPct(review.actual_pct)}`);
  parts.push(`方向命中: ${review.direction_hit === 1 ? "是" : "否"}`);
  parts.push(`区间命中: ${review.range_hit === 1 ? "是" : review.range_hit === 0 ? "否" : "无区间"}`);
  parts.push(`幅度绝对误差: ${review.pct_abs_error != null ? review.pct_abs_error.toFixed(2) + "%" : "-"}`);
  parts.push("");

  parts.push(`========== 预测时的输入数据（prompt 摘要）==========`);
  if (promptSnapshot) {
    // prompt 可能很长，取前 4000 字符保证不爆 token
    parts.push(promptSnapshot.slice(0, 4000));
  } else {
    parts.push("（预测时未保存 prompt 快照）");
  }
  parts.push("");

  parts.push(`========== 任务 ==========`);
  parts.push("请基于以上信息，分析这次预测为什么准确或不准确。");
  parts.push("重点关注：哪些维度的判断是对的，哪些被忽视了，有什么突发因素。");

  return parts.join("\n");
}

// ==================== 主流程 ====================

export interface AnalysisResult {
  index_code: string;
  target_date: string;
  analyzed: boolean;
  is_accurate: boolean;
  analysis_summary: string;
}

export interface AnalyzeOptions {
  llmInvoke?: LlmInvokeFn;
}

/**
 * 对单条预测进行 AI 准确率分析。
 * 需要 pred、review 已存在，且 review 有 actual 数据。
 */
export async function analyzePrediction(
  indexCode: string,
  targetDate: string,
  opts: AnalyzeOptions = {}
): Promise<AnalysisResult> {
  const pred = getPrediction(indexCode, targetDate);
  if (!pred) {
    logStage({ stage: "analysis.no_prediction", ok: false, indexCode, targetDate });
    return { index_code: indexCode, target_date: targetDate, analyzed: false, is_accurate: false, analysis_summary: "" };
  }

  // 从 review 表中取 actual 数据
  const { getReview } = await import("../db/index.js");
  const review = getReview(indexCode, targetDate);
  if (!review || review.actual_pct == null) {
    logStage({ stage: "analysis.no_actual", ok: false, indexCode, targetDate });
    return { index_code: indexCode, target_date: targetDate, analyzed: false, is_accurate: false, analysis_summary: "" };
  }

  const userPrompt = buildAnalysisUserPrompt(pred, review, pred.prompt_text ?? null);
  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;

  let raw = "";
  try {
    raw = await llmInvoke(ANALYSIS_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "analysis.llm_failed",
      ok: false,
      indexCode,
      targetDate,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (raw) {
    logStage({
      stage: "analysis.llm_raw",
      ok: true,
      indexCode,
      targetDate,
      raw_length: raw.length,
      raw_preview: raw.slice(0, 300),
    });
  }

  const fallback: AnalysisOutput = {
    is_accurate: review.direction_hit === 1 && (review.pct_abs_error ?? 999) < 1.0,
    analysis_summary:
      review.direction_hit === 1
        ? `方向命中（预测${pred.direction}，实际${review.actual_direction}），幅度误差${fmtPct(review.pct_abs_error)}。`
        : `方向未命中（预测${pred.direction}，实际${review.actual_direction}），幅度误差${fmtPct(review.pct_abs_error)}。`,
    key_factors: [],
    missed_signals: [],
  };

  const parsed = raw ? safeParseJson(raw, AnalysisOutputSchema, fallback) : fallback;

  // 规范化 is_accurate（兜底逻辑与 LLM 可能不同，以规则为准）
  const normalizedAccurate = review.direction_hit === 1 && (review.pct_abs_error ?? 999) < 1.0;

  upsertAnalysis({
    index_code: indexCode,
    target_date: targetDate,
    is_accurate: normalizedAccurate ? 1 : 0,
    analysis_summary: parsed.analysis_summary,
    key_factors: parsed.key_factors.length > 0 ? JSON.stringify(parsed.key_factors) : null,
    missed_signals: parsed.missed_signals.length > 0 ? JSON.stringify(parsed.missed_signals) : null,
    prompt_snapshot: pred.prompt_text?.slice(0, 2000) ?? null,
    model: process.env.KIMI_MODEL ?? "kimi-k2.6",
    analyzed_at: new Date().toISOString(),
  });

  logStage({
    stage: "analysis.done",
    ok: true,
    indexCode,
    targetDate,
    is_accurate: normalizedAccurate,
    summary_length: parsed.analysis_summary.length,
  });

  return {
    index_code: indexCode,
    target_date: targetDate,
    analyzed: true,
    is_accurate: normalizedAccurate,
    analysis_summary: parsed.analysis_summary,
  };
}

/**
 * 批量分析某指数在 [start, end] 区间内所有已 review 的预测。
 */
export async function analyzePredictionsForIndex(
  indexCode: string,
  start: string,
  end?: string,
  opts: AnalyzeOptions = {}
): Promise<AnalysisResult[]> {
  const endDate = end ?? new Date().toISOString().slice(0, 10);
  const { getReviewsInRange } = await import("../db/index.js");
  const reviews = getReviewsInRange(indexCode, start, endDate);

  const out: AnalysisResult[] = [];
  for (const review of reviews) {
    // 只分析有 actual 数据的
    if (review.actual_pct == null) continue;
    try {
      const r = await analyzePrediction(review.index_code, review.target_date, opts);
      out.push(r);
    } catch (e) {
      logStage({
        stage: "analysis.single_failed",
        ok: false,
        indexCode: review.index_code,
        targetDate: review.target_date,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/**
 * 分析所有目标指数最近 N 天已 review 的预测，默认 90 天。
 */
export async function analyzeRecentPredictions(
  days = 90,
  opts: AnalyzeOptions = {}
): Promise<AnalysisResult[]> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const { listTargetIndexes } = await import("../providers/index.js");
  const out: AnalysisResult[] = [];
  for (const meta of listTargetIndexes()) {
    const results = await analyzePredictionsForIndex(meta.index_code, startStr, endStr, opts);
    out.push(...results);
  }
  return out;
}
