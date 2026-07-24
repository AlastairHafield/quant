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

export async function fetchTrades({ dayKey, limit = 200 } = {}) {
  const db = await getDb();
  const query = dayKey ? { dayKey } : {};
  return db.collection('trades').find(query).sort({ openedAt: -1 }).limit(limit).toArray();
}

export async function fetchExitActions({ dayKey, limit = 200 } = {}) {
  const db = await getDb();
  const query = dayKey ? { dayKey } : {};
  return db.collection('exitActions').find(query).sort({ ts: -1 }).limit(limit).toArray();
}

export async function fetchDailySummaries({ limit = 30 } = {}) {
  const db = await getDb();
  return db.collection('dailySummaries').find({}).sort({ dayKey: -1 }).limit(limit).toArray();
}
