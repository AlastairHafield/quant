import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/pead.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS universe (
      symbol TEXT PRIMARY KEY,
      name TEXT,
      sector TEXT,
      market_cap REAL,
      avg_volume REAL,
      added_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS earnings_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      report_date TEXT NOT NULL,
      fiscal_period TEXT,
      actual_eps REAL,
      estimated_eps REAL,
      surprise_pct REAL,
      time_of_day TEXT,  -- 'BMO' or 'AMC'
      reaction_day TEXT,
      reaction_open REAL,
      reaction_prev_close REAL,
      reaction_pct REAL,
      signal TEXT,       -- 'LONG', 'SHORT', or 'NO_TRADE'
      concordant INTEGER DEFAULT 0,
      UNIQUE(symbol, report_date)
    );

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      date_from TEXT,
      date_to TEXT,
      universe_size INTEGER,
      total_trades INTEGER,
      win_rate REAL,
      total_return_pct REAL,
      avg_trade_return_pct REAL,
      sharpe REAL,
      max_drawdown_pct REAL,
      params TEXT  -- JSON blob of run params
    );

    CREATE TABLE IF NOT EXISTS backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES backtest_runs(id),
      symbol TEXT,
      signal TEXT,
      entry_date TEXT,
      entry_price REAL,
      exit_date TEXT,
      exit_price REAL,
      hold_days INTEGER,
      return_pct REAL,
      pnl_dollars REAL,
      earnings_event_id INTEGER REFERENCES earnings_events(id)
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      symbol TEXT,
      date TEXT,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, date)
    );

    CREATE TABLE IF NOT EXISTS intraday_15m (
      symbol TEXT,
      utc_datetime TEXT,
      date TEXT,
      ny_time INTEGER,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, utc_datetime)
    );

    CREATE TABLE IF NOT EXISTS bars_15m (
      symbol TEXT,
      utc_datetime TEXT,
      date TEXT,
      ny_time INTEGER,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, utc_datetime)
    );

    CREATE TABLE IF NOT EXISTS bars_5m (
      symbol TEXT,
      utc_datetime TEXT,
      date TEXT,
      ny_time INTEGER,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, utc_datetime)
    );

    CREATE TABLE IF NOT EXISTS mr_backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      symbol TEXT,
      date_from TEXT,
      date_to TEXT,
      signal_type TEXT,
      timeframe TEXT,
      sweep_id TEXT,
      total_trades INTEGER,
      win_rate REAL,
      total_return_pct REAL,
      avg_trade_return_pct REAL,
      sharpe REAL,
      profit_factor REAL,
      max_drawdown_pct REAL,
      is_trades INTEGER,
      is_win_rate REAL,
      is_return_pct REAL,
      is_sharpe REAL,
      is_profit_factor REAL,
      oos_trades INTEGER,
      oos_win_rate REAL,
      oos_return_pct REAL,
      oos_sharpe REAL,
      oos_profit_factor REAL,
      params TEXT,
      metrics TEXT
    );

    CREATE TABLE IF NOT EXISTS mr_backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES mr_backtest_runs(id),
      trade_date TEXT,
      entry_time INTEGER,
      signal TEXT,
      signal_type TEXT,
      entry_price REAL,
      target_price REAL,
      stop_price REAL,
      exit_price REAL,
      exit_result TEXT,
      bars_held INTEGER,
      return_pct REAL,
      pnl_dollars REAL,
      regime_trend TEXT,
      sample TEXT
    );

    CREATE TABLE IF NOT EXISTS sd_backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      symbol TEXT,
      date_from TEXT,
      date_to TEXT,
      total_trades INTEGER,
      win_rate REAL,
      total_return_pct REAL,
      avg_trade_return_pct REAL,
      sharpe REAL,
      max_drawdown_pct REAL,
      params TEXT
    );

    CREATE TABLE IF NOT EXISTS sd_backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES sd_backtest_runs(id),
      trade_date TEXT,
      signal TEXT,
      zone_top REAL,
      zone_bottom REAL,
      session_ref REAL,
      entry_price REAL,
      target_price REAL,
      stop_price REAL,
      exit_price REAL,
      exit_result TEXT,
      return_pct REAL,
      rr_ratio REAL,
      pnl_dollars REAL
    );
  `);
}

// Universe queries
export function upsertStock(stock) {
  const db = getDb();
  db.prepare(`
    INSERT INTO universe (symbol, name, sector, market_cap, avg_volume)
    VALUES (@symbol, @name, @sector, @market_cap, @avg_volume)
    ON CONFLICT(symbol) DO UPDATE SET
      name = excluded.name,
      sector = excluded.sector,
      market_cap = excluded.market_cap,
      avg_volume = excluded.avg_volume,
      active = 1
  `).run(stock);
}

export function getUniverse() {
  return getDb().prepare('SELECT * FROM universe WHERE active = 1 ORDER BY market_cap DESC').all();
}

export function removeStock(symbol) {
  getDb().prepare('UPDATE universe SET active = 0 WHERE symbol = ?').run(symbol);
}

// Earnings event queries
export function upsertEarningsEvent(event) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO earnings_events
      (symbol, report_date, fiscal_period, actual_eps, estimated_eps, surprise_pct,
       time_of_day, reaction_day, reaction_open, reaction_prev_close, reaction_pct,
       signal, concordant)
    VALUES
      (@symbol, @report_date, @fiscal_period, @actual_eps, @estimated_eps, @surprise_pct,
       @time_of_day, @reaction_day, @reaction_open, @reaction_prev_close, @reaction_pct,
       @signal, @concordant)
    ON CONFLICT(symbol, report_date) DO UPDATE SET
      actual_eps = excluded.actual_eps,
      estimated_eps = excluded.estimated_eps,
      surprise_pct = excluded.surprise_pct,
      reaction_open = excluded.reaction_open,
      reaction_prev_close = excluded.reaction_prev_close,
      reaction_pct = excluded.reaction_pct,
      signal = excluded.signal,
      concordant = excluded.concordant
  `).run(event);
}

export function getEarningsEvents(symbols, dateFrom, dateTo) {
  const db = getDb();
  const placeholders = symbols.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM earnings_events
    WHERE symbol IN (${placeholders})
      AND report_date >= ?
      AND report_date <= ?
      AND concordant = 1
    ORDER BY report_date ASC
  `).all([...symbols, dateFrom, dateTo]);
}

// Price cache
export function upsertPrices(rows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO price_cache (symbol, date, open, high, low, close, volume)
    VALUES (@symbol, @date, @open, @high, @low, @close, @volume)
  `);
  const insertMany = db.transaction((rows) => rows.forEach(r => insert.run(r)));
  insertMany(rows);
}

export function getPrices(symbol, from, to) {
  return getDb().prepare(`
    SELECT * FROM price_cache
    WHERE symbol = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(symbol, from, to);
}

export function saveBacktestRun(run) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO backtest_runs
      (date_from, date_to, universe_size, total_trades, win_rate,
       total_return_pct, avg_trade_return_pct, sharpe, max_drawdown_pct, params)
    VALUES
      (@date_from, @date_to, @universe_size, @total_trades, @win_rate,
       @total_return_pct, @avg_trade_return_pct, @sharpe, @max_drawdown_pct, @params)
  `).run(run);
  return result.lastInsertRowid;
}

export function saveBacktestTrades(trades) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO backtest_trades
      (run_id, symbol, signal, entry_date, entry_price, exit_date,
       exit_price, hold_days, return_pct, pnl_dollars, earnings_event_id)
    VALUES
      (@run_id, @symbol, @signal, @entry_date, @entry_price, @exit_date,
       @exit_price, @hold_days, @return_pct, @pnl_dollars, @earnings_event_id)
  `);
  const insertMany = db.transaction((t) => t.forEach(r => insert.run(r)));
  insertMany(trades);
}

export function getBacktestRuns() {
  return getDb().prepare('SELECT * FROM backtest_runs ORDER BY run_at DESC LIMIT 20').all();
}

export function getBacktestTrades(runId) {
  return getDb().prepare('SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entry_date ASC').all(runId);
}

// Intraday 15m cache
export function upsertIntraday15m(rows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO intraday_15m
      (symbol, utc_datetime, date, ny_time, open, high, low, close, volume)
    VALUES
      (@symbol, @utc_datetime, @date, @ny_time, @open, @high, @low, @close, @volume)
  `);
  db.transaction((rows) => rows.forEach(r => insert.run(r)))(rows);
}

export function getIntraday15m(symbol, from, to) {
  return getDb().prepare(`
    SELECT * FROM intraday_15m
    WHERE symbol = ? AND date >= ? AND date <= ?
    ORDER BY utc_datetime ASC
  `).all(symbol, from, to);
}

// 15m bar cache (chunked, long-history)
export function upsertBars15m(rows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO bars_15m
      (symbol, utc_datetime, date, ny_time, open, high, low, close, volume)
    VALUES
      (@symbol, @utc_datetime, @date, @ny_time, @open, @high, @low, @close, @volume)
  `);
  db.transaction((rows) => rows.forEach(r => insert.run(r)))(rows);
}

export function getBars15m(symbol, from, to) {
  return getDb().prepare(`
    SELECT * FROM bars_15m
    WHERE symbol = ? AND date >= ? AND date <= ?
    ORDER BY utc_datetime ASC
  `).all(symbol, from, to);
}

// 5m bar cache (last ~60 days only from Yahoo)
export function upsertBars5m(rows) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO bars_5m
      (symbol, utc_datetime, date, ny_time, open, high, low, close, volume)
    VALUES
      (@symbol, @utc_datetime, @date, @ny_time, @open, @high, @low, @close, @volume)
  `);
  db.transaction((rows) => rows.forEach(r => insert.run(r)))(rows);
}

export function getBars5m(symbol, from, to) {
  return getDb().prepare(`
    SELECT * FROM bars_5m
    WHERE symbol = ? AND date >= ? AND date <= ?
    ORDER BY utc_datetime ASC
  `).all(symbol, from, to);
}

// Mean-reversion backtest
export function saveMRRun(run) {
  const result = getDb().prepare(`
    INSERT INTO mr_backtest_runs
      (symbol, date_from, date_to, signal_type, timeframe, sweep_id,
       total_trades, win_rate, total_return_pct, avg_trade_return_pct, sharpe, profit_factor, max_drawdown_pct,
       is_trades, is_win_rate, is_return_pct, is_sharpe, is_profit_factor,
       oos_trades, oos_win_rate, oos_return_pct, oos_sharpe, oos_profit_factor,
       params, metrics)
    VALUES
      (@symbol, @date_from, @date_to, @signal_type, @timeframe, @sweep_id,
       @total_trades, @win_rate, @total_return_pct, @avg_trade_return_pct, @sharpe, @profit_factor, @max_drawdown_pct,
       @is_trades, @is_win_rate, @is_return_pct, @is_sharpe, @is_profit_factor,
       @oos_trades, @oos_win_rate, @oos_return_pct, @oos_sharpe, @oos_profit_factor,
       @params, @metrics)
  `).run(run);
  return result.lastInsertRowid;
}

export function saveMRTrades(trades) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO mr_backtest_trades
      (run_id, trade_date, entry_time, signal, signal_type, entry_price, target_price,
       stop_price, exit_price, exit_result, bars_held, return_pct, pnl_dollars, regime_trend, sample)
    VALUES
      (@run_id, @trade_date, @entry_time, @signal, @signal_type, @entry_price, @target_price,
       @stop_price, @exit_price, @exit_result, @bars_held, @return_pct, @pnl_dollars, @regime_trend, @sample)
  `);
  db.transaction((t) => t.forEach(r => insert.run(r)))(trades);
}

export function getMRRuns() {
  return getDb().prepare('SELECT * FROM mr_backtest_runs ORDER BY run_at DESC, id DESC LIMIT 50').all();
}

export function getMRRun(runId) {
  return getDb().prepare('SELECT * FROM mr_backtest_runs WHERE id = ?').get(runId);
}

export function getMRTrades(runId) {
  return getDb().prepare('SELECT * FROM mr_backtest_trades WHERE run_id = ? ORDER BY trade_date ASC, entry_time ASC').all(runId);
}

export function getMRSweep(sweepId) {
  return getDb().prepare('SELECT * FROM mr_backtest_runs WHERE sweep_id = ? ORDER BY oos_sharpe DESC').all(sweepId);
}

// S&D backtest
export function saveSDRun(run) {
  const result = getDb().prepare(`
    INSERT INTO sd_backtest_runs
      (symbol, date_from, date_to, total_trades, win_rate, total_return_pct,
       avg_trade_return_pct, sharpe, max_drawdown_pct, params)
    VALUES
      (@symbol, @date_from, @date_to, @total_trades, @win_rate, @total_return_pct,
       @avg_trade_return_pct, @sharpe, @max_drawdown_pct, @params)
  `).run(run);
  return result.lastInsertRowid;
}

export function saveSDTrades(trades) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO sd_backtest_trades
      (run_id, trade_date, signal, zone_top, zone_bottom, session_ref,
       entry_price, target_price, stop_price, exit_price, exit_result,
       return_pct, rr_ratio, pnl_dollars)
    VALUES
      (@run_id, @trade_date, @signal, @zone_top, @zone_bottom, @session_ref,
       @entry_price, @target_price, @stop_price, @exit_price, @exit_result,
       @return_pct, @rr_ratio, @pnl_dollars)
  `);
  db.transaction((t) => t.forEach(r => insert.run(r)))(trades);
}

export function getSDRuns() {
  return getDb().prepare('SELECT * FROM sd_backtest_runs ORDER BY run_at DESC LIMIT 20').all();
}

export function getSDTrades(runId) {
  return getDb().prepare('SELECT * FROM sd_backtest_trades WHERE run_id = ? ORDER BY trade_date ASC').all(runId);
}
