async function fetchSinaNews(limit = 15): Promise<any[]> {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=${limit}&page=1&r=${Date.now()}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://finance.sina.com.cn/",
        "Accept": "application/json, text/plain, */*",
      },
    });
    console.log("status:", res.status);
    if (!res.ok) return [];
    const data = await res.json() as any;
    console.log("result keys:", Object.keys(data.result || {}));
    const items = data.result?.data || [];
    console.log("items count:", items.length);
    return items.slice(0, 3);
  } catch (e) {
    console.error("error:", e);
    return [];
  }
}

fetchSinaNews().then(r => console.log(r));
