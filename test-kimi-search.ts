import "dotenv/config";

async function kimiWebSearch(query: string): Promise<string> {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return "";

  const systemContent =
    "你是一个搜索助手。请使用 web_search 工具搜索用户的问题，然后以纯文本列表形式返回搜索结果。每条结果一行，格式：标题 - 摘要（URL）。只输出结果列表，不要额外解释。";
  const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];

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
  const round1 = await res1.json();
  console.log("Round1 finish_reason:", round1.choices?.[0]?.finish_reason);
  console.log("Round1 content:", JSON.stringify(round1.choices?.[0]?.message?.content).slice(0, 200));
  console.log("Round1 tool_calls:", JSON.stringify(round1.choices?.[0]?.message?.tool_calls).slice(0, 500));

  const toolCalls = round1.choices?.[0]?.message?.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return round1.choices?.[0]?.message?.content ?? "";
  }

  const toolCall = toolCalls[0];
  console.log("Tool arguments:", toolCall.function.arguments);

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
  const round2 = await res2.json();
  console.log("Round2 finish_reason:", round2.choices?.[0]?.finish_reason);
  return round2.choices?.[0]?.message?.content ?? "";
}

async function main() {
  const r = await kimiWebSearch("今日 A股 重大新闻");
  console.log("\n=== RESULT ===\n", r.slice(0, 800));
}

main().catch(console.error);
