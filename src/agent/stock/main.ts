import "dotenv/config";
import cron from "node-cron";
import { getDb } from "./db/index.js";
import { backfillOneYear, refreshOhlcvForExistingQuotes } from "./providers/ingestion.js";
import { backfillMarginHistory } from "./providers/margin.js";
import { backfillReasons } from "./analysis/index.js";
import { runOnce } from "./graph/index.js";
import { predictAllTargets } from "./prediction/index.js";
import { buildNotifier } from "./notify/index.js";
import { reviewRecentPredictions } from "./review/index.js";
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
  refreshOhlcv: boolean;
  backfillFundflow: boolean;
}

function parseArgs(argv: string[]): Cli {
  return {
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
    selfCheck: argv.includes("--self-check"),
    predictOnly: argv.includes("--predict-only"),
    refreshOhlcv: argv.includes("--refresh-ohlcv"),
    backfillFundflow: argv.includes("--backfill-fundflow"),
  };
}

async function initIfEmpty(): Promise<void> {
  // 检查是否有任何行情数据，无则触发首次回填 + 归因。
  // 注意：当前预测模式（实时分析）不再依赖长期记忆，因此初始化阶段不再 bootstrap memory。
  const db = getDb();
  const cnt = (db.prepare("SELECT COUNT(*) as c FROM index_quotes").get() as { c: number }).c;
  if (cnt > 0) {
    logStage({ stage: "init.skip", ok: true, existingRows: cnt });
    return;
  }
  logStage({ stage: "init.start", ok: true });
  await timed("backfill", undefined, () => backfillOneYear());
  await timed("backfill_reasons", undefined, () => backfillReasons());
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

  if (cli.refreshOhlcv) {
    const r = await timed("refresh_ohlcv", undefined, () => refreshOhlcvForExistingQuotes());
    logStage({ stage: "refresh_ohlcv.done", ok: true, ...r });
    process.exit(0);
  }

  if (cli.backfillFundflow) {
    const days = Number(process.env.STOCK_BACKFILL_DAYS ?? "365");
    const r = await timed("backfill_fundflow", undefined, () => backfillMarginHistory(days));
    logStage({ stage: "backfill_fundflow.done", ok: true, ...r, days });
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

  // 北京时间每个交易日 16:00 触发盘后回顾 + AI 准确率分析
  const reviewTask = cron.schedule(
    "0 16 * * 1-5",
    async () => {
      try {
        logStage({ stage: "cron.review_start", ok: true });
        // reviewRecentPredictions 已内置自动触发 AI 分析
        reviewRecentPredictions(90);
        logStage({ stage: "cron.review_done", ok: true });
      } catch (e) {
        logStage({
          stage: "cron.review_failed",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    { timezone: "Asia/Shanghai" }
  );
  reviewTask.start();
  logStage({ stage: "cron.review_registered", ok: true, expr: "0 16 * * 1-5", tz: "Asia/Shanghai" });

  // 防止进程退出
  process.on("SIGINT", () => {
    logStage({ stage: "shutdown", ok: true, signal: "SIGINT" });
    task.stop();
    reviewTask.stop();
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
