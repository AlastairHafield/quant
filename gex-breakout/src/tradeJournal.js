import { MongoClient } from "mongodb";

// Durable persistence for every evaluated signal (taken or vetoed) and every
// real trade — replaces the in-memory logger.buffer as the source of truth
// for anything that needs to survive a worker restart (which happens on
// every deploy). See gex-breakout/src/worker.js's removed SIGTERM handler:
// that used to flush the in-memory buffer to Discord on every restart as a
// data-loss safety net, which is exactly why log dumps showed up at
// scattered times through the day instead of once at session end. Once
// events are durable here, that safety net isn't needed.

let client = null;
let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set — see gex-breakout/.env.example");
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db("gex_breakout"));
  return dbPromise;
}

export async function logSignal(row, dayKey) {
  const db = await getDb();
  await db.collection("signals").insertOne({ ...row, dayKey });
}

// Called once a real order is confirmed placed — returns the Mongo _id so the
// caller can attach it to the in-memory trackedTrades entry and later use it
// to update this same document on close, rather than inserting a new row.
export async function openTrade(trade, dayKey) {
  const db = await getDb();
  const doc = {
    system: "gex-breakout",
    strategy: trade.strategy,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    stopPrice: trade.stopPrice,
    originalStopPrice: trade.stopPrice,
    targetPrice: trade.targetPrice,
    originalTargetPrice: trade.targetPrice,
    contractId: trade.contractId,
    size: trade.size,
    orderId: trade.orderId,
    openedAt: trade.openedAt,
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

// Patches an already-inserted trade doc's entry/stop/target once the broker's
// real fill price is confirmed (see worker.js's confirmRealEntryPrice) — the
// initial openTrade write uses the strategy's theoretical trigger price since
// a market order's real fill isn't known synchronously.
export async function correctEntryPrice(mongoId, update) {
  if (!mongoId) return;
  const db = await getDb();
  await db.collection("trades").updateOne({ _id: mongoId }, { $set: update });
}

// A record of an in-trade management action (breakeven move, tighten-trail,
// take-partial) that adjusts an open trade without closing it — closeTrade
// above only captures full closes, so without this, everything except
// EXIT_NOW would leave no queryable trace of "why did the stop move" or
// "$ value saved/gained," only a Discord message.
export async function logExitAction(action, dayKey) {
  const db = await getDb();
  await db.collection("exitActions").insertOne({ ...action, dayKey, ts: new Date().toISOString() });
}

export async function fetchDayTrades(dayKey) {
  const db = await getDb();
  return db.collection("trades").find({ dayKey }).sort({ openedAt: 1 }).toArray();
}

export async function fetchDayExitActions(dayKey) {
  const db = await getDb();
  return db.collection("exitActions").find({ dayKey }).sort({ ts: 1 }).toArray();
}

export async function writeDailySummary(dayKey, summary) {
  const db = await getDb();
  await db.collection("dailySummaries").updateOne({ dayKey }, { $set: { ...summary, dayKey } }, { upsert: true });
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
