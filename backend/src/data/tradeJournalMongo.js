import { MongoClient } from 'mongodb';

// Read-only access to gex-breakout's trade journal (trades, exitActions,
// dailySummaries — see gex-breakout/src/tradeJournal.js, the writer side of
// this same database) for the frontend's Trade Journal tab. Same
// MONGODB_URI as both bots — Heroku config vars are already shared app-wide,
// and this only ever reads.

let client = null;
let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db('gex_breakout'));
  return dbPromise;
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
