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
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
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
  },
  {
    name: "web_search",
    description: "联网搜索互联网获取实时信息。当用户问及最新事件、实时数据或你不确定的知识时使用。",
    schema: z.object({ query: z.string().describe("搜索关键词") }),
  }
);

const webFetch = tool(
  async ({ url }: { url: string }) => {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent/1.0)" },
    });
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 5000);
  },
  {
    name: "web_fetch",
    description: "获取指定URL网页的文本内容。当搜索结果中有需要深入阅读的链接时使用。",
    schema: z.object({ url: z.string().describe("要访问的网页URL") }),
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

const allTools = [saveMemory, searchMemory, webSearch, webFetch];
const llmWithTools = llm.bindTools(allTools);

const SYSTEM_PROMPT = `你是一个全能智能助手，具备以下能力：

## 核心能力
1. **长期记忆**: 记住用户告诉你的任何信息，下次对话时能回忆起来
   - 用户提到个人信息、偏好、重要事实时，调用 save_memory 保存
   - 需要回忆用户信息时，调用 search_memory 查找
2. **联网搜索**: 可以搜索互联网获取最新信息
   - 使用 web_search 搜索实时信息
   - 使用 web_fetch 获取网页详细内容

## 工作流程
1. 对话开始时，调用 search_memory 了解用户背景
2. 发现新的用户信息，调用 save_memory 保存
3. 需要最新信息时，使用 web_search 搜索
4. 结合记忆和搜索结果，给出准确的回答

## 注意事项
- 记忆 key 要语义化（如 "用户姓名"、"用户爱好"）
- 始终使用中文回答
- 回答要有据可依，搜索结果要标注来源
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
