import { getDb, upsertQuote, type IndexQuoteRow } from "./db/index.js";
import { defaultProvider, listTargetIndexes } from "./providers/index.js";
import { logStage } from "./utils/log.js";

/**
 * 修复历史行情数据：拉东方财富 K 线，重新计算 change/change_pct，覆盖已有记录。
 * 用于修复盘中快照未被收盘价覆盖的问题。
 */
async function fixQuotes(): Promise<void> {
  const db = getDb();

  for (const meta of listTargetIndexes()) {
    // 取该指数所有已有日期
    const rows = db
      .prepare("SELECT trade_date FROM index_quotes WHERE index_code = ? ORDER BY trade_date ASC")
      .all(meta.index_code) as Array<{ trade_date: string }>;

    if (rows.length === 0) {
      console.log(`${meta.index_code}: 无历史数据，跳过`);
      continue;
    }

    const start = rows[0].trade_date;
    const end = rows[rows.length - 1].trade_date;

    // 拉东方财富历史 K 线
    const quotes = await defaultProvider.fetchHistoricalQuotes(meta.index_code, start, end);
    quotes.sort((a, b) => a.trade_date.localeCompare(b.trade_date));

    let prevClose: number | null = null;
    let fixed = 0;

    for (const q of quotes) {
      const existing = db
        .prepare("SELECT * FROM index_quotes WHERE index_code = ? AND trade_date = ?")
        .get(meta.index_code, q.trade_date) as IndexQuoteRow | undefined;

      if (!existing) continue;

      // 重新计算 change / change_pct
      let change: number | null = null;
      let change_pct: number | null = null;
      if (prevClose != null && prevClose !== 0) {
        change = q.close_value - prevClose;
        change_pct = (change / prevClose) * 100;
      }

      // 只有当 close 或 change_pct 有变化时才更新
      const closeDiff = Math.abs(q.close_value - existing.close_value) > 0.001;
      const pctDiff =
        change_pct == null || existing.change_pct == null
          ? change_pct !== existing.change_pct
          : Math.abs(change_pct - existing.change_pct) > 0.001;

      if (closeDiff || pctDiff) {
        upsertQuote({
          index_code: q.index_code,
          index_name: q.index_name,
          trade_date: q.trade_date,
          close_value: q.close_value,
          open_value: q.open_value ?? existing.open_value ?? null,
          high_value: q.high_value ?? existing.high_value ?? null,
          low_value: q.low_value ?? existing.low_value ?? null,
          volume: q.volume ?? existing.volume ?? null,
          turnover: q.turnover ?? existing.turnover ?? null,
          change,
          change_pct,
          change_reason: existing.change_reason ?? null,
          reason_source: existing.reason_source ?? null,
        });
        fixed++;
      }

      prevClose = q.close_value;
    }

    logStage({
      stage: "fix_quotes.done",
      ok: true,
      indexCode: meta.index_code,
      checked: quotes.length,
      fixed,
    });
    console.log(`${meta.index_code}: 检查了 ${quotes.length} 天，修复了 ${fixed} 天`);
  }
}

fixQuotes().catch((e) => {
  console.error("修复失败:", e);
  process.exit(1);
});
