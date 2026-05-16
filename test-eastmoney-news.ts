async function fetchEastmoneyNews(limit = 15): Promise<any[]> {
  // 东方财富 7x24 财经快讯
  const url = `https://np-listapi.eastmoney.com/comm/web/Article/GetArticleList?client=web&biz=web_news&needInteractData=1&page_size=${limit}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://finance.eastmoney.com/",
        Accept: "application/json, text/plain, */*",
      },
    });
    console.log("status:", res.status);
    if (!res.ok) return [];
    const data = await res.json() as any;
    console.log("data keys:", Object.keys(data));
    const items = data.result?.data || [];
    console.log("items count:", items.length);
    return items.slice(0, 3);
  } catch (e) {
    console.error("error:", e);
    return [];
  }
}
fetchEastmoneyNews().then(r => console.log(JSON.stringify(r, null, 2)));
