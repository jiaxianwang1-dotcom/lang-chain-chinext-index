async function fetchQQNews(): Promise<any[]> {
  // 腾讯新闻热榜
  const url = "https://r.inews.qq.com/gw/event/hot_ranking_list?offset=0&page_size=20";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        Accept: "application/json",
      },
    });
    console.log("status:", res.status);
    if (!res.ok) return [];
    const data = await res.json() as any;
    console.log("data keys:", Object.keys(data));
    const items = data.newslist || [];
    console.log("items count:", items.length);
    return items.slice(0, 3);
  } catch (e) {
    console.error("error:", e);
    return [];
  }
}
fetchQQNews().then(r => console.log(JSON.stringify(r, null, 2)));
