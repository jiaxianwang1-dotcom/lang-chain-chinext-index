import "dotenv/config";

const apiKey = process.env.KIMI_API_KEY;

async function testNoTools(query: string) {
  const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moonshot-v1-8k",
      messages: [
        { role: "system", content: "你是一个搜索助手。请联网搜索用户的问题，然后以纯文本列表形式返回搜索结果。每条结果一行，格式：【摘要】标题 - 摘要（URL）。只输出结果列表，不要额外解释。" },
        { role: "user", content: query },
      ],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  console.log("No-tools finish_reason:", data.choices?.[0]?.finish_reason);
  console.log("No-tools content:", JSON.stringify(data.choices?.[0]?.message?.content).slice(0, 500));
}

async function testWithWebSearchTool(query: string) {
  const tools = [{ type: "builtin_function", function: { name: "$web_search" } }];
  const res1 = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moonshot-v1-8k",
      messages: [
        { role: "system", content: "请使用 web_search 工具搜索，然后以纯文本列表返回结果。每条一行：【摘要】标题（URL）。" },
        { role: "user", content: query },
      ],
      tools,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const round1 = await res1.json();
  const tc = round1.choices?.[0]?.message?.tool_calls?.[0];
  console.log("\nWith-tools arguments:", JSON.stringify(tc?.function?.arguments).slice(0, 300));

  // Try passing search_id back differently
  const res2 = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moonshot-v1-8k",
      messages: [
        { role: "system", content: "请使用 web_search 工具搜索，然后以纯文本列表返回结果。每条一行：【摘要】标题（URL）。" },
        { role: "user", content: query },
        { role: "assistant", content: "", tool_calls: [{ id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: tc.function.arguments } }] },
        { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ search_result: "已完成搜索" }) },
      ],
      tools,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const round2 = await res2.json();
  console.log("Round2 finish_reason:", round2.choices?.[0]?.finish_reason);
  console.log("Round2 content:", JSON.stringify(round2.choices?.[0]?.message?.content).slice(0, 500));
}

async function main() {
  await testNoTools("今日 A股 重大新闻");
  await testWithWebSearchTool("今日 A股 重大新闻");
}
main().catch(console.error);
