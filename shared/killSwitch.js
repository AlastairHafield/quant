import { MongoClient } from "mongodb";

// One global switch shared by every worker (gap-continuation, mechanical-orb,
// gex-breakout) regardless of which account/role it trades — a human flips
// this to instantly halt all live entries everywhere, independent of any
// bot's own EXECUTION_ENABLED flag, so it can't be un-tripped by an
// agent-authored config change the way EXECUTION_ENABLED could be. Lives in
// its own "control" database, separate from every bot's own trade-journal
// database, within the same shared Mongo cluster (MONGODB_URI).
let client = null;
let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db("control"));
  return dbPromise;
}

// Fails OPEN (not tripped) on any read error — matching this codebase's
// existing convention that a Mongo hiccup must never itself halt live
// trading (see e.g. every tradeJournal.js call site). The dependency-free
// daily loss cap (accountRisk.js, computed straight off the broker's own
// balance) is the hard cap that can't be silently disabled by a DB outage;
// this is the human-operated secondary one.
export async function isKillSwitchActive() {
  try {
    const db = await getDb();
    const doc = await db.collection("switches").findOne({ _id: "global" });
    return doc?.active === true;
  } catch (e) {
    console.error("Kill switch check failed (failing open):", e.message);
    return false;
  }
}

export async function setGlobalKillSwitch(active, reason = null) {
  const db = await getDb();
  await db
    .collection("switches")
    .updateOne({ _id: "global" }, { $set: { active, reason, updatedAt: new Date().toISOString() } }, { upsert: true });
}
