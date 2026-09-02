import { MongoClient } from 'mongodb';

// Read-only access to the trade journals gex-breakout/mechanical-orb/gap-
// continuation each write to their own Mongo database (see each strategy's
// own tradeJournal.js — trades/signals/exitActions/dailySummaries). Same
// MONGODB_URI as all three bots — Heroku config vars are already shared
// app-wide, and this only ever reads.

const STRATEGY_DBS = ['gex_breakout', 'mechanical_orb', 'gap_continuation'];

let client = null;
let clientPromise = null;

function getClient() {
  if (clientPromise) return clientPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  clientPromise = client.connect().then(() => client);
  return clientPromise;
}

// Unchanged from before Phase 3 — gex-breakout specific, used by the existing
// Trade Journal dashboard tab. A single MongoClient connection serves every
// database on the same cluster (Mongo connections are cluster-level, not
// database-level), so this doesn't open a second connection.
async function getDb() {
  const c = await getClient();
  return c.db('gex_breakout');
}

// accountRole distinguishes Strategy A's practice-account trades ("A") from
// everything else's real-Combine trades ("default") — see gex-breakout's
// worker.js accountRoleFor(). Older docs predate this field entirely, which
// is why the query only adds the filter when accountRole was actually asked
// for, rather than always matching it strictly (a strict {accountRole:
// 'default'} filter would silently exclude every pre-existing real trade).
export async function fetchTrades({ dayKey, accountRole, limit = 200 } = {}) {
  const db = await getDb();
  const query = {};
  if (dayKey) query.dayKey = dayKey;
  if (accountRole === 'A') query.accountRole = 'A';
  else if (accountRole === 'default') query.accountRole = { $ne: 'A' };
  return db.collection('trades').find(query).sort({ openedAt: -1 }).limit(limit).toArray();
}

export async function fetchExitActions({ dayKey, limit = 200 } = {}) {
  const db = await getDb();
  const query = dayKey ? { dayKey } : {};
  return db.collection('exitActions').find(query).sort({ ts: -1 }).limit(limit).toArray();
}

// dayKey is a "Www Mon DD YYYY" string (Date.prototype.toDateString()) — sorting
// it as a string is NOT chronological, since the weekday abbreviation comes
// first (e.g. "Wed Jul 22 2026" > "Tue Jul 28 2026" lexicographically, despite
// being 6 days earlier). Caught live 2026-07-28: the Trade Journal's "Today"
// panel was stuck showing a Sunday from days earlier because it happened to
// sort ahead of the actually-more-recent weekdays. Sorted in JS instead of via
// Mongo's own .sort(), by parsing dayKey back into a real Date (the same
// format toDateString() produces round-trips cleanly through `new Date(...)`)
// — daily summaries are capped at one per calendar day, so fetching the full
// (small) collection and sorting in memory is cheap.
export async function fetchDailySummaries({ limit = 30 } = {}) {
  const db = await getDb();
  const docs = await db.collection('dailySummaries').find({}).toArray();
  docs.sort((a, b) => new Date(b.dayKey) - new Date(a.dayKey));
  return docs.slice(0, limit);
}

// ─── Phase 3: unified ledger across all three strategy databases ────────────
// Added on top of the gex-breakout-only reads above (which stay exactly as
// they were, for the existing Trade Journal dashboard tab) — an agent (or a
// future combined dashboard) grading "is this strategy still working" needs
// one place to look, not three separate Mongo databases with no shared view.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Every strategy's trades collection shares the same shape closely enough
// (system, dayKey, status, realizedPnl, mfe, mae — see each bot's own
// tradeJournal.js openTrade/closeTrade) to merge directly; _dbName is added
// for traceability back to which database a doc actually came from, distinct
// from its own `system` field (present on every doc already, but kept
// separate here in case an older doc predates it).
//
// dayKey filters to one exact calendar day (matches fetchTrades' own
// convention). closedFrom/closedTo (ISO strings) instead filter on a real
// range via the closedAt field — used by the reconciliation endpoint, which
// needs "the last N trading days," not one specific day; dayKey's own
// "Www Mon DD YYYY" string doesn't sort/range chronologically (see
// fetchDailySummaries' comment above), so a range query has to go through
// closedAt instead.
export async function fetchLedgerTrades({ dayKey, closedFrom, closedTo, system, limit = 500 } = {}) {
  const c = await getClient();
  const dbNames = system ? [system] : STRATEGY_DBS;
  const query = {};
  if (dayKey) query.dayKey = dayKey;
  if (closedFrom || closedTo) {
    query.closedAt = {};
    if (closedFrom) query.closedAt.$gte = closedFrom;
    if (closedTo) query.closedAt.$lte = closedTo;
  }
  const perDb = await Promise.all(dbNames.map(async (dbName) => {
    const docs = await c.db(dbName).collection('trades').find(query).sort({ openedAt: -1 }).limit(limit).toArray();
    return docs.map((d) => ({ ...d, _dbName: dbName }));
  }));
  return perDb.flat().sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
}

// Pure aggregation, split out from fetchDailyLedger below so it's testable
// without a live Mongo connection — realized P&L / win-loss / MFE-MAE per
// strategy AND account-wide, for CLOSED trades only (an open trade has no
// realizedPnl yet and would silently corrupt totalPnl if included).
export function aggregateDailyLedger(dayKey, trades) {
  const closed = trades.filter((t) => t.status === 'closed' && typeof t.realizedPnl === 'number');
  const byStrategy = {};
  for (const t of closed) {
    const key = t.system || t._dbName;
    byStrategy[key] ??= { trades: 0, wins: 0, losses: 0, totalRealizedPnl: 0, mfeSum: 0, mfeCount: 0, maeSum: 0, maeCount: 0 };
    const s = byStrategy[key];
    s.trades += 1;
    if (t.realizedPnl > 0) s.wins += 1;
    else if (t.realizedPnl < 0) s.losses += 1;
    s.totalRealizedPnl += t.realizedPnl;
    if (typeof t.mfe === 'number') { s.mfeSum += t.mfe; s.mfeCount += 1; }
    if (typeof t.mae === 'number') { s.maeSum += t.mae; s.maeCount += 1; }
  }
  for (const s of Object.values(byStrategy)) {
    s.winRate = s.trades ? round2((s.wins / s.trades) * 100) : 0;
    s.totalRealizedPnl = round2(s.totalRealizedPnl);
    s.avgMfe = s.mfeCount ? round2(s.mfeSum / s.mfeCount) : null;
    s.avgMae = s.maeCount ? round2(s.maeSum / s.maeCount) : null;
    delete s.mfeSum; delete s.mfeCount; delete s.maeSum; delete s.maeCount;
  }
  const wins = closed.filter((t) => t.realizedPnl > 0).length;
  const losses = closed.filter((t) => t.realizedPnl < 0).length;
  const totalRealizedPnl = round2(closed.reduce((s, t) => s + t.realizedPnl, 0));
  return {
    dayKey,
    byStrategy,
    accountWide: {
      trades: closed.length,
      wins,
      losses,
      winRate: closed.length ? round2((wins / closed.length) * 100) : 0,
      totalRealizedPnl,
    },
  };
}

export async function fetchDailyLedger(dayKey) {
  const trades = await fetchLedgerTrades({ dayKey, limit: 1000 });
  return aggregateDailyLedger(dayKey, trades);
}
