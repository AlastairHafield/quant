import { MongoClient } from 'mongodb';

// Durable record of every decision the Phase 5 agent harness makes — a
// strategy it kept watching, a proposal it drafted, a grade one agent role
// gave another's proposal, or a promotion/demotion recommendation. Own
// database ("agent_harness"), separate from every bot's own trade-journal
// database and from the kill switch's "control" database, on the same
// shared Mongo cluster (MONGODB_URI).

let client = null;
let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db('agent_harness'));
  return dbPromise;
}

// entry.type is expected to be one of: 'watch' | 'proposal' | 'grade' |
// 'promotion' | 'demotion' | 'error' — not enforced here (Mongo is
// schemaless and the harness itself is what should be constraining this),
// just documented so a reader of this file knows the intended vocabulary.
export async function logAuditEntry(entry) {
  const db = await getDb();
  const doc = { ...entry, loggedAt: new Date().toISOString() };
  await db.collection('auditLog').insertOne(doc);
  return doc;
}

export async function fetchAuditLog({ strategy, type, limit = 100 } = {}) {
  const db = await getDb();
  const query = {};
  if (strategy) query.strategy = strategy;
  if (type) query.type = type;
  return db.collection('auditLog').find(query).sort({ loggedAt: -1 }).limit(limit).toArray();
}
