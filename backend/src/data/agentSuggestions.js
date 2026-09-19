import { MongoClient } from 'mongodb';

// User-submitted suggestions for the Phase 5 agent harness — a free-text box
// on the dashboard (AgentHarnessDashboard.js) so the user can steer the next
// scheduled run ("look at X", "try Y") without editing PROTOCOL.md or the
// code directly. Same "agent_harness" database as agentAuditLog.js, on the
// same shared Mongo cluster (MONGODB_URI) — a separate collection, not mixed
// into the audit trail itself.
//
// The harness has zero memory between runs (see PROTOCOL.md's opening line),
// so a suggestion has to be durable and re-readable, not just posted to
// Discord and forgotten. `status` tracks whether a run has already picked it
// up: 'new' until some run reads it and marks it 'read' (see
// markSuggestionRead) — without that, every future run would re-surface the
// same suggestion forever with no way to tell "already considered" from
// "not yet seen."

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

export async function submitSuggestion(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('Suggestion text is required');
  const db = await getDb();
  const doc = { text: trimmed, status: 'new', createdAt: new Date().toISOString() };
  const result = await db.collection('suggestions').insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function fetchSuggestions({ status, limit = 50 } = {}) {
  const db = await getDb();
  const query = {};
  if (status) query.status = status;
  return db.collection('suggestions').find(query).sort({ createdAt: -1 }).limit(limit).toArray();
}

// Idempotent by design (an already-read suggestion just gets restamped) so a
// run that dies partway through marking several as read can be safely rerun
// without a "was this one already marked?" check first.
export async function markSuggestionRead(id) {
  const { ObjectId } = await import('mongodb');
  const db = await getDb();
  const result = await db.collection('suggestions').updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'read', readAt: new Date().toISOString() } },
  );
  return { matched: result.matchedCount > 0 };
}
