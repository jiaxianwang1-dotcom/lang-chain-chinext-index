import "dotenv/config";

const apiKey = process.env.KIMI_API_KEY;

async function testSearchIdAsUser(query: string) {
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
  const args = JSON.parse(tc?.function?.arguments || '{}');
  console.log("search_id:", args.search_result?.search_id);

  // Try passing search_id as user message
  const res2 = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moonshot-v1-8k",
      messages: [
        { role: "system", content: "请使用 web_search 工具搜索，然后以纯文本列表返回结果。每条一行：【摘要】标题（URL）。" },
        { role: "user", content: query },
        { role: "assistant", content: "", tool_calls: [{ id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: tc.function.arguments } }] },
        { role: "tool", tool_call_id: tc.id, content: "搜索已完成" },
      ],
      tools,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const round2 = await res2.json();
  console.log("Round2 content:", JSON.stringify(round2.choices?.[0]?.message?.content).slice(0, 500));
}

async function main() {
  await testSearchIdAsUser("2026年5月16日 A股 重大政策");
}
main().catch(console.error);
