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

// ─── Discord visibility ───────────────────────────────────────────────────
// Every audit entry also posts to Discord — the user's own "monitor their
// communications" channel for the multi-agent thesis/critique/decision
// exchange, same idea as every trading bot already posting its own signals
// there. AGENT_HARNESS_DISCORD_WEBHOOK is a dedicated channel; until one is
// set up, this falls back to the same webhook the trading alerts use
// (DISCORD_WEBHOOK) — a deliberate, temporary choice (2026-09), swap in a
// dedicated webhook whenever convenient by just setting the dedicated var.

const TYPE_COLOR = {
  watch: 0x95a5a6,
  proposal: 0x3498db,
  grade: 0xf39c12,
  promotion: 0x2ecc71,
  demotion: 0xe67e22,
  error: 0xe74c3c,
};
const TYPE_EMOJI = {
  watch: '👀',
  proposal: '💡',
  grade: '⚖️',
  promotion: '🚀',
  demotion: '⬇️',
  error: '🛑',
};

// Discord embed description/field caps are ~4096/~1024 chars — truncate
// defensively rather than let a large `details` payload get the whole post
// rejected outright.
function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

async function notifyDiscord(entry) {
  const webhookUrl = process.env.AGENT_HARNESS_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) return; // no webhook configured anywhere — silently skip, same as every bot's own postDiscordEmbed
  const fields = [{ name: 'Strategy', value: String(entry.strategy ?? '—'), inline: true }];
  if (entry.role) fields.push({ name: 'Agent role', value: String(entry.role), inline: true });
  if (entry.details) {
    const detailsStr = typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details, null, 1);
    fields.push({ name: 'Details', value: '```' + truncate(detailsStr, 1000) + '```' });
  }
  const payload = {
    embeds: [{
      title: `${TYPE_EMOJI[entry.type] ?? '📝'} Agent harness — ${entry.type ?? 'update'}`,
      description: truncate(String(entry.summary ?? ''), 4000),
      color: TYPE_COLOR[entry.type] ?? 0x95a5a6,
      fields,
      footer: { text: `agent-harness · ${entry.loggedAt}` },
      timestamp: entry.loggedAt,
    }],
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('Agent audit Discord post failed:', res.status, await res.text());
  } catch (e) {
    console.error('Agent audit Discord post failed:', e.message);
  }
}

// entry.type is expected to be one of: 'watch' | 'proposal' | 'grade' |
// 'promotion' | 'demotion' | 'error' — not enforced here (Mongo is
// schemaless and the harness itself is what should be constraining this),
// just documented so a reader of this file knows the intended vocabulary.
// entry.role (optional) names which agent role wrote this entry (e.g.
// "proposer" / "critic-opus" / "critic-sonnet") — surfaced in Discord so a
// multi-model debate reads as a sequence of distinct voices, not one
// undifferentiated stream.
export async function logAuditEntry(entry) {
  const db = await getDb();
  const doc = { ...entry, loggedAt: new Date().toISOString() };
  await db.collection('auditLog').insertOne(doc);
  // Best-effort, never blocks the durable write above — a Discord hiccup
  // must never look like the audit log itself failed.
  notifyDiscord(doc).catch((e) => console.error('notifyDiscord threw:', e.message));
  return doc;
}

export async function fetchAuditLog({ strategy, type, limit = 100 } = {}) {
  const db = await getDb();
  const query = {};
  if (strategy) query.strategy = strategy;
  if (type) query.type = type;
  return db.collection('auditLog').find(query).sort({ loggedAt: -1 }).limit(limit).toArray();
}
