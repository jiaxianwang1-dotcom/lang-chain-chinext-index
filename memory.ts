import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";

const llm = new ChatOpenAI({
  model: "glm-4v-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
  },
});

const checkpointer = new MemorySaver();

const agent = createReactAgent({
  llm,
  tools: [],
  prompt: "你是一个有记忆能力的智能体，能记住用户在对话中提到的信息。始终使用中文回答。",
  checkpointer,
});

const threadId = "user-memory-demo";

async function chat(input: string) {
  console.log(`\n===== 用户: ${input} =====`);

  const stream = await agent.stream(
    { messages: [new HumanMessage(input)] },
    { configurable: { thread_id: threadId } }
  );

  for await (const chunk of stream) {
    for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
      if (nodeName === "agent") {
        const messages = (nodeOutput as { messages: unknown[] }).messages;
        const lastMsg = messages[messages.length - 1] as { content: string };
        console.log(`智能体: ${lastMsg.content}`);
      }
    }
  }
}

// 第一次对话：告诉智能体你是谁、喜欢什么
await chat("你好，我是家现，我喜欢猫猫");

// 第二次对话：测试记忆 — 问智能体你喜欢什么
await chat("我是家现，我喜欢什么动物？");
