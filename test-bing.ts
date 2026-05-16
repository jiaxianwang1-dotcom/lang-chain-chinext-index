async function fetchBingNews(query: string): Promise<string> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "";
    const text = await res.text();
    // Extract news titles and URLs from Bing news
    const results: string[] = [];
    // Bing news cards
    const cardRegex = /<a[^>]*href="([^"]+)"[^>]*data-id="[^"]*"[^>]*h="[^"]*"[^>]*>\s*<div[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/div>/g;
    let m;
    while ((m = cardRegex.exec(text)) !== null) {
      const title = m[2].trim();
      const href = m[1];
      if (title.length > 6) {
        results.push(`【摘要】${title} (${href})`);
      }
    }
    // Fallback: generic search results
    if (results.length === 0) {
      const genericRegex = /<li class="b_algo"[^>]*>.*?<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
      while ((m = genericRegex.exec(text)) !== null) {
        const title = m[2].trim();
        const href = m[1];
        if (title.length > 6 && !href.includes("microsoft.com") && !href.includes("bing.com")) {
          results.push(`【摘要】${title} (${href})`);
        }
      }
    }
    console.log("Bing results:", results.slice(0, 5));
    return results.join("\n");
  } catch (e) {
    console.error("Bing failed:", e);
    return "";
  }
}

fetchBingNews("今日 A股 重大新闻").then(r => console.log("\nTotal length:", r.length));
