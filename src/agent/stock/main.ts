import "dotenv/config";
import cron from "node-cron";
import { getDb, getLatestQuote, getLatestMemory } from "./db/index.js";
import { listTargetIndexes } from "./providers/index.js";
import { backfillOneYear } from "./providers/ingestion.js";
import { backfillReasons } from "./analysis/index.js";
import { bootstrapPredictionMemory } from "./prediction/index.js";
import { runOnce } from "./graph/index.js";
import { predictAllTargets } from "./prediction/index.js";
import { buildNotifier } from "./notify/index.js";
import { logStage, timed } from "./utils/log.js";

// LangSmith：默认覆盖为本智能体专属项目
if (process.env.LANGCHAIN_TRACING_V2 === "true" && !process.env.LANGCHAIN_PROJECT_OVERRIDE) {
  process.env.LANGCHAIN_PROJECT = process.env.LANGCHAIN_STOCK_PROJECT ?? "stock-index-agent";
}

interface Cli {
  once: boolean;
  dryRun: boolean;
  selfCheck: boolean;
  predictOnly: boolean;
}

function parseArgs(argv: string[]): Cli {
  return {
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
    selfCheck: argv.includes("--self-check"),
    predictOnly: argv.includes("--predict-only"),
  };
}

async function ensureBootstrapped(): Promise<void> {
  for (const meta of listTargetIndexes()) {
    const latestQuote = getLatestQuote(meta.index_code);
    if (!latestQuote) {
      logStage({ stage: "bootstrap.skip_no_quotes", indexCode: meta.index_code, ok: true });
      continue;
    }
    const memory = getLatestMemory(meta.index_code);
    if (!memory) {
      await timed("bootstrap_memory", meta.index_code, () => bootstrapPredictionMemory(meta.index_code));
    }
  }
}

async function initIfEmpty(): Promise<void> {
  // 检查是否有任何行情数据，无则触发首次回填 + 归因 + bootstrap
  const db = getDb();
  const cnt = (db.prepare("SELECT COUNT(*) as c FROM index_quotes").get() as { c: number }).c;
  if (cnt > 0) {
    logStage({ stage: "init.skip", ok: true, existingRows: cnt });
    return;
  }
  logStage({ stage: "init.start", ok: true });
  await timed("backfill", undefined, () => backfillOneYear());
  await timed("backfill_reasons", undefined, () => backfillReasons());
  await ensureBootstrapped();
  logStage({ stage: "init.done", ok: true });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // 触发 DB 初始化（建表）
  getDb();
  logStage({ stage: "boot", ok: true, mode: cli });

  if (cli.selfCheck) {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    logStage({ stage: "self_check", ok: true, tables });
    process.exit(0);
  }

  if (cli.predictOnly) {
    const predictions = await timed("predict", undefined, () => predictAllTargets());
    const notifier = buildNotifier({ dryRun: cli.dryRun });
    await timed("notify", undefined, () => notifier.sendPredictionSms(predictions));
    logStage({ stage: "predict_only.done", ok: true, predictions });
    process.exit(0);
  }

  if (cli.once) {
    await initIfEmpty();
    await runOnce({ dryRun: cli.dryRun });
    process.exit(0);
  }

  // 常驻模式
  await initIfEmpty();

  // 北京时间每个交易日（周一到周五）14:00 触发
  // node-cron v3 支持 timezone 选项
  const task = cron.schedule(
    "0 14 * * 1-5",
    async () => {
      try {
        await runOnce({ dryRun: false });
      } catch (e) {
        logStage({
          stage: "cron.run_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    { timezone: "Asia/Shanghai" }
  );
  task.start();
  logStage({ stage: "cron.registered", ok: true, expr: "0 14 * * 1-5", tz: "Asia/Shanghai" });

  // 防止进程退出
  process.on("SIGINT", () => {
    logStage({ stage: "shutdown", ok: true, signal: "SIGINT" });
    task.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  logStage({
    stage: "main.fatal",
    ok: false,
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
