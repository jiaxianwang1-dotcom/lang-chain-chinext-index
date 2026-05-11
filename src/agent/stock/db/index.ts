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

const QUOTE_OHLCV_COLUMNS: Array<[string, string]> = [
  ["open_value", "REAL"],
  ["high_value", "REAL"],
  ["low_value", "REAL"],
  ["volume", "REAL"], // 成交量（东方财富口径：手）
  ["turnover", "REAL"], // 成交额（元）
];

function ensureColumn(db: Database.Database, table: string, col: string, def: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((r) => r.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

function applyMigrations(db: Database.Database): void {
  for (const [col, def] of QUOTE_OHLCV_COLUMNS) {
    ensureColumn(db, "index_quotes", col, def);
  }
}

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
      open_value    REAL,
      high_value    REAL,
      low_value     REAL,
      volume        REAL,
      turnover      REAL,
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

    -- ============ Phase 9 multi-signal: 4 张新表 ============

    CREATE TABLE IF NOT EXISTS margin_balance (
      trade_date       TEXT PRIMARY KEY,
      finance_balance  REAL,
      finance_buy      REAL,
      finance_repay    REAL,
      finance_net      REAL,
      finance_net_3d   REAL,
      finance_net_5d   REAL,
      short_balance    REAL,
      short_net        REAL,
      total_balance    REAL,
      market_index     REAL,
      raw_json         TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_margin_date ON margin_balance(trade_date DESC);

    CREATE TABLE IF NOT EXISTS market_breadth (
      trade_date  TEXT NOT NULL,
      scope       TEXT NOT NULL,
      advancing   INTEGER,
      declining   INTEGER,
      unchanged   INTEGER,
      limit_up    INTEGER,
      limit_down  INTEGER,
      raw_json    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (trade_date, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_breadth_date ON market_breadth(trade_date DESC);

    CREATE TABLE IF NOT EXISTS sector_quote (
      trade_date    TEXT NOT NULL,
      sector_code   TEXT NOT NULL,
      sector_name   TEXT NOT NULL,
      change_pct    REAL,
      total_value   REAL,
      total_amount  REAL,
      turnover_pct  REAL,
      rank_type     TEXT NOT NULL,
      rank_pos      INTEGER NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (trade_date, sector_code, rank_type)
    );
    CREATE INDEX IF NOT EXISTS idx_sector_date ON sector_quote(trade_date DESC, rank_type, rank_pos);

    CREATE TABLE IF NOT EXISTS lhb_record (
      trade_date     TEXT NOT NULL,
      security_code  TEXT NOT NULL,
      security_name  TEXT,
      close_price    REAL,
      change_rate    REAL,
      net_amount     REAL,
      buy_amount     REAL,
      sell_amount    REAL,
      market         TEXT,
      explanation    TEXT,
      raw_json       TEXT,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (trade_date, security_code)
    );
    CREATE INDEX IF NOT EXISTS idx_lhb_date ON lhb_record(trade_date DESC);

    CREATE TABLE IF NOT EXISTS news_event (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date      TEXT NOT NULL,
      source          TEXT,
      url             TEXT,
      title           TEXT NOT NULL,
      summary         TEXT,
      category        TEXT,
      sentiment       REAL,
      impact_indices  TEXT,
      rationale       TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_event_date ON news_event(as_of_date DESC);
    CREATE INDEX IF NOT EXISTS idx_news_event_dedup ON news_event(as_of_date, title);

    -- ============ AI 涨跌幅预测：按 (index_code, target_date) 唯一 ============
    CREATE TABLE IF NOT EXISTS index_predictions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code            TEXT NOT NULL,
      target_date           TEXT NOT NULL,        -- 预测目标交易日 YYYY-MM-DD
      predicted_change_pct  REAL,                  -- 预测涨跌幅（%，已是 1.5 表示 +1.5%）
      direction             TEXT,                  -- "up" / "down"
      confidence            REAL,                  -- 0 ~ 1
      rationale             TEXT,                  -- LLM 给出的理由
      model                 TEXT,                  -- 模型标识，如 "glm-4-flash"
      based_on_date         TEXT,                  -- 预测时所用最后一日数据
      predicted_at          TEXT NOT NULL,         -- 预测生成时间 ISO
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      UNIQUE(index_code, target_date)
    );
    CREATE INDEX IF NOT EXISTS idx_predictions_code_date ON index_predictions(index_code, target_date DESC);
  `);

  // 给已经存在的 index_quotes 表补齐 OHLCV 列（向前迁移，幂等）
  applyMigrations(db);

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
  open_value?: number | null;
  high_value?: number | null;
  low_value?: number | null;
  volume?: number | null;
  turnover?: number | null;
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
    .prepare("SELECT id FROM index_quotes WHERE index_code = ? AND trade_date = ?")
    .get(row.index_code, row.trade_date) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE index_quotes
       SET index_name = ?,
           close_value = ?,
           open_value  = COALESCE(?, open_value),
           high_value  = COALESCE(?, high_value),
           low_value   = COALESCE(?, low_value),
           volume      = COALESCE(?, volume),
           turnover    = COALESCE(?, turnover),
           change      = ?,
           change_pct  = ?,
           change_reason = COALESCE(?, change_reason),
           reason_source = COALESCE(?, reason_source),
           updated_at = ?
       WHERE id = ?`
    ).run(
      row.index_name,
      row.close_value,
      row.open_value ?? null,
      row.high_value ?? null,
      row.low_value ?? null,
      row.volume ?? null,
      row.turnover ?? null,
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
     (index_code, index_name, trade_date, close_value,
      open_value, high_value, low_value, volume, turnover,
      change, change_pct, change_reason, reason_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.index_code,
    row.index_name,
    row.trade_date,
    row.close_value,
    row.open_value ?? null,
    row.high_value ?? null,
    row.low_value ?? null,
    row.volume ?? null,
    row.turnover ?? null,
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

// ==================== Phase 9 multi-signal: 类型 + CRUD ====================

export interface MarginBalanceRow {
  trade_date: string;
  finance_balance: number | null;
  finance_buy: number | null;
  finance_repay: number | null;
  finance_net: number | null;
  finance_net_3d: number | null;
  finance_net_5d: number | null;
  short_balance: number | null;
  short_net: number | null;
  total_balance: number | null;
  market_index: number | null;
  raw_json?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function upsertMargin(row: MarginBalanceRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO margin_balance
     (trade_date, finance_balance, finance_buy, finance_repay, finance_net,
      finance_net_3d, finance_net_5d, short_balance, short_net, total_balance,
      market_index, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(trade_date) DO UPDATE SET
       finance_balance=excluded.finance_balance,
       finance_buy=excluded.finance_buy,
       finance_repay=excluded.finance_repay,
       finance_net=excluded.finance_net,
       finance_net_3d=excluded.finance_net_3d,
       finance_net_5d=excluded.finance_net_5d,
       short_balance=excluded.short_balance,
       short_net=excluded.short_net,
       total_balance=excluded.total_balance,
       market_index=excluded.market_index,
       raw_json=COALESCE(excluded.raw_json, margin_balance.raw_json),
       updated_at=excluded.updated_at`
  ).run(
    row.trade_date,
    row.finance_balance,
    row.finance_buy,
    row.finance_repay,
    row.finance_net,
    row.finance_net_3d,
    row.finance_net_5d,
    row.short_balance,
    row.short_net,
    row.total_balance,
    row.market_index,
    row.raw_json ?? null,
    now,
    now
  );
}

export function getLatestMargin(): MarginBalanceRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM margin_balance ORDER BY trade_date DESC LIMIT 1")
      .get() as MarginBalanceRow | undefined) ?? null
  );
}

export function getMarginInRange(start: string, end: string): MarginBalanceRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM margin_balance WHERE trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC"
    )
    .all(start, end) as MarginBalanceRow[];
}

export interface MarketBreadthRow {
  trade_date: string;
  scope: "sse" | "szse" | "chinext";
  advancing: number | null;
  declining: number | null;
  unchanged: number | null;
  limit_up: number | null;
  limit_down: number | null;
  raw_json?: string | null;
}

export function upsertBreadth(row: MarketBreadthRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO market_breadth
     (trade_date, scope, advancing, declining, unchanged, limit_up, limit_down, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(trade_date, scope) DO UPDATE SET
       advancing=excluded.advancing,
       declining=excluded.declining,
       unchanged=excluded.unchanged,
       limit_up=COALESCE(excluded.limit_up, market_breadth.limit_up),
       limit_down=COALESCE(excluded.limit_down, market_breadth.limit_down),
       raw_json=COALESCE(excluded.raw_json, market_breadth.raw_json),
       updated_at=excluded.updated_at`
  ).run(
    row.trade_date,
    row.scope,
    row.advancing,
    row.declining,
    row.unchanged,
    row.limit_up,
    row.limit_down,
    row.raw_json ?? null,
    now,
    now
  );
}

export function getBreadthInRange(
  start: string,
  end: string,
  scope?: MarketBreadthRow["scope"]
): MarketBreadthRow[] {
  const db = getDb();
  if (scope) {
    return db
      .prepare(
        "SELECT * FROM market_breadth WHERE trade_date >= ? AND trade_date <= ? AND scope = ? ORDER BY trade_date ASC"
      )
      .all(start, end, scope) as MarketBreadthRow[];
  }
  return db
    .prepare(
      "SELECT * FROM market_breadth WHERE trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC, scope ASC"
    )
    .all(start, end) as MarketBreadthRow[];
}

export function getLatestBreadth(scope?: MarketBreadthRow["scope"]): MarketBreadthRow[] {
  const db = getDb();
  if (scope) {
    const r = db
      .prepare("SELECT * FROM market_breadth WHERE scope = ? ORDER BY trade_date DESC LIMIT 1")
      .get(scope) as MarketBreadthRow | undefined;
    return r ? [r] : [];
  }
  // 取最近一个 trade_date 的全部 3 个 scope
  const latest = db
    .prepare("SELECT trade_date FROM market_breadth ORDER BY trade_date DESC LIMIT 1")
    .get() as { trade_date: string } | undefined;
  if (!latest) return [];
  return db
    .prepare("SELECT * FROM market_breadth WHERE trade_date = ?")
    .all(latest.trade_date) as MarketBreadthRow[];
}

export interface SectorQuoteRow {
  trade_date: string;
  sector_code: string;
  sector_name: string;
  change_pct: number | null;
  total_value: number | null;
  total_amount: number | null;
  turnover_pct: number | null;
  rank_type: "top5" | "bottom5";
  rank_pos: number;
}

export function replaceSectorRotation(date: string, rows: SectorQuoteRow[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction((rs: SectorQuoteRow[]) => {
    db.prepare("DELETE FROM sector_quote WHERE trade_date = ?").run(date);
    const stmt = db.prepare(
      `INSERT INTO sector_quote
       (trade_date, sector_code, sector_name, change_pct, total_value,
        total_amount, turnover_pct, rank_type, rank_pos, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of rs) {
      stmt.run(
        r.trade_date,
        r.sector_code,
        r.sector_name,
        r.change_pct,
        r.total_value,
        r.total_amount,
        r.turnover_pct,
        r.rank_type,
        r.rank_pos,
        now
      );
    }
  });
  tx(rows);
}

export function getLatestSectorRotation(): SectorQuoteRow[] {
  const db = getDb();
  const latest = db
    .prepare("SELECT trade_date FROM sector_quote ORDER BY trade_date DESC LIMIT 1")
    .get() as { trade_date: string } | undefined;
  if (!latest) return [];
  return db
    .prepare(
      "SELECT * FROM sector_quote WHERE trade_date = ? ORDER BY rank_type ASC, rank_pos ASC"
    )
    .all(latest.trade_date) as SectorQuoteRow[];
}

export interface LhbRow {
  trade_date: string;
  security_code: string;
  security_name: string | null;
  close_price: number | null;
  change_rate: number | null;
  net_amount: number | null;
  buy_amount: number | null;
  sell_amount: number | null;
  market: string | null;
  explanation: string | null;
  raw_json?: string | null;
}

export function upsertLhb(row: LhbRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO lhb_record
     (trade_date, security_code, security_name, close_price, change_rate,
      net_amount, buy_amount, sell_amount, market, explanation, raw_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(trade_date, security_code) DO UPDATE SET
       security_name=excluded.security_name,
       close_price=excluded.close_price,
       change_rate=excluded.change_rate,
       net_amount=excluded.net_amount,
       buy_amount=excluded.buy_amount,
       sell_amount=excluded.sell_amount,
       market=excluded.market,
       explanation=excluded.explanation,
       raw_json=COALESCE(excluded.raw_json, lhb_record.raw_json)`
  ).run(
    row.trade_date,
    row.security_code,
    row.security_name,
    row.close_price,
    row.change_rate,
    row.net_amount,
    row.buy_amount,
    row.sell_amount,
    row.market,
    row.explanation,
    row.raw_json ?? null,
    now
  );
}

export function getLhbByDate(date: string): LhbRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM lhb_record WHERE trade_date = ? ORDER BY ABS(net_amount) DESC")
    .all(date) as LhbRow[];
}

export function getLatestLhbDate(): string | null {
  const db = getDb();
  const r = db.prepare("SELECT trade_date FROM lhb_record ORDER BY trade_date DESC LIMIT 1").get() as
    | { trade_date: string }
    | undefined;
  return r?.trade_date ?? null;
}

export interface NewsEventRow {
  id?: number;
  as_of_date: string;
  source: string | null;
  url: string | null;
  title: string;
  summary: string | null;
  category: string | null;
  sentiment: number | null;
  impact_indices: string | null; // JSON array as string OR 'broad'
  rationale: string | null;
  created_at?: string;
}

export function insertNewsEventIfAbsent(row: NewsEventRow): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const exists = db
    .prepare("SELECT id FROM news_event WHERE as_of_date = ? AND title = ? LIMIT 1")
    .get(row.as_of_date, row.title) as { id: number } | undefined;
  if (exists) return false;
  db.prepare(
    `INSERT INTO news_event
     (as_of_date, source, url, title, summary, category, sentiment, impact_indices, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.as_of_date,
    row.source,
    row.url,
    row.title,
    row.summary,
    row.category,
    row.sentiment,
    row.impact_indices,
    row.rationale,
    now
  );
  return true;
}

export function getNewsByDate(date: string, limit = 20): NewsEventRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM news_event WHERE as_of_date = ?
       ORDER BY ABS(COALESCE(sentiment, 0)) DESC, id ASC
       LIMIT ?`
    )
    .all(date, limit) as NewsEventRow[];
}

// ==================== AI 涨跌幅预测 CRUD ====================

export interface IndexPredictionRow {
  id?: number;
  index_code: string;
  target_date: string;
  predicted_change_pct: number | null;
  direction: "up" | "down" | null;
  confidence: number | null;
  rationale: string | null;
  model: string | null;
  based_on_date: string | null;
  predicted_at: string;
  created_at?: string;
  updated_at?: string;
}

export function upsertPrediction(row: IndexPredictionRow): IndexPredictionRow {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM index_predictions WHERE index_code = ? AND target_date = ?")
    .get(row.index_code, row.target_date) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE index_predictions
       SET predicted_change_pct = ?,
           direction = ?,
           confidence = ?,
           rationale = ?,
           model = ?,
           based_on_date = ?,
           predicted_at = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      row.predicted_change_pct,
      row.direction,
      row.confidence,
      row.rationale,
      row.model,
      row.based_on_date,
      row.predicted_at,
      now,
      existing.id
    );
    return { ...row, id: existing.id, updated_at: now };
  }

  const result = db
    .prepare(
      `INSERT INTO index_predictions
       (index_code, target_date, predicted_change_pct, direction, confidence,
        rationale, model, based_on_date, predicted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.index_code,
      row.target_date,
      row.predicted_change_pct,
      row.direction,
      row.confidence,
      row.rationale,
      row.model,
      row.based_on_date,
      row.predicted_at,
      now,
      now
    );
  return { ...row, id: Number(result.lastInsertRowid), created_at: now, updated_at: now };
}

export function getPrediction(indexCode: string, targetDate: string): IndexPredictionRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM index_predictions WHERE index_code = ? AND target_date = ?")
    .get(indexCode, targetDate) as IndexPredictionRow | undefined;
  return row ?? null;
}

export function getPredictionsInRange(
  indexCode: string,
  startDate: string,
  endDate: string
): IndexPredictionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM index_predictions
       WHERE index_code = ? AND target_date >= ? AND target_date <= ?
       ORDER BY target_date ASC`
    )
    .all(indexCode, startDate, endDate) as IndexPredictionRow[];
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
      open_value    REAL,
      high_value    REAL,
      low_value     REAL,
      volume        REAL,
      turnover      REAL,
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

    CREATE TABLE IF NOT EXISTS margin_balance (
      trade_date       TEXT PRIMARY KEY,
      finance_balance  REAL,
      finance_buy      REAL,
      finance_repay    REAL,
      finance_net      REAL,
      finance_net_3d   REAL,
      finance_net_5d   REAL,
      short_balance    REAL,
      short_net        REAL,
      total_balance    REAL,
      market_index     REAL,
      raw_json         TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_breadth (
      trade_date  TEXT NOT NULL,
      scope       TEXT NOT NULL,
      advancing   INTEGER, declining INTEGER, unchanged INTEGER,
      limit_up    INTEGER, limit_down INTEGER,
      raw_json    TEXT,
      created_at  TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (trade_date, scope)
    );
    CREATE TABLE IF NOT EXISTS sector_quote (
      trade_date    TEXT NOT NULL, sector_code TEXT NOT NULL, sector_name TEXT NOT NULL,
      change_pct REAL, total_value REAL, total_amount REAL, turnover_pct REAL,
      rank_type TEXT NOT NULL, rank_pos INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (trade_date, sector_code, rank_type)
    );
    CREATE TABLE IF NOT EXISTS lhb_record (
      trade_date TEXT NOT NULL, security_code TEXT NOT NULL, security_name TEXT,
      close_price REAL, change_rate REAL, net_amount REAL, buy_amount REAL, sell_amount REAL,
      market TEXT, explanation TEXT, raw_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (trade_date, security_code)
    );
    CREATE TABLE IF NOT EXISTS news_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL, source TEXT, url TEXT, title TEXT NOT NULL,
      summary TEXT, category TEXT, sentiment REAL, impact_indices TEXT, rationale TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      index_code TEXT NOT NULL, target_date TEXT NOT NULL,
      predicted_change_pct REAL, direction TEXT, confidence REAL, rationale TEXT,
      model TEXT, based_on_date TEXT,
      predicted_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(index_code, target_date)
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
