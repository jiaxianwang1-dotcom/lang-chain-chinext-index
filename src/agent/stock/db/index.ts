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

const PREDICTION_EXTRA_COLUMNS: Array<[string, string]> = [
  ["predicted_change_pct_low", "REAL"],
  ["predicted_change_pct_high", "REAL"],
  ["magnitude_bucket", "TEXT"], // "small" | "medium" | "large"
  ["dimensions_used", "INTEGER"],
  ["signals_json", "TEXT"],
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
  for (const [col, def] of PREDICTION_EXTRA_COLUMNS) {
    ensureColumn(db, "index_predictions", col, def);
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

    -- ============ P1：宏观日历（手动 + 启发式种子） ============
    CREATE TABLE IF NOT EXISTS macro_calendar (
      event_date  TEXT NOT NULL,           -- YYYY-MM-DD
      event_code  TEXT NOT NULL,           -- 唯一标识，如 'cpi-2026-05'
      event_name  TEXT NOT NULL,           -- 中文事件名
      importance  INTEGER NOT NULL,        -- 1=低 2=中 3=高
      country     TEXT,                    -- 'CN' / 'US' / 'OTHER'
      expectation TEXT,                    -- 市场预期（可空）
      actual      TEXT,                    -- 实际值（事件发生后可补）
      notes       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (event_date, event_code)
    );
    CREATE INDEX IF NOT EXISTS idx_macro_date ON macro_calendar(event_date);

    -- ============ P1：外资情绪代理（CNH / 恒指 / 沪深300 ETF） ============
    CREATE TABLE IF NOT EXISTS external_proxy (
      trade_date    TEXT NOT NULL,
      symbol        TEXT NOT NULL,          -- 'CNH' / 'HSI' / 'HSTECH' / '510300' / '159915'
      close_value   REAL,
      change_pct    REAL,                   -- 当日相对前日 %
      extra_json    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (trade_date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_external_date ON external_proxy(trade_date DESC, symbol);

    -- ============ P1：股指期货升贴水（IF/IH/IC/IM 当月合约） ============
    CREATE TABLE IF NOT EXISTS futures_basis (
      trade_date     TEXT NOT NULL,
      contract       TEXT NOT NULL,         -- 'IF' / 'IH' / 'IC' / 'IM'
      contract_code  TEXT,                  -- 实际主力合约代码，如 IF2506
      futures_close  REAL,                  -- 当月合约收盘
      spot_close     REAL,                  -- 对应现货指数收盘
      basis          REAL,                  -- 升贴水 = futures - spot（带符号）
      basis_pct      REAL,                  -- basis / spot * 100，%
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (trade_date, contract)
    );
    CREATE INDEX IF NOT EXISTS idx_futures_date ON futures_basis(trade_date DESC, contract);

    -- ============ P2：预测回顾（按 (index_code, target_date) 唯一） ============
    CREATE TABLE IF NOT EXISTS prediction_review (
      index_code        TEXT NOT NULL,
      target_date       TEXT NOT NULL,
      predicted_pct     REAL,               -- 预测涨跌幅 %
      predicted_direction TEXT,             -- "up" / "down"
      predicted_low     REAL,               -- 预测区间下界 %
      predicted_high    REAL,               -- 预测区间上界 %
      confidence        REAL,
      actual_pct        REAL,               -- 实际涨跌幅 %
      actual_direction  TEXT,
      direction_hit     INTEGER,            -- 1=方向命中 / 0=不命中
      range_hit         INTEGER,            -- 1=区间命中 / 0=未命中（缺区间则 NULL）
      pct_abs_error     REAL,               -- |actual - predicted| %
      reviewed_at       TEXT NOT NULL,
      PRIMARY KEY (index_code, target_date)
    );
    CREATE INDEX IF NOT EXISTS idx_review_code_date ON prediction_review(index_code, target_date DESC);
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

export type MagnitudeBucket = "small" | "medium" | "large";

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
  /** P0：区间下界（带符号 %）。例如预测 +0.85%，可能给区间 [+0.3, +1.4]。*/
  predicted_change_pct_low?: number | null;
  /** P0：区间上界（带符号 %）。*/
  predicted_change_pct_high?: number | null;
  /** P0：幅度档位。小幅<0.5% / 中幅 0.5~1.5% / 大幅>=1.5%。*/
  magnitude_bucket?: MagnitudeBucket | null;
  /** P0：实际入 prompt 的维度数（满分 10）。*/
  dimensions_used?: number | null;
  /** P0：每维度倾向 JSON，如 {trend:"up", volume:"down", ...}。*/
  signals_json?: string | null;
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
           predicted_change_pct_low = ?,
           predicted_change_pct_high = ?,
           magnitude_bucket = ?,
           dimensions_used = ?,
           signals_json = ?,
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
      row.predicted_change_pct_low ?? null,
      row.predicted_change_pct_high ?? null,
      row.magnitude_bucket ?? null,
      row.dimensions_used ?? null,
      row.signals_json ?? null,
      now,
      existing.id
    );
    return { ...row, id: existing.id, updated_at: now };
  }

  const result = db
    .prepare(
      `INSERT INTO index_predictions
       (index_code, target_date, predicted_change_pct, direction, confidence,
        rationale, model, based_on_date, predicted_at,
        predicted_change_pct_low, predicted_change_pct_high,
        magnitude_bucket, dimensions_used, signals_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      row.predicted_change_pct_low ?? null,
      row.predicted_change_pct_high ?? null,
      row.magnitude_bucket ?? null,
      row.dimensions_used ?? null,
      row.signals_json ?? null,
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

// ==================== P1: 宏观日历 CRUD ====================

export interface MacroCalendarRow {
  event_date: string;
  event_code: string;
  event_name: string;
  importance: 1 | 2 | 3;
  country: string | null;
  expectation: string | null;
  actual: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

export function upsertMacroEvent(row: MacroCalendarRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO macro_calendar
     (event_date, event_code, event_name, importance, country, expectation, actual, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(event_date, event_code) DO UPDATE SET
       event_name=excluded.event_name,
       importance=excluded.importance,
       country=excluded.country,
       expectation=COALESCE(excluded.expectation, macro_calendar.expectation),
       actual=COALESCE(excluded.actual, macro_calendar.actual),
       notes=COALESCE(excluded.notes, macro_calendar.notes),
       updated_at=excluded.updated_at`
  ).run(
    row.event_date,
    row.event_code,
    row.event_name,
    row.importance,
    row.country,
    row.expectation,
    row.actual,
    row.notes,
    now,
    now
  );
}

export function getMacroEventsInRange(start: string, end: string): MacroCalendarRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM macro_calendar WHERE event_date >= ? AND event_date <= ? ORDER BY event_date ASC, importance DESC"
    )
    .all(start, end) as MacroCalendarRow[];
}

// ==================== P1: 外资情绪代理 CRUD ====================

export interface ExternalProxyRow {
  trade_date: string;
  symbol: string;
  close_value: number | null;
  change_pct: number | null;
  extra_json: string | null;
  created_at?: string;
  updated_at?: string;
}

export function upsertExternalProxy(row: ExternalProxyRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO external_proxy
     (trade_date, symbol, close_value, change_pct, extra_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(trade_date, symbol) DO UPDATE SET
       close_value=excluded.close_value,
       change_pct=excluded.change_pct,
       extra_json=COALESCE(excluded.extra_json, external_proxy.extra_json),
       updated_at=excluded.updated_at`
  ).run(
    row.trade_date,
    row.symbol,
    row.close_value,
    row.change_pct,
    row.extra_json,
    now,
    now
  );
}

export function getExternalProxyInRange(start: string, end: string): ExternalProxyRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM external_proxy WHERE trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC, symbol ASC"
    )
    .all(start, end) as ExternalProxyRow[];
}

// 每个 symbol 各取自己最新一日：
// 不同代理交易时段不同（外汇 24h、港股至 16:00、A 股至 15:00），如果按全局 MAX(trade_date)
// 过滤会导致后收盘的代理（A 股 ETF / 港股）被外汇 / 隔夜更新过的 CNH 抢前，只剩 1 条返回。
// 真正符合直觉的语义是"展示每个代理的当前最新报价"，所以按 symbol 分组取各自的 MAX。
export function getLatestExternalProxy(): ExternalProxyRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT e.* FROM external_proxy e
       INNER JOIN (
         SELECT symbol, MAX(trade_date) AS md
         FROM external_proxy
         GROUP BY symbol
       ) m ON e.symbol = m.symbol AND e.trade_date = m.md
       ORDER BY e.symbol ASC`
    )
    .all() as ExternalProxyRow[];
}

// ==================== P1: 股指期货升贴水 CRUD ====================

export interface FuturesBasisRow {
  trade_date: string;
  contract: string; // "IF" | "IH" | "IC" | "IM"
  contract_code: string | null;
  futures_close: number | null;
  spot_close: number | null;
  basis: number | null;
  basis_pct: number | null;
  created_at?: string;
  updated_at?: string;
}

export function upsertFuturesBasis(row: FuturesBasisRow): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO futures_basis
     (trade_date, contract, contract_code, futures_close, spot_close, basis, basis_pct, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(trade_date, contract) DO UPDATE SET
       contract_code=excluded.contract_code,
       futures_close=excluded.futures_close,
       spot_close=excluded.spot_close,
       basis=excluded.basis,
       basis_pct=excluded.basis_pct,
       updated_at=excluded.updated_at`
  ).run(
    row.trade_date,
    row.contract,
    row.contract_code,
    row.futures_close,
    row.spot_close,
    row.basis,
    row.basis_pct,
    now,
    now
  );
}

// 同 getLatestExternalProxy：按 contract 分组各取自己最新一日，避免某个合约因为
// 入库时机跨日（如夜间 ingest 时被记成 T+1）而把其余合约一起从结果中挤掉。
export function getLatestFuturesBasis(): FuturesBasisRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT f.* FROM futures_basis f
       INNER JOIN (
         SELECT contract, MAX(trade_date) AS md
         FROM futures_basis
         GROUP BY contract
       ) m ON f.contract = m.contract AND f.trade_date = m.md
       ORDER BY f.contract ASC`
    )
    .all() as FuturesBasisRow[];
}

// ==================== P2: 预测回顾 CRUD ====================

export interface PredictionReviewRow {
  index_code: string;
  target_date: string;
  predicted_pct: number | null;
  predicted_direction: "up" | "down" | null;
  predicted_low: number | null;
  predicted_high: number | null;
  confidence: number | null;
  actual_pct: number | null;
  actual_direction: "up" | "down" | null;
  direction_hit: 0 | 1 | null;
  range_hit: 0 | 1 | null;
  pct_abs_error: number | null;
  reviewed_at: string;
}

export function upsertReview(row: PredictionReviewRow): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO prediction_review
     (index_code, target_date, predicted_pct, predicted_direction,
      predicted_low, predicted_high, confidence,
      actual_pct, actual_direction, direction_hit, range_hit, pct_abs_error, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(index_code, target_date) DO UPDATE SET
       predicted_pct=excluded.predicted_pct,
       predicted_direction=excluded.predicted_direction,
       predicted_low=excluded.predicted_low,
       predicted_high=excluded.predicted_high,
       confidence=excluded.confidence,
       actual_pct=excluded.actual_pct,
       actual_direction=excluded.actual_direction,
       direction_hit=excluded.direction_hit,
       range_hit=excluded.range_hit,
       pct_abs_error=excluded.pct_abs_error,
       reviewed_at=excluded.reviewed_at`
  ).run(
    row.index_code,
    row.target_date,
    row.predicted_pct,
    row.predicted_direction,
    row.predicted_low,
    row.predicted_high,
    row.confidence,
    row.actual_pct,
    row.actual_direction,
    row.direction_hit,
    row.range_hit,
    row.pct_abs_error,
    row.reviewed_at
  );
}

export function getReviewsInRange(
  indexCode: string,
  startDate: string,
  endDate: string
): PredictionReviewRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM prediction_review
       WHERE index_code = ? AND target_date >= ? AND target_date <= ?
       ORDER BY target_date ASC`
    )
    .all(indexCode, startDate, endDate) as PredictionReviewRow[];
}

export function getReview(indexCode: string, targetDate: string): PredictionReviewRow | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM prediction_review WHERE index_code = ? AND target_date = ?")
      .get(indexCode, targetDate) as PredictionReviewRow | undefined) ?? null
  );
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
      predicted_change_pct_low REAL, predicted_change_pct_high REAL,
      magnitude_bucket TEXT, dimensions_used INTEGER, signals_json TEXT,
      UNIQUE(index_code, target_date)
    );

    CREATE TABLE IF NOT EXISTS macro_calendar (
      event_date TEXT NOT NULL, event_code TEXT NOT NULL, event_name TEXT NOT NULL,
      importance INTEGER NOT NULL, country TEXT, expectation TEXT, actual TEXT, notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (event_date, event_code)
    );
    CREATE TABLE IF NOT EXISTS external_proxy (
      trade_date TEXT NOT NULL, symbol TEXT NOT NULL,
      close_value REAL, change_pct REAL, extra_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (trade_date, symbol)
    );
    CREATE TABLE IF NOT EXISTS futures_basis (
      trade_date TEXT NOT NULL, contract TEXT NOT NULL, contract_code TEXT,
      futures_close REAL, spot_close REAL, basis REAL, basis_pct REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (trade_date, contract)
    );
    CREATE TABLE IF NOT EXISTS prediction_review (
      index_code TEXT NOT NULL, target_date TEXT NOT NULL,
      predicted_pct REAL, predicted_direction TEXT,
      predicted_low REAL, predicted_high REAL, confidence REAL,
      actual_pct REAL, actual_direction TEXT,
      direction_hit INTEGER, range_hit INTEGER, pct_abs_error REAL,
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (index_code, target_date)
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
