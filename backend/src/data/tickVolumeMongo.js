import { MongoClient } from 'mongodb';

// Durable store for the live Order Flow Bot's per-minute aggressor buy/sell
// volume (see gex-breakout/src/tickVolumeReporter.js, which POSTs its
// already-computed bars here in real time). This is the ONLY source of this
// data — TopstepX's historical REST API (History/retrieveBars) only ever
// returns one combined volume field, never a buy/sell split; that split only
// ever exists on the live GatewayTrade stream. Deliberately Mongo, not the
// backend's own SQLite bar cache (db.js) — a Heroku dyno's local filesystem
// resets on every deploy and on Heroku's own mandatory daily restart, which
// is harmless for that cache (Databento/Alpaca/FMP data is refetchable from
// the vendor) but would silently destroy this, since there is no vendor to
// refetch it from. Own database ("order_flow_capture"), separate from every
// other Mongo use in this app.

let client = null;
let dbPromise = null;
let indexEnsured = false;

function getDb() {
  if (dbPromise) return dbPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  dbPromise = client.connect().then(() => client.db('order_flow_capture'));
  return dbPromise;
}

async function getCollection() {
  const db = await getDb();
  const col = db.collection('tickVolume1m');
  if (!indexEnsured) {
    await col.createIndex({ symbol: 1, date: 1, ny_time: 1 }, { unique: true });
    indexEnsured = true;
  }
  return col;
}

// Upsert-by-(symbol,date,ny_time) so a re-sent bar (the reporter re-sends
// anything not yet confirmed delivered — see flushTickVolume) never creates
// a duplicate row.
export async function upsertTickVolume1m(symbol, rows) {
  if (!rows.length) return;
  const col = await getCollection();
  const capturedAt = new Date().toISOString();
  const ops = rows.map((r) => ({
    updateOne: {
      filter: { symbol, date: r.date, ny_time: r.ny_time },
      update: { $set: { symbol, date: r.date, ny_time: r.ny_time, buy_volume: r.buy_volume, sell_volume: r.sell_volume, capturedAt } },
      upsert: true,
    },
  }));
  await col.bulkWrite(ops, { ordered: false });
}

export async function getTickVolume1m(symbol, from, to) {
  const col = await getCollection();
  return col.find({ symbol, date: { $gte: from, $lte: to } }, { projection: { _id: 0 } })
    .sort({ date: 1, ny_time: 1 })
    .toArray();
}
