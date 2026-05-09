import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { readFileSync } from "fs";

const recognizeImage = tool(
  async ({
    title,
    description,
    elements,
    relationships,
    summary,
  }: {
    title: string;
    description: string;
    elements: string[];
    relationships: string[];
    summary: string;
  }) => {
    return JSON.stringify({ title, description, elements, relationships, summary }, null, 2);
  },
  {
    name: "recognize_image",
    description: "识别图片内容并以结构化数据返回",
    schema: z.object({
      title: z.string().describe("图片标题"),
      description: z.string().describe("图片整体描述"),
      elements: z.array(z.string()).describe("图片中识别到的关键元素/节点列表"),
      relationships: z.array(z.string()).describe("元素之间的关系/连线描述"),
      summary: z.string().describe("图片内容的一句话总结"),
    }),
  }
);

const getWeather = tool(
  async ({ city }: { city: string }) => {
    const weatherData: Record<string, string> = {
      上海: "晴天，气温 25°C，湿度 60%",
      北京: "多云，气温 22°C，湿度 45%",
      广州: "小雨，气温 28°C，湿度 80%",
    };
    return weatherData[city] ?? `暂无${city}的天气数据`;
  },
  {
    name: "get_weather",
    description: "查询指定城市的天气情况",
    schema: z.object({
      city: z.string().describe("城市名称"),
    }),
  }
);

const webSearch = tool(
  async ({ query }: { query: string }) => {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    const data = await res.json() as {
      Abstract?: string;
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
    description: "联网搜索互联网获取实时信息",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
    }),
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
    description: "获取指定URL网页的文本内容",
    schema: z.object({
      url: z.string().describe("要访问的网页URL"),
    }),
  }
);

const llm = new ChatOpenAI({
  model: "glm-4v-flash",
  apiKey: process.env.ZHIPU_API_KEY,
  configuration: {
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
  },
});

const SYSTEM_PROMPT = `你是一个多功能智能体，具备以下能力：图片识别、联网搜索、天气查询。

## 能力说明
1. **图片识别**: 识别图片内容，调用 recognize_image 工具返回结构化 JSON 数据
2. **联网搜索**: 使用 web_search 搜索互联网实时信息，使用 web_fetch 获取网页详细内容
3. **天气查询**: 使用 get_weather 查询城市天气（目前仅支持上海、北京、广州）

## 工作原则
- 收到图片时：识别内容并用 recognize_image 返回结构化数据
- 收到问题时：优先联网搜索获取最新信息，再给出回答
- 需要详细信息时：先用 web_search 搜索，再用 web_fetch 抓取网页内容
- 始终使用中文回答
- 回答要有据可依，标注信息来源`;

const agent = createReactAgent({
  llm,
  tools: [recognizeImage, getWeather, webSearch, webFetch],
  prompt: SYSTEM_PROMPT,
});

const userInput = process.argv[2] ?? "";
const imagePath = process.argv[3] ?? "";

if (!userInput) {
  console.log("用法: tsx agent.ts <问题或指令> [图片路径]");
  console.log("示例:");
  console.log("  tsx agent.ts 上海今天天气怎么样");
  console.log("  tsx agent.ts 2024年诺贝尔物理学奖是谁 /path/to/image.png");
  console.log("  tsx agent.ts 请识别这张图片 /Users/liuli/Downloads/sku打包聚合图.png");
  process.exit(0);
}

const messageContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
  { type: "text", text: userInput },
];

if (imagePath) {
  const imageBuffer = readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");
  const ext = imagePath.split(".").pop() ?? "png";
  const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  messageContent.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } });
}

const stream = await agent.stream({
  messages: [new HumanMessage({ content: messageContent })],
});

let result = "";
for await (const chunk of stream) {
  for (const [nodeName, nodeOutput] of Object.entries(chunk)) {
    const messages = (nodeOutput as { messages: unknown[] }).messages;
    const lastMsg = messages[messages.length - 1] as { content: string };
    if (nodeName === "agent") {
      process.stdout.write(`${lastMsg.content}`);
    } else if (nodeName === "tools") {
      result = typeof lastMsg.content === "string" ? lastMsg.content : "";
    }
  }
}

if (result) {
  console.log(`\n\n识别结果: ${result}`);
}
