import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  appendMemory,
  getLatestMemory,
  getLatestQuote,
  getQuotesInRange,
  type AnalysisMemoryRow,
  type IndexQuoteRow,
} from "../db/index.js";
import { findIndexMeta, listTargetIndexes } from "../providers/index.js";
import { logStage } from "../utils/log.js";

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

export type Prediction = z.infer<typeof PredictionSchema>;

export interface PredictionResult {
  index_code: string;
  index_name: string;
  direction: "up" | "down";
  confidence: number;
  rationale: string;
  as_of_date: string;
  version: number;
}

// ==================== LLM ====================

export type LlmInvokeFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: "glm-4-flash",
    apiKey: process.env.ZHIPU_API_KEY,
    configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
    temperature: 0.2,
  });
  return _defaultLlm;
}

async function defaultInvokeLlm(systemPrompt: string, userPrompt: string): Promise<string> {
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
5) 严格输出 JSON：{"direction":"up","confidence":0.6,"rationale":"...","updated_memory":{"summary":"...","features":{...}}}。
6) 不构成投资建议，但请基于数据给出结论，不要含糊。`;

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

function formatQuotesAsTable(rows: IndexQuoteRow[], limit = 80): string {
  // 太长会撑爆 prompt，回填阶段限制行数（取最近若干日 + 关键节点）
  const tail = rows.slice(-limit);
  return tail
    .map(
      (r) =>
        `${r.trade_date}\tclose=${r.close_value}\tchange_pct=${
          r.change_pct == null ? "-" : r.change_pct.toFixed(2) + "%"
        }\treason=${(r.change_reason ?? "").slice(0, 80)}`
    )
    .join("\n");
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

// ==================== Predict next ====================

export async function predictNextTradingDay(
  indexCode: string,
  opts: PredictionOptions = {}
): Promise<PredictionResult> {
  const meta = findIndexMeta(indexCode);
  if (!meta) throw new Error(`未知 index_code: ${indexCode}`);

  let memory = getLatestMemory(indexCode);
  if (!memory) {
    memory = await bootstrapPredictionMemory(indexCode, opts);
  }

  const latest = getLatestQuote(indexCode);
  if (!latest) throw new Error(`${indexCode} 无任何行情数据，无法预测`);

  // 仅读取 memory.as_of_date 之后的新增日线（不含 as_of_date）
  const newRows = getQuotesInRange(indexCode, memory.as_of_date, latest.trade_date).filter(
    (r) => r.trade_date > memory!.as_of_date
  );

  const userPrompt = [
    `指数: ${meta.index_name} (${meta.index_code})`,
    `当前长期记忆版本: v${memory.version} (as_of_date=${memory.as_of_date})`,
    `--- 上一份长期记忆 ---`,
    `summary: ${memory.summary}`,
    `features: ${memory.features}`,
    `--- 自 ${memory.as_of_date} 之后的新增日线 (${newRows.length} 条) ---`,
    newRows.length ? formatQuotesAsTable(newRows, 200) : "（无新增数据，请基于上一份记忆与最新行情判断）",
    `--- 最新一条行情 ---`,
    `${latest.trade_date} close=${latest.close_value} change_pct=${
      latest.change_pct == null ? "-" : latest.change_pct.toFixed(2) + "%"
    } reason=${(latest.change_reason ?? "").slice(0, 200)}`,
  ].join("\n");

  const llmInvoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await llmInvoke(PREDICT_SYSTEM, userPrompt);
  } catch (e) {
    logStage({
      stage: "predict.llm_failed",
      indexCode,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const fallback: Prediction = {
    direction: latest.change_pct != null && latest.change_pct >= 0 ? "up" : "down",
    confidence: 0.5,
    rationale: "（兜底）LLM 不可用或解析失败，按最近一日方向给出弱信号。",
    updated_memory: {
      summary: memory.summary,
      features: { fallback: true, latest_close: latest.close_value, as_of: latest.trade_date },
    },
  };

  const parsed = raw ? safeParseJson(raw, PredictionSchema, fallback) : fallback;

  // 将本次预测结果（direction/confidence/rationale）随长期记忆一同持久化，
  // 后续 `query_latest_prediction` 才能从 DB 中恢复出方向。
  const enrichedFeatures: Record<string, unknown> = {
    ...parsed.updated_memory.features,
    last_prediction: {
      direction: parsed.direction,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      based_on_trade_date: latest.trade_date,
      predicted_at: new Date().toISOString(),
    },
  };

  const newMemory = appendMemory(
    indexCode,
    latest.trade_date,
    parsed.updated_memory.summary,
    enrichedFeatures
  );

  const result: PredictionResult = {
    index_code: indexCode,
    index_name: meta.index_name,
    direction: parsed.direction,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    as_of_date: latest.trade_date,
    version: newMemory.version,
  };
  logStage({
    stage: "predict.done",
    indexCode,
    ok: true,
    direction: result.direction,
    confidence: result.confidence,
    version: result.version,
  });
  return result;
}

export async function predictAllTargets(opts: PredictionOptions = {}): Promise<PredictionResult[]> {
  const out: PredictionResult[] = [];
  for (const meta of listTargetIndexes()) {
    out.push(await predictNextTradingDay(meta.index_code, opts));
  }
  return out;
}

// 暴露给测试
export const _internal = { safeParseJson, formatQuotesAsTable };
