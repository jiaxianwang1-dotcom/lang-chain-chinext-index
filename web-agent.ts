import "dotenv/config";
import Database from "better-sqlite3";
import express from "express";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  AIMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";
import {
  getQuote,
  getLatestQuote,
  getQuotesInRange,
  getLatestMemory,
} from "./src/agent/stock/db/index.js";
import { listTargetIndexes, findIndexMeta } from "./src/agent/stock/providers/index.js";
import { predictAllTargets, predictNextTradingDay } from "./src/agent/stock/prediction/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== SQLite 长期记忆 ====================
const MEMORY_DIR = join(__dirname, ".memory");
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const db = new Database(join(MEMORY_DIR, "web_agent.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT    NOT NULL UNIQUE,
    content   TEXT    NOT NULL,
    createdAt TEXT    NOT NULL,
    updatedAt TEXT    NOT NULL
  )
`);

const saveMemory = tool(
  ({ key, content }: { key: string; content: string }) => {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM memories WHERE key = ?").get(key);
    if (existing) {
      db.prepare("UPDATE memories SET content = ?, updatedAt = ? WHERE key = ?").run(content, now, key);
      return `已更新记忆 [${key}]: ${content}`;
    }
    db.prepare("INSERT INTO memories (key, content, createdAt, updatedAt) VALUES (?, ?, ?, ?)").run(key, content, now, now);
    return `已保存记忆 [${key}]: ${content}`;
  },
  {
    name: "save_memory",
    description: "将重要信息保存到长期记忆数据库中。当用户提到个人信息、偏好、重要事实时主动保存。",
    schema: z.object({
      key: z.string().describe("记忆键名，如 '用户姓名'"),
      content: z.string().describe("记忆内容"),
    }),
  }
);

const searchMemory = tool(
  ({ query }: { query: string }) => {
    const rows = db.prepare(
      "SELECT key, content, updatedAt FROM memories WHERE key LIKE ? OR content LIKE ?"
    ).all(`%${query}%`, `%${query}%`) as Array<{ key: string; content: string; updatedAt: string }>;

    if (rows.length === 0) {
      const all = db.prepare("SELECT key, content FROM memories").all() as Array<{ key: string; content: string }>;
      if (all.length === 0) return "长期记忆为空。";
      return `未找到与"${query}"相关记忆。所有记忆：\n${all.map((m) => `- [${m.key}]: ${m.content}`).join("\n")}`;
    }
    return rows.map((m) => `[${m.key}]: ${m.content} (${m.updatedAt})`).join("\n");
  },
  {
    name: "search_memory",
    description: "从长期记忆中搜索信息。需要回忆用户信息时调用。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

// ==================== 联网搜索工具 ====================
const webSearch = tool(
  async ({ query }: { query: string }) => {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url);
      if (!res.ok) {
        return `[联网搜索不可达] HTTP ${res.status}。请基于本地数据回答，不要编造行情。`;
      }
      const data = await res.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        Results?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const results: string[] = [];
      if (data.AbstractText) {
        results.push(`摘要: ${data.AbstractText}\n来源: ${data.AbstractURL ?? ""}`);
      }
      for (const topic of data.RelatedTopics ?? []) {
        if (topic.Text) results.push(`${topic.Text}\n链接: ${topic.FirstURL ?? ""}`);
      }
      for (const r of data.Results ?? []) {
        if (r.Text) results.push(`${r.Text}\n链接: ${r.FirstURL ?? ""}`);
      }
      return results.length ? results.join("\n\n") : `未找到"${query}"的相关信息`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[联网搜索失败] ${msg}。请基于本地数据库或长期记忆回答，不要凭空编造数字或方向。`;
    }
  },
  {
    name: "web_search",
    description: "联网搜索互联网获取实时信息。仅在本地数据无法回答时使用；禁止用搜索结果编造行情数字。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

const webFetch = tool(
  async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent/1.0)" },
      });
      if (!res.ok) {
        return `[网页抓取不可达] ${url} → HTTP ${res.status}`;
      }
      const html = await res.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[网页抓取失败] ${url} → ${msg}`;
    }
  },
  {
    name: "web_fetch",
    description: "获取指定URL网页的文本内容。当搜索结果中有需要深入阅读的链接时使用。",
    schema: z.object({ url: z.string().describe("要访问的网页URL") }),
  }
);

// ==================== 指数数据查询工具（来自 stock_agent.db） ====================

function resolveIndexCode(input?: string): string | null {
  if (!input) return null;
  const v = input.trim();
  // 直接匹配 code
  const direct = findIndexMeta(v);
  if (direct) return direct.index_code;
  // 按名称匹配
  for (const meta of listTargetIndexes()) {
    if (v.includes(meta.index_name)) return meta.index_code;
  }
  // 别名
  if (/上证|沪指|大盘/.test(v)) return "000001.SH";
  if (/创业板|创指/.test(v)) return "399006.SZ";
  return null;
}

const queryIndexQuotes = tool(
  ({ index, start_date, end_date, limit }: { index?: string; start_date?: string; end_date?: string; limit?: number }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}。支持上证指数 / 创业板指。`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      let rows;
      if (start_date && end_date) {
        rows = getQuotesInRange(code, start_date, end_date);
      } else {
        const latest = getLatestQuote(code);
        if (!latest) {
          out.push(`【${name}】 暂无数据。`);
          continue;
        }
        const start = (() => {
          const d = new Date(latest.trade_date);
          d.setUTCDate(d.getUTCDate() - 30);
          return d.toISOString().slice(0, 10);
        })();
        rows = getQuotesInRange(code, start, latest.trade_date);
      }

      const tail = rows.slice(-(limit ?? 30));
      out.push(`【${name}】共 ${tail.length} 条：`);
      for (const r of tail) {
        const pct = r.change_pct == null ? "-" : (r.change_pct >= 0 ? "+" : "") + r.change_pct.toFixed(2) + "%";
        const reason = (r.change_reason ?? "（无归因）").slice(0, 60);
        out.push(`  ${r.trade_date} 收盘=${r.close_value.toFixed(2)} 涨跌=${pct}  原因=${reason}`);
      }
    }
    return out.join("\n");
  },
  {
    name: "query_index_quotes",
    description:
      "查询上证指数 / 创业板指的历史日线行情（含每日涨跌原因 change_reason）。参数 index 可填 '上证指数' / '创业板指' / 代码 '000001.SH' / '399006.SZ'，留空则两个都查。start_date / end_date 用 YYYY-MM-DD；省略则返回最近 30 个交易日。limit 控制返回条数。",
    schema: z.object({
      index: z.string().optional().describe("指数名称或代码，留空查询全部"),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
  }
);

const queryIndexQuoteByDate = tool(
  ({ index, date }: { index: string; date: string }) => {
    const code = resolveIndexCode(index);
    if (!code) return `未识别指数：${index}`;
    const row = getQuote(code, date);
    const meta = findIndexMeta(code);
    if (!row) return `【${meta?.index_name ?? code}】 ${date} 无记录（可能是非交易日或尚未入库）。`;
    const pct = row.change_pct == null ? "-" : (row.change_pct >= 0 ? "+" : "") + row.change_pct.toFixed(2) + "%";
    return [
      `【${meta?.index_name ?? code}】 ${date}`,
      `  收盘=${row.close_value.toFixed(2)}, 涨跌=${pct}`,
      `  原因: ${row.change_reason ?? "（无归因）"}`,
      `  来源: ${row.reason_source ?? "（无来源）"}`,
    ].join("\n");
  },
  {
    name: "query_index_quote_by_date",
    description: "查询某只指数在某个交易日的具体行情与涨跌原因。",
    schema: z.object({
      index: z.string().describe("指数名称或代码"),
      date: z.string().describe("YYYY-MM-DD"),
    }),
  }
);

const queryIndexMemory = tool(
  ({ index }: { index?: string }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      const m = getLatestMemory(code);
      if (!m) {
        out.push(`【${name}】 暂无长期分析记忆。`);
        continue;
      }
      out.push(`【${name}】 v${m.version}（as_of=${m.as_of_date}）`);
      out.push(`  summary: ${m.summary}`);
      out.push(`  features: ${m.features}`);
    }
    return out.join("\n");
  },
  {
    name: "query_index_memory",
    description:
      "查询某只指数最新的长期分析记忆（summary + features）。每次预测后都会写入新版本，可用于回顾智能体当前对趋势的判断。留空 index 则两个都查。",
    schema: z.object({ index: z.string().optional() }),
  }
);

const queryLatestPrediction = tool(
  ({ index }: { index?: string }) => {
    const targets = index
      ? [resolveIndexCode(index)].filter(Boolean) as string[]
      : listTargetIndexes().map((m) => m.index_code);
    if (targets.length === 0) return `未识别指数：${index}`;

    const out: string[] = [];
    for (const code of targets) {
      const meta = findIndexMeta(code);
      const name = meta?.index_name ?? code;
      const m = getLatestMemory(code);
      if (!m) {
        out.push(`【${name}】 暂无长期分析记忆，请先调用 run_prediction_now 触发一次预测。`);
        continue;
      }
      let features: Record<string, unknown> = {};
      try {
        features = JSON.parse(m.features);
      } catch {
        features = {};
      }
      const pred = (features as { last_prediction?: { direction?: string; confidence?: number; rationale?: string; predicted_at?: string; based_on_trade_date?: string } }).last_prediction;
      if (!pred?.direction) {
        out.push(`【${name}】 v${m.version}（as_of=${m.as_of_date}）记忆里没有保存方向；请用 run_prediction_now 触发一次新预测以获得方向。`);
        continue;
      }
      const dirText = pred.direction === "up" ? "买涨" : "买跌";
      const confText = pred.confidence == null ? "-" : (pred.confidence * 100).toFixed(1) + "%";
      out.push(`【${name}】 下一交易日 → ${dirText}（置信度 ${confText}）`);
      out.push(`  基于交易日: ${pred.based_on_trade_date ?? m.as_of_date}`);
      out.push(`  生成时间: ${pred.predicted_at ?? "-"}`);
      out.push(`  记忆版本: v${m.version}`);
      out.push(`  理由: ${pred.rationale ?? "（无）"}`);
    }
    out.push("");
    out.push("（仅供参考，非投资建议）");
    return out.join("\n");
  },
  {
    name: "query_latest_prediction",
    description: "查询指数智能体上一次给出的下一交易日方向（买涨/买跌）+ 置信度 + 理由 + 基于的交易日。**用户问'下一个交易日怎么走'/'买涨还是买跌'/'你预测什么'时优先使用此工具，禁止用 web_search 编方向**。留空 index 则两个都查。",
    schema: z.object({ index: z.string().optional() }),
  }
);

const runPredictionNow = tool(
  async ({ index }: { index?: string }) => {
    const code = resolveIndexCode(index ?? "");
    try {
      if (code) {
        const r = await predictNextTradingDay(code);
        return [
          `【${r.index_name}】 下一交易日 → ${r.direction === "up" ? "买涨" : "买跌"}（置信度 ${(r.confidence * 100).toFixed(1)}%）`,
          `  理由: ${r.rationale}`,
          `  基于: ${r.as_of_date}, 已写入记忆 v${r.version}`,
          ``,
          `（仅供参考，非投资建议）`,
        ].join("\n");
      }
      const all = await predictAllTargets();
      const lines = ["[新一轮预测结果]"];
      for (const r of all) {
        lines.push(`- ${r.index_name}: ${r.direction === "up" ? "买涨" : "买跌"}（置信度 ${(r.confidence * 100).toFixed(1)}%）→ v${r.version}`);
        lines.push(`    理由: ${r.rationale}`);
      }
      lines.push("");
      lines.push("（仅供参考，非投资建议）");
      return lines.join("\n");
    } catch (e) {
      return `[预测失败] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "run_prediction_now",
    description: "立即触发一次新的下一交易日方向预测（会消耗 LLM 配额，约 10-20 秒），写入新版本长期记忆。当用户明确要求'重新预测一下/帮我跑一次/现在预测'时调用。留空 index 则两个指数都跑。",
    schema: z.object({ index: z.string().optional() }),
  }
);

const queryStockOverview = tool(
  () => {
    const out: string[] = ["[指数智能体数据概览]"];
    for (const meta of listTargetIndexes()) {
      const latest = getLatestQuote(meta.index_code);
      const memory = getLatestMemory(meta.index_code);
      out.push(`- ${meta.index_name} (${meta.index_code})`);
      if (latest) {
        const pct = latest.change_pct == null ? "-" : (latest.change_pct >= 0 ? "+" : "") + latest.change_pct.toFixed(2) + "%";
        out.push(`    最新行情: ${latest.trade_date} 收盘=${latest.close_value.toFixed(2)} 涨跌=${pct}`);
      } else {
        out.push(`    最新行情: 无`);
      }
      if (memory) {
        out.push(`    长期记忆: v${memory.version} (as_of=${memory.as_of_date})`);
      } else {
        out.push(`    长期记忆: 无`);
      }
    }
    return out.join("\n");
  },
  {
    name: "query_stock_overview",
    description: "返回指数智能体当前的整体数据状态：每只指数的最新行情 + 最新长期记忆版本号。用户问'你那边有什么数据'类问题时调用。",
    schema: z.object({}),
  }
);

// ==================== 上下文压缩 ====================
const MAX_TOKENS = 4000;

function estimateTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(content.length / 2);
  }
  return total;
}

async function summarizeMessages(messages: BaseMessage[], summarizer: ChatOpenAI): Promise<SystemMessage> {
  const conversationText = messages
    .map((m) => {
      const role = m instanceof HumanMessage ? "用户" : m instanceof AIMessage ? "助手" : "系统";
      return `${role}: ${typeof m.content === "string" ? m.content : ""}`;
    })
    .join("\n");

  const response = await summarizer.invoke([
    new SystemMessage("你是一个对话压缩助手。请将以下对话历史压缩为简洁的摘要，保留所有关键信息（用户身份、偏好、讨论要点、决策结论）。使用中文，不超过500字。"),
    new HumanMessage(`请压缩以下对话：\n${conversationText}`),
  ]);

  return new SystemMessage(`[历史对话摘要]\n${typeof response.content === "string" ? response.content : ""}`);
}

async function compressIfNeeded(messages: BaseMessage[], summarizer: ChatOpenAI): Promise<BaseMessage[]> {
  const tokenCount = estimateTokens(messages);
  if (tokenCount <= MAX_TOKENS) return messages;

  console.log(`[压缩] ${tokenCount} tokens 超过限制 ${MAX_TOKENS}，开始压缩...`);

  const keepRecent = 6;
  const oldMessages = messages.slice(1, Math.max(1, messages.length - keepRecent));
  const recentMessages = messages.slice(Math.max(1, messages.length - keepRecent));
  if (oldMessages.length === 0) return messages;

  const summary = await summarizeMessages(oldMessages, summarizer);
  const compressed = [messages[0], summary, ...recentMessages];
  console.log(`[压缩完成] ${oldMessages.length} 条旧消息 → 1 条摘要，${tokenCount} → ${estimateTokens(compressed)} tokens`);
  return compressed;
}

// ==================== LangGraph 智能体 ====================
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const llm = new ChatOpenAI({
  model: "glm-4-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  streaming: true,
});

const summarizer = new ChatOpenAI({
  model: "glm-4-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
});

const allTools = [
  saveMemory,
  searchMemory,
  webSearch,
  webFetch,
  queryIndexQuotes,
  queryIndexQuoteByDate,
  queryIndexMemory,
  queryLatestPrediction,
  runPredictionNow,
  queryStockOverview,
];
const llmWithTools = llm.bindTools(allTools);

const SYSTEM_PROMPT = `你是一个全能智能助手，具备以下能力：

## 核心能力
1. **长期记忆**: 记住用户告诉你的任何信息，下次对话时能回忆起来
   - 用户提到个人信息、偏好、重要事实时，调用 save_memory 保存
   - 需要回忆用户信息时，调用 search_memory 查找
2. **联网搜索**: 可以搜索互联网获取最新信息
   - 使用 web_search 搜索实时信息
   - 使用 web_fetch 获取网页详细内容
3. **指数行情数据库**: 你接管了 stock-index-agent 智能体生成的数据，可以回答上证指数和创业板指的历史行情、每日涨跌原因、长期分析记忆与下一交易日预测
   - 用户问"最近行情/这周走势/某天为什么涨跌" → 调用 query_index_quotes 或 query_index_quote_by_date
   - 用户问"下一交易日怎么走/买涨还是买跌/你的预测" → **必须先调用 query_latest_prediction**；如果它提示"无方向/无记忆"，再调用 run_prediction_now 触发新一次预测
   - 用户问"你对趋势的判断/分析记忆/summary" → 调用 query_index_memory
   - 用户问"有哪些数据/数据现状" → 调用 query_stock_overview
   - 别名识别：上证指数=000001.SH（也叫沪指/大盘）；创业板指=399006.SZ（也叫创指）

## 工作流程
1. 对话开始时，可调用 search_memory 了解用户背景
2. 发现新的用户信息，调用 save_memory 保存
3. 涉及指数数据 / 预测 / 涨跌方向时，**必须**先用 query_index_* / query_latest_prediction 读本地库；本地无答案时才考虑 web_search
4. **绝对禁止用 web_search 的结果直接给出指数点位、涨跌幅或买涨/买跌方向**——这些只能来自本地数据库或 run_prediction_now

## 注意事项
- 始终使用中文回答
- 回答要有据可依：行情要带具体日期与点位；预测要带置信度、记忆版本号、基于的交易日
- 涉及投资方向的回答末尾必须附"仅供参考，非投资建议"
- 工具返回 [联网搜索失败] / [联网搜索不可达] 时，不要因此放弃；改用本地工具回答，并在末尾告知用户网络当前不可达
- 对话要自然友好`;

async function agentNode(state: typeof AgentState.State) {
  const systemMsg = new SystemMessage(SYSTEM_PROMPT);
  const allMessages = [systemMsg, ...state.messages];
  const compressed = await compressIfNeeded(allMessages, summarizer);
  const response = await llmWithTools.invoke(compressed);
  return { messages: [response] };
}

const toolNode = new ToolNode(allTools);

function shouldContinue(state: typeof AgentState.State) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (isAIMessage(lastMsg) && lastMsg.tool_calls?.length) return "tools";
  return END;
}

const workflow = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
const graph = workflow.compile({ checkpointer });

// ==================== Express 服务器 ====================
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// 聊天会话存储（线程ID → 消息列表）
const sessions = new Map<string, BaseMessage[]>();

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = "default" } = req.body as { message: string; sessionId?: string };

  if (!message) {
    res.status(400).json({ error: "消息不能为空" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: string) => {
    res.write(`data: ${JSON.stringify({ content: data })}\n\n`);
  };

  try {
    const stream = await graph.stream(
      { messages: [new HumanMessage(message)] },
      { configurable: { thread_id: sessionId } }
    );

    let fullResponse = "";

    for await (const chunk of stream) {
      for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
        const messages = (nodeOutput as { messages: BaseMessage[] }).messages;
        const lastMsg = messages[messages.length - 1];

        if (nodeName === "tools") {
          const toolContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
          if (toolContent) {
            sendEvent(`[工具调用] ${toolContent.slice(0, 100)}...`);
          }
        }

        if (nodeName === "agent" && typeof lastMsg.content === "string" && lastMsg.content) {
          const newText = lastMsg.content;
          if (newText.length > fullResponse.length) {
            const delta = newText.slice(fullResponse.length);
            fullResponse = newText;
            sendEvent(delta);
          }
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, fullResponse })}\n\n`);
    res.end();
  } catch (error) {
    console.error("聊天错误:", error);
    sendEvent("抱歉，发生了错误，请稍后重试。");
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
});

// 获取长期记忆列表
app.get("/api/memories", (_req, res) => {
  const rows = db.prepare("SELECT key, content, updatedAt FROM memories ORDER BY updatedAt DESC").all();
  res.json(rows);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`\n  🤖 智能体已启动`);
  console.log(`  📡 访问 http://localhost:${PORT}\n`);
});
