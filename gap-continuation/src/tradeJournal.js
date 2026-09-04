import { MongoClient } from "mongodb";

// Durable persistence for every evaluated signal (taken or vetoed) and every
// real trade — same pattern as gex-breakout/mechanical-orb, own database name
// within the shared cluster so records don't mix across bots.

let client = null;
let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set — see gap-continuation/.env.example");
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db("gap_continuation"));
  return dbPromise;
}

export async function logSignal(row, dayKey) {
  const db = await getDb();
  await db.collection("signals").insertOne({ ...row, dayKey });
}

// Called once a real order is confirmed placed — returns the Mongo _id so the
// caller can attach it to openPosition and later use it to update this same
// document on close, rather than inserting a new row.
export async function openTrade(position, dayKey) {
  const db = await getDb();
  const doc = {
    system: "gap-continuation",
    direction: position.direction,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    originalStopPrice: position.stopPrice,
    targetPrice: position.targetPrice,
    originalTargetPrice: position.targetPrice,
    gapPct: position.gapPct,
    contractId: position.contractId,
    size: position.size,
    orderId: position.orderId,
    openedAt: new Date().toISOString(),
    dayKey,
    status: "open",
    closedAt: null,
    exitPrice: null,
    outcome: null,
    mfe: 0,
    mae: 0,
  };
  const result = await db.collection("trades").insertOne(doc);
  return result.insertedId;
}

export async function closeTrade(mongoId, update) {
  if (!mongoId) return;
  const db = await getDb();
  await db.collection("trades").updateOne({ _id: mongoId }, { $set: { status: "closed", ...update } });
}

// Our own last-opened trade still marked "open" — the only thing
// reconcileUntrackedPosition() in worker.js is allowed to treat as a real
// position to recover after a restart (see reconcileDecision's header
// comment for why: adopting ANY open broker position, not just our own,
// silently misattributed 41 other bots' trades to this ledger — 2026-09-04,
// debateId 41a990f0-ed00-4e30-b8fe-cbb7210d11f3). Sorted newest-first so a
// leftover stale doc from the old bug (there should only ever be one open
// doc at a time going forward) doesn't shadow a real, more recent one.
export async function findOpenTrade() {
  const db = await getDb();
  return db.collection("trades").find({ status: "open" }).sort({ openedAt: -1 }).limit(1).next();
}

export async function fetchDayRows(dayKey) {
  const db = await getDb();
  return db.collection("signals").find({ dayKey }).sort({ ts: 1 }).toArray();
}

export async function isDayFlushed(dayKey) {
  const db = await getDb();
  const existing = await db.collection("logFlushes").findOne({ dayKey });
  return existing != null;
}

export async function markDayFlushed(dayKey) {
  const db = await getDb();
  await db.collection("logFlushes").insertOne({ dayKey, flushedAt: new Date().toISOString() });
}
