import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");

const MEMORY_DIR = join(PROJECT_ROOT, ".memory");
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

export const STOCK_DB_PATH = join(MEMORY_DIR, "stock_agent.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const db = new Database(STOCK_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS index_quotes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code    TEXT    NOT NULL,
      index_name    TEXT    NOT NULL,
      trade_date    TEXT    NOT NULL,
      close_value   REAL    NOT NULL,
      change        REAL,
      change_pct    REAL,
      change_reason TEXT,
      reason_source TEXT,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      UNIQUE(index_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_index_quotes_trade_date ON index_quotes(trade_date);
    CREATE INDEX IF NOT EXISTS idx_index_quotes_code_date ON index_quotes(index_code, trade_date);

    CREATE TABLE IF NOT EXISTS index_analysis_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code  TEXT    NOT NULL,
      as_of_date  TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      features    TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      UNIQUE(index_code, version)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_code_version ON index_analysis_memory(index_code, version DESC);
  `);

  _db = db;
  return db;
}

// ==================== 行情 CRUD ====================

export interface IndexQuoteRow {
  id?: number;
  index_code: string;
  index_name: string;
  trade_date: string;
  close_value: number;
  change: number | null;
  change_pct: number | null;
  change_reason?: string | null;
  reason_source?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function upsertQuote(row: IndexQuoteRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, change_reason, reason_source FROM index_quotes WHERE index_code = ? AND trade_date = ?")
    .get(row.index_code, row.trade_date) as { id: number; change_reason: string | null; reason_source: string | null } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE index_quotes
       SET index_name = ?, close_value = ?, change = ?, change_pct = ?,
           change_reason = COALESCE(?, change_reason),
           reason_source = COALESCE(?, reason_source),
           updated_at = ?
       WHERE id = ?`
    ).run(
      row.index_name,
      row.close_value,
      row.change,
      row.change_pct,
      row.change_reason ?? null,
      row.reason_source ?? null,
      now,
      existing.id
    );
    return;
  }

  db.prepare(
    `INSERT INTO index_quotes
     (index_code, index_name, trade_date, close_value, change, change_pct, change_reason, reason_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.index_code,
    row.index_name,
    row.trade_date,
    row.close_value,
    row.change,
    row.change_pct,
    row.change_reason ?? null,
    row.reason_source ?? null,
    now,
    now
  );
}

export function updateQuoteReason(indexCode: string, tradeDate: string, reason: string, source: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE index_quotes SET change_reason = ?, reason_source = ?, updated_at = ?
     WHERE index_code = ? AND trade_date = ?`
  ).run(reason, source, now, indexCode, tradeDate);
}

export function getQuote(indexCode: string, tradeDate: string): IndexQuoteRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM index_quotes WHERE index_code = ? AND trade_date = ?")
    .get(indexCode, tradeDate) as IndexQuoteRow | undefined;
  return row ?? null;
}

export function getLatestQuote(indexCode: string): IndexQuoteRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM index_quotes WHERE index_code = ? ORDER BY trade_date DESC LIMIT 1")
    .get(indexCode) as IndexQuoteRow | undefined;
  return row ?? null;
}

export function getQuotesInRange(indexCode: string, startDate: string, endDate: string): IndexQuoteRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM index_quotes WHERE index_code = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC"
    )
    .all(indexCode, startDate, endDate) as IndexQuoteRow[];
}

export function getPreviousTradingDay(indexCode: string, tradeDate: string): IndexQuoteRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM index_quotes WHERE index_code = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1"
    )
    .get(indexCode, tradeDate) as IndexQuoteRow | undefined;
  return row ?? null;
}

export function getQuotesMissingReason(indexCode?: string): IndexQuoteRow[] {
  const db = getDb();
  if (indexCode) {
    return db
      .prepare(
        "SELECT * FROM index_quotes WHERE index_code = ? AND change_reason IS NULL ORDER BY trade_date ASC"
      )
      .all(indexCode) as IndexQuoteRow[];
  }
  return db
    .prepare("SELECT * FROM index_quotes WHERE change_reason IS NULL ORDER BY trade_date ASC")
    .all() as IndexQuoteRow[];
}

export function listExistingDates(indexCode: string): Set<string> {
  const db = getDb();
  const rows = db.prepare("SELECT trade_date FROM index_quotes WHERE index_code = ?").all(indexCode) as Array<{
    trade_date: string;
  }>;
  return new Set(rows.map((r) => r.trade_date));
}

// ==================== 长期分析记忆 ====================

export interface AnalysisMemoryRow {
  id: number;
  index_code: string;
  as_of_date: string;
  summary: string;
  features: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function getLatestMemory(indexCode: string): AnalysisMemoryRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM index_analysis_memory WHERE index_code = ? ORDER BY version DESC LIMIT 1"
    )
    .get(indexCode) as AnalysisMemoryRow | undefined;
  return row ?? null;
}

export function appendMemory(
  indexCode: string,
  asOfDate: string,
  summary: string,
  features: Record<string, unknown> | string
): AnalysisMemoryRow {
  const db = getDb();
  const now = new Date().toISOString();
  const featuresJson = typeof features === "string" ? features : JSON.stringify(features);
  const latest = getLatestMemory(indexCode);
  const nextVersion = latest ? latest.version + 1 : 1;

  const result = db
    .prepare(
      `INSERT INTO index_analysis_memory
       (index_code, as_of_date, summary, features, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(indexCode, asOfDate, summary, featuresJson, nextVersion, now, now);

  return {
    id: Number(result.lastInsertRowid),
    index_code: indexCode,
    as_of_date: asOfDate,
    summary,
    features: featuresJson,
    version: nextVersion,
    created_at: now,
    updated_at: now,
  };
}

// ==================== 测试辅助 ====================

/** 仅用于测试：重新打开一个独立 DB 实例（不影响默认 _db）。*/
export function openDbForTest(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_quotes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code    TEXT    NOT NULL,
      index_name    TEXT    NOT NULL,
      trade_date    TEXT    NOT NULL,
      close_value   REAL    NOT NULL,
      change        REAL,
      change_pct    REAL,
      change_reason TEXT,
      reason_source TEXT,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      UNIQUE(index_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_index_quotes_trade_date ON index_quotes(trade_date);
    CREATE TABLE IF NOT EXISTS index_analysis_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code  TEXT    NOT NULL,
      as_of_date  TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      features    TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      UNIQUE(index_code, version)
    );
  `);
  return db;
}

/** 仅用于测试：替换全局 db 句柄。*/
export function _setDbForTest(db: Database.Database | null): void {
  _db = db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
