import "dotenv/config";

async function test(query: string) {
  const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.KIMI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moonshot-v1-8k",
      messages: [
        { role: "system", content: "你是一个搜索助手。请联网搜索用户的问题，然后以纯文本列表形式返回搜索结果。每条结果一行，格式：【摘要】标题（URL）。只输出结果列表，不要额外解释。" },
        { role: "user", content: query },
      ],
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  console.log("Content:\n", data.choices?.[0]?.message?.content);
}

async function main() {
  await test("2026年5月16日 A股 重大新闻");
}
main().catch(console.error);
