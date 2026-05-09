import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  AIMessage,
  isAIMessage,
} from "@langchain/core/messages";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AgentState } from "./state.js";
import { allTools } from "./tools.js";

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

// ==================== LLM 配置 ====================
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

const llmWithTools = llm.bindTools(allTools);

// ==================== 系统提示词 ====================
const SYSTEM_PROMPT = `你是一个全能智能助手。始终使用中文回答。

## 工具使用规则（按需调用，不要强制调用每个工具）

### web_search — 联网搜索
当用户问到实时信息、最新事件、你不确定的知识时，使用 web_search 搜索，然后用搜索结果回答。

### web_fetch — 网页抓取
当搜索结果中有需要深入阅读的链接时，使用 web_fetch 获取内容。

### search_memory — 查询长期记忆
当需要回忆用户的个人信息、偏好或之前的对话内容时，调用 search_memory。

### save_memory — 保存长期记忆
当用户主动告诉你他的个人信息（姓名、爱好等）或重要事实时，调用 save_memory 保存。

## 原则
- 第一优先：直接回答用户的问题
- 只在必要时才调用工具，不要每轮都调用
- 搜索结果要标注来源
- 对话自然友好`;

// ==================== 图节点 ====================
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

// ==================== 构建 Graph ====================
const workflow = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue)
  .addEdge("tools", "agent");

const checkpointer = new MemorySaver();
export const graph = workflow.compile({ checkpointer });
