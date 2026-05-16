import "dotenv/config";
import { classifyTodayNews } from "./src/agent/stock/news/index.js";

async function main() {
  console.log("Testing classifyTodayNews with force=true...");
  const r = await classifyTodayNews("2026-05-16", { force: true });
  console.log("Result:", JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
