import "dotenv/config";
import Database from "better-sqlite3";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  AIMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Annotation, StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// ==================== SQLite 长期记忆 ====================
const MEMORY_DIR = join(import.meta.dirname, ".memory");
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const db = new Database(join(MEMORY_DIR, "long_term.db"));
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
    description: "将重要信息保存到长期记忆数据库中。当用户提到个人信息时主动保存。",
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

// ==================== Token 估算与上下文压缩 ====================
const MAX_TOKENS = 100;

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
    new SystemMessage("你是一个对话压缩助手。请将以下对话历史压缩为简洁的摘要，保留所有关键信息（用户身份、偏好、讨论要点、决策结论）。使用中文，不超过200字。"),
    new HumanMessage(`请压缩以下对话：\n${conversationText}`),
  ]);

  return new SystemMessage(`[历史对话摘要]\n${typeof response.content === "string" ? response.content : ""}`);
}

async function compressIfNeeded(messages: BaseMessage[], summarizer: ChatOpenAI): Promise<BaseMessage[]> {
  const tokenCount = estimateTokens(messages);

  if (tokenCount <= MAX_TOKENS) {
    console.log(`  [上下文] ${tokenCount} tokens，无需压缩`);
    return messages;
  }

  console.log(`  [上下文] ${tokenCount} tokens 超过限制 ${MAX_TOKENS}，开始压缩...`);

  const keepRecent = 4;
  const oldMessages = messages.slice(1, Math.max(1, messages.length - keepRecent));
  const recentMessages = messages.slice(Math.max(1, messages.length - keepRecent));

  if (oldMessages.length === 0) return messages;

  const summary = await summarizeMessages(oldMessages, summarizer);
  const compressed = [messages[0], summary, ...recentMessages];

  const newTokenCount = estimateTokens(compressed);
  console.log(`  [压缩完成] ${oldMessages.length} 条旧消息 → 1 条摘要，${tokenCount} → ${newTokenCount} tokens`);

  return compressed;
}

// ==================== 构建 StateGraph ====================
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const llm = new ChatOpenAI({
  model: "glm-4v-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
});

const summarizer = new ChatOpenAI({
  model: "glm-4v-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
});

const tools = [saveMemory, searchMemory];
const llmWithTools = llm.bindTools(tools);

const SYSTEM_PROMPT = `你是一个具备长期记忆和上下文压缩能力的智能体。

## 核心能力
- **主动记忆**: 用户提到个人信息时，调用 save_memory 保存到数据库
- **回忆记忆**: 需要回忆时，调用 search_memory 查找

## 工作流程
1. 对话开始时，调用 search_memory 了解用户背景
2. 发现新用户信息，调用 save_memory 保存
3. 结合记忆中的信息回答问题

## 注意事项
- 记忆 key 要语义化
- 始终使用中文回答`;

async function agentNode(state: typeof AgentState.State) {
  const systemMsg = new SystemMessage(SYSTEM_PROMPT);
  const allMessages = [systemMsg, ...state.messages];

  const compressed = await compressIfNeeded(allMessages, summarizer);

  const response = await llmWithTools.invoke(compressed);
  return { messages: [response] };
}

const toolNode = new ToolNode(tools);

function shouldContinue(state: typeof AgentState.State) {
  const lastMsg = state.messages[state.messages.length - 1];
  if (isAIMessage(lastMsg) && lastMsg.tool_calls?.length) {
    return "tools";
  }
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

// ==================== 对话执行 ====================
const threadId = "compressed-memory-session";

async function chat(input: string) {
  console.log(`\n===== 用户: ${input} =====`);

  const stream = await graph.stream(
    { messages: [new HumanMessage(input)] },
    { configurable: { thread_id: threadId } }
  );

  for await (const chunk of stream) {
    for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
      if (nodeName === "agent") {
        const messages = (nodeOutput as { messages: BaseMessage[] }).messages;
        const lastMsg = messages[messages.length - 1];
        if (typeof lastMsg.content === "string" && lastMsg.content) {
          console.log(`智能体: ${lastMsg.content}`);
        }
      }
    }
  }
}

// ==================== 场景演示 ====================
const scenario = process.argv[2] ?? "demo";

if (scenario === "demo") {
  console.log("=== 长期记忆 + 上下文压缩演示 ===");
  console.log(`上下文限制: ${MAX_TOKENS} tokens\n`);

  await chat("你好，我是家现，我最喜欢猫猫，我住在上海");
  await chat("我还在学习 LangChain，我觉得它很有趣");
  await chat("对了，我的爱好还有打篮球和看电影");
  await chat("我是家现，我喜欢什么动物？我住在哪里？");
  await chat("我的爱好都有哪些？");

  console.log("\n=== 演示结束 ===");
} else {
  const input = process.argv.slice(2).join(" ");
  if (!input) {
    console.log("用法:");
    console.log("  tsx compressed-memory.ts demo        # 运行演示");
    console.log("  tsx compressed-memory.ts 你好         # 自由对话");
    process.exit(0);
  }
  await chat(input);
}
