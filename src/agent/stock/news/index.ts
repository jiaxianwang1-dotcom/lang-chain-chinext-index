import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { insertNewsEventIfAbsent, getNewsByDate, type NewsEventRow } from "../db/index.js";
import { logStage } from "../utils/log.js";

/**
 * 当日新闻事件采集 + LLM 分类。
 *
 * 原则：
 * - 不做常驻爬虫（财联社/东方财富 7x24 反爬严重）
 * - 预测前按需调用 webSearch 抓最近热点，传给 moonshot-v1-32k 做结构化分类
 * - 失败时写空兜底，不阻塞预测主流程
 */

// ==================== Schema ====================

export const NewsCategoryEnum = z.enum([
  "policy_macro",
  "geopolitics",
  "industry_semi",
  "industry_ai",
  "industry_property",
  "industry_energy",
  "industry_finance",
  "market_event",
  "overseas",
  "accident",
  "other",
]);

export type NewsCategory = z.infer<typeof NewsCategoryEnum>;

const ImpactSchema = z.union([
  z.literal("broad"),
  z.string().min(1),      // LLM 经常返回单个指数代码字符串，如 "000001.SH"
  z.array(z.string()).min(1),
]);

const ClassifiedItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional().nullable(),
  category: NewsCategoryEnum,
  sentiment: z.number().min(-1).max(1),
  impact_indices: ImpactSchema,
  rationale: z.string().min(1),
});

const ClassificationOutputSchema = z.object({
  events: z.array(ClassifiedItemSchema),
});

export type ClassifiedItem = z.infer<typeof ClassifiedItemSchema>;

// ==================== LLM ====================

export type LlmInvokeFn = (system: string, user: string) => Promise<string>;

let _defaultLlm: ChatOpenAI | null = null;
function getDefaultLlm(): ChatOpenAI {
  if (_defaultLlm) return _defaultLlm;
  _defaultLlm = new ChatOpenAI({
    model: "moonshot-v1-32k",
    apiKey: process.env.KIMI_API_KEY,
    configuration: { baseURL: "https://api.moonshot.cn/v1" },
    temperature: 0.1,
    maxTokens: 4096,
  });
  return _defaultLlm;
}

async function defaultInvokeLlm(system: string, user: string): Promise<string> {
  const llm = getDefaultLlm();
  const res = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

export type WebSearchFn = (query: string) => Promise<string>;

interface KimiToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

async function kimiWebSearch(query: string): Promise<string> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return "";

  const systemContent =
    "你是一个搜索助手。请使用 web_search 工具搜索用户的问题，然后以纯文本列表形式返回搜索结果。每条结果一行，格式：标题 - 摘要（URL）。只输出结果列表，不要额外解释。";
  const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];

  // ---- Round 1: 请求 tool_calls ----
  let round1: {
    choices?: Array<{
      message?: { content?: string; tool_calls?: KimiToolCall[] };
      finish_reason?: string;
    }>;
  };
  try {
    const res1 = await fetch("https://api.moonshot.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: query },
        ],
        tools,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res1.ok) {
      const body = await res1.text().catch(() => "<failed to read body>");
      logStage({ stage: "news.kimi_http_failed", ok: false, query, status: res1.status, body_preview: body.slice(0, 300) });
      return "";
    }
    round1 = (await res1.json()) as typeof round1;
  } catch (e) {
    logStage({ stage: "news.kimi_search_failed", ok: false, query, error: e instanceof Error ? e.message : String(e) });
    return "";
  }

  const toolCalls = round1.choices?.[0]?.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    // 没有触发 tool_calls，直接返回 content（可能模型直接回答了）
    const direct = round1.choices?.[0]?.message?.content ?? "";
    logStage({ stage: "news.kimi_no_tool_calls", ok: true, query, content_length: direct.length });
    return direct;
  }

  // ---- Round 2: 把 tool_calls 结果传回 ----
  const toolCall = toolCalls[0];
  try {
    const res2 = await fetch("https://api.moonshot.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: query },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: toolCall.id,
                type: toolCall.type,
                function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
              },
            ],
          },
          { role: "tool", tool_call_id: toolCall.id, content: toolCall.function.arguments },
        ],
        tools,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res2.ok) {
      const body = await res2.text().catch(() => "<failed to read body>");
      logStage({ stage: "news.kimi_round2_http_failed", ok: false, query, status: res2.status, body_preview: body.slice(0, 300) });
      return "";
    }
    const round2 = (await res2.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = round2.choices?.[0]?.message?.content ?? "";
    logStage({ stage: "news.kimi_raw", ok: true, query, raw_length: content.length, raw_preview: content.slice(0, 300) });
    // 尽量适配 extractHeadlines 的解析逻辑：把行包装成 【摘要】xxx 格式
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 6 && !l.startsWith("#"))
      .map((l) => l.replace(/^[-•*]\s+/, "")); // 去掉列表标记
    const out = lines.map((l) => `【摘要】${l}`).join("\n");
    logStage({ stage: "news.kimi_parsed", ok: true, query, lines: lines.length });
    return out;
  } catch (e) {
    logStage({ stage: "news.kimi_search_failed", ok: false, query, error: e instanceof Error ? e.message : String(e) });
    return "";
  }
}

async function defaultWebSearch(query: string): Promise<string> {
  // DDG 对中文财经查询基本不可用，每次白等 8 秒。直接走 Kimi 联网搜索。
  logStage({ stage: "news.search_direct_kimi", ok: true, query });
  return kimiWebSearch(query);
}

// ==================== Prompt ====================

const CLASSIFY_SYSTEM = `你是 A 股财经新闻分析助手。任务：对用户提供的近期财经新闻进行结构化分类。

输出 JSON：{"events":[{title, summary, category, sentiment, impact_indices, rationale}, ...]}

字段约束：
1) category 必须是以下 11 个之一：
   policy_macro / geopolitics / industry_semi / industry_ai / industry_property
   industry_energy / industry_finance / market_event / overseas / accident / other
2) sentiment ∈ [-1, 1]：>0 利好 A 股大盘，<0 利空，0 中性
3) impact_indices：
   - "broad"（影响整个 A 股）
   - 或 ["000001.SH"] / ["399006.SZ"] / 两者并列
   - 上证指数偏蓝筹 / 价值；创业板指偏成长 / 科技
4) rationale ≤ 80 字中文，说明"为什么这条新闻会按此 sentiment 影响相应指数"
5) 标题相近、本质同一事件的多条新闻 MUST 合并为一条（避免重复）
6) 与 A 股关系不大的纯本地八卦/娱乐/体育 → category=other，sentiment=0
7) 所有字符串值内部 MUST NOT 包含未转义的英文双引号（\"）。如果原文有引号，请删除或替换为中文引号「」。
8) 优先保留与 A 股直接相关的国内财经/政策/行业新闻，海外新闻如无直接影响可省略。

只输出 JSON，不要 Markdown 代码块。`;

// ==================== Helpers ====================

function safeParseJson<T>(raw: string, schema: z.ZodSchema<T>, fallback: T, logCtx?: Record<string, unknown>): T {
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logStage({ stage: "news.parse_json_attempt_failed", ok: false, attempt: candidates.indexOf(c) + 1, error: msg, ...logCtx });
      // try next
    }
  }
  return fallback;
}

/**
 * 从可能被截断的 JSON 中提取完整的事件对象。
 * LLM 输出被截断时，前面的事件对象通常是完整的。
 */
function extractEventsFromTruncatedJson(raw: string): ClassifiedItem[] {
  const events: ClassifiedItem[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1));
          if (obj.title && NewsCategoryEnum.safeParse(obj.category).success) {
            events.push({
              title: String(obj.title),
              summary: obj.summary ?? null,
              category: NewsCategoryEnum.parse(obj.category),
              sentiment: typeof obj.sentiment === "number" ? Math.max(-1, Math.min(1, obj.sentiment)) : 0,
              impact_indices: obj.impact_indices ?? "broad",
              rationale: obj.rationale ? String(obj.rationale) : "未提供理由",
            });
          }
        } catch {
          // skip invalid object
        }
        start = -1;
      }
    }
  }

  return events;
}

interface RawHeadline {
  title: string;
  source?: string;
  url?: string;
}

/** 从 webSearch 返回文本里粗暴抽取标题列表。*/
function extractHeadlines(searchText: string, source: string): RawHeadline[] {
  if (!searchText) return [];
  const lines = searchText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: RawHeadline[] = [];
  for (const l of lines) {
    // 形如：【摘要】xxx (URL) / 【相关】xxx (URL) / 【结果】xxx (URL)
    const m = l.match(/^【[^】]+】(.+?)(?:\s*\((https?:\/\/[^)]+)\))?$/);
    if (m && m[1]) {
      const t = m[1].trim();
      if (t.length >= 6 && t.length < 200) {
        out.push({ title: t, url: m[2], source });
      }
    }
  }
  return out;
}

/** 抓取新浪财经最新要闻（国内可直接访问）。 */
async function fetchSinaNews(limit = 15): Promise<RawHeadline[]> {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=${limit}&page=1&r=${Date.now()}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://finance.sina.com.cn/",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      logStage({ stage: "news.sina_http_failed", ok: false, status: res.status });
      return [];
    }
    const data = (await res.json()) as {
      result?: { data?: Array<{ title?: string; url?: string; intro?: string }> };
    };
    const items = data.result?.data ?? [];
    const out: RawHeadline[] = [];
    for (const item of items) {
      const title = item.title?.trim();
      if (title && title.length >= 6 && title.length < 200) {
        out.push({ title, url: item.url, source: "sina_finance" });
      }
    }
    logStage({ stage: "news.sina_ok", ok: true, count: out.length });
    return out;
  } catch (e) {
    logStage({ stage: "news.sina_failed", ok: false, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// ==================== 主流程 ====================

export interface ClassifyOptions {
  llmInvoke?: LlmInvokeFn;
  webSearch?: WebSearchFn;
  /** 自定义关键词，否则使用默认 4 组 */
  queries?: string[];
  /** 强制跳过缓存重新搜索+分类 */
  force?: boolean;
}

const DEFAULT_QUERIES = [
  "今日 A股 财经 重大政策",
  "今日 央行 货币政策 经济数据",
  "今日 半导体 AI 新能源 新闻",
  "今日 国际局势 地缘政治 全球财经",
];

export interface ClassifyResult {
  inserted: number;
  skipped_dup: number;
  total_candidates: number;
  llm_failed: boolean;
  search_failed_count: number;
}

/** 当日已分类结果的简单内存缓存，避免同一进程内重复搜索+LLM。 */
const _cache = new Map<string, ClassifyResult>();
/** 同日期并发调用共享一个 in-flight Promise，防止多个请求同时搜同样的关键词。 */
const _inflight = new Map<string, Promise<ClassifyResult>>();

export async function classifyTodayNews(
  asOfDate: string,
  opts: ClassifyOptions = {}
): Promise<ClassifyResult> {
  // 0) 同日期缓存命中直接返回（force 模式跳过缓存）
  if (!opts.force) {
    const cached = _cache.get(asOfDate);
    if (cached) {
      logStage({ stage: "news.classify_cache_hit", ok: true, asOfDate });
      return cached;
    }
  }

  // 0b) 同日期有正在执行的调用，直接复用其 Promise（force 模式也等当前执行完，避免并发轰炸）
  if (!opts.force) {
    const existing = _inflight.get(asOfDate);
    if (existing) return existing;
  }

  const promise = _classifyTodayNewsImpl(asOfDate, opts);
  _inflight.set(asOfDate, promise);
  try {
    const result = await promise;
    _cache.set(asOfDate, result);
    return result;
  } finally {
    _inflight.delete(asOfDate);
  }
}

async function _classifyTodayNewsImpl(
  asOfDate: string,
  opts: ClassifyOptions = {}
): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    inserted: 0,
    skipped_dup: 0,
    total_candidates: 0,
    llm_failed: false,
    search_failed_count: 0,
  };
  const search = opts.webSearch ?? defaultWebSearch;
  const queries = opts.queries ?? DEFAULT_QUERIES;

  // 1) 并行抓多组关键词 + 新浪财经兜底
  const searchStart = Date.now();
  const [searchResults, sinaHeadlines] = await Promise.all([
    Promise.all(
      queries.map(async (q) => {
        try {
          const txt = await search(q);
          return { ok: true as const, query: q, txt };
        } catch (e) {
          result.search_failed_count += 1;
          logStage({
            stage: "news.search_failed",
            ok: false,
            query: q,
            error: e instanceof Error ? e.message : String(e),
          });
          return { ok: false as const, query: q, txt: "" };
        }
      })
    ),
    fetchSinaNews(15).catch((e) => {
      logStage({ stage: "news.sina_fetch_failed", ok: false, error: e instanceof Error ? e.message : String(e) });
      return [] as RawHeadline[];
    }),
  ]);

  const headlines: RawHeadline[] = [];
  for (const r of searchResults) {
    if (r.ok) {
      headlines.push(...extractHeadlines(r.txt, `web_search:ddg:${r.query}`));
    }
  }
  headlines.push(...sinaHeadlines);
  logStage({ stage: "news.sina_fetched", ok: true, count: sinaHeadlines.length, elapsed_ms: Date.now() - searchStart });

  // 去重（按 title）
  const dedup: RawHeadline[] = [];
  const seen = new Set<string>();
  for (const h of headlines) {
    if (seen.has(h.title)) continue;
    seen.add(h.title);
    dedup.push(h);
  }
  result.total_candidates = dedup.length;

  if (dedup.length === 0) {
    // 兜底：写一条 placeholder
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: "fallback",
      url: null,
      title: `${asOfDate} 暂未抓到可分类的公开新闻`,
      summary: null,
      category: "other",
      sentiment: 0,
      impact_indices: "broad",
      rationale: "webSearch 未召回任何标题，事件维度数据缺失",
    });
    if (ok) result.inserted += 1;
    logStage({
      stage: "news.classify_done",
      ok: true,
      asOfDate,
      ...result,
    });
    return result;
  }

  // 2) 让 LLM 一次性分类
  const userPrompt = [
    `决策日: ${asOfDate}`,
    `候选新闻 ${dedup.length} 条：`,
    dedup
      .slice(0, 25) // 限制条数
      .map((h, i) => `${i + 1}. ${h.title}${h.url ? ` (${h.url})` : ""}`)
      .join("\n"),
    ``,
    `请按 schema 分类输出。同一事件的多条标题 MUST 合并为一条。`,
  ].join("\n");

  const invoke = opts.llmInvoke ?? defaultInvokeLlm;
  let raw = "";
  try {
    raw = await invoke(CLASSIFY_SYSTEM, userPrompt);
  } catch (e) {
    result.llm_failed = true;
    logStage({
      stage: "news.llm_failed",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // 调试：记录 LLM 原始输出，帮助诊断 events 为空的问题
  if (raw) {
    logStage({
      stage: "news.llm_classify_raw",
      ok: true,
      asOfDate,
      raw_length: raw.length,
      raw_preview: raw.slice(0, 500),
    });
  }

  let parsed = safeParseJson(raw, ClassificationOutputSchema, { events: [] }, { asOfDate, raw_length: raw.length });

  // 如果完整解析失败且 events 为空，尝试从截断 JSON 中提取部分事件
  if (parsed.events.length === 0 && raw.length > 50) {
    const repaired = extractEventsFromTruncatedJson(raw);
    if (repaired.length > 0) {
      logStage({ stage: "news.parse_truncated_repair", ok: true, extracted: repaired.length, asOfDate });
      parsed = { events: repaired };
    }
  }

  // 3) 写库
  for (const ev of parsed.events) {
    let impact_str: string;
    if (ev.impact_indices === "broad") {
      impact_str = "broad";
    } else if (typeof ev.impact_indices === "string") {
      // LLM 返回了单个指数代码字符串，包装成数组存储
      impact_str = JSON.stringify([ev.impact_indices]);
    } else {
      impact_str = JSON.stringify(ev.impact_indices);
    }
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: dedup.find((d) => d.title === ev.title)?.source ?? "web_search:ddg",
      url: dedup.find((d) => d.title === ev.title)?.url ?? null,
      title: ev.title,
      summary: ev.summary ?? null,
      category: ev.category,
      sentiment: ev.sentiment,
      impact_indices: impact_str,
      rationale: ev.rationale,
    });
    if (ok) result.inserted += 1;
    else result.skipped_dup += 1;
  }

  // 如果 LLM 完全没分到事件，也写一条兜底
  if (parsed.events.length === 0 && !result.llm_failed) {
    logStage({
      stage: "news.llm_empty_events",
      ok: true,
      asOfDate,
      note: "LLM returned valid JSON with empty events array",
      candidate_count: dedup.length,
    });
    const ok = insertNewsEventIfAbsent({
      as_of_date: asOfDate,
      source: "fallback",
      url: null,
      title: `${asOfDate} 候选新闻经分类后无显著影响 A 股的事件`,
      summary: null,
      category: "other",
      sentiment: 0,
      impact_indices: "broad",
      rationale: "LLM 未识别到强相关事件",
    });
    if (ok) result.inserted += 1;
  }

  logStage({
    stage: "news.classify_done",
    ok: !result.llm_failed,
    asOfDate,
    ...result,
  });
  return result;
}

/** 取当日已分类的事件（按情感强度降序）。 */
export function getTodayNewsEvents(asOfDate: string, limit = 10): NewsEventRow[] {
  return getNewsByDate(asOfDate, limit);
}
