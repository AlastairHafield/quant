// Level 2 order-book depth — resting large-order detection and a decaying
// heatmap of where size tends to sit. Operates on a NORMALIZED snapshot
// shape this module defines itself: { bids: [{price, size}], asks: [{price,
// size}] }.

// GatewayDepth's `type` field, confirmed 2026-07-30 two ways: (1) matches
// project-x-py's independently-implemented DomType enum for this same
// ProjectX Gateway API exactly; (2) cross-checked against a real live
// session — TRADE(5) entries carried a large running-total-looking `volume`
// with a small `currentVolume` (the actual print size), and BID(2)/ASK(1)
// entries paired 1:1 live with a NEW_BEST_BID(9)/NEW_BEST_ASK(10) marker at
// the identical price+size, confirming those are redundant top-of-book
// markers rather than independent book state.
export const DOM_TYPE = {
  UNKNOWN: 0,
  ASK: 1,
  BID: 2,
  BEST_ASK: 3,
  BEST_BID: 4,
  TRADE: 5,
  RESET: 6,
  SESSION_LOW: 7,
  SESSION_HIGH: 8,
  NEW_BEST_BID: 9,
  NEW_BEST_ASK: 10,
  FILL: 11,
};

// Applies one raw GatewayDepth entry to a book ({bids, asks}, each a plain
// Map<price, size>), MUTATING it in place and also returning it — deliberately
// not copy-on-write like this module's other pure functions, since this runs
// on every entry of potentially large batched arrays several times a second;
// DepthBookAggregator owns these maps as its own long-lived state, there's
// nothing to protect by copying. BID/ASK volumes are absolute resting size at
// that price (confirmed live: a 0 volume there means the level emptied out),
// not a delta, so a 0 removes the level rather than being stored as a zero
// entry. BEST_BID/BEST_ASK/NEW_BEST_BID/NEW_BEST_ASK/SESSION_LOW/
// SESSION_HIGH/FILL/UNKNOWN carry no book state beyond what the underlying
// BID/ASK update already gave, and TRADE isn't book state at all (GatewayTrade
// already covers trade prints) — all ignored here.
export function applyDepthEntry(book, entry) {
  if (entry.type === DOM_TYPE.RESET) {
    book.bids.clear();
    book.asks.clear();
    return book;
  }
  const side = entry.type === DOM_TYPE.BID ? book.bids : entry.type === DOM_TYPE.ASK ? book.asks : null;
  if (!side) return book;
  if (entry.volume > 0) side.set(entry.price, entry.volume);
  else side.delete(entry.price);
  return book;
}

export function applyDepthEntries(book, entries) {
  for (const entry of entries) applyDepthEntry(book, entry);
  return book;
}

// Converts the internal {bids: Map, asks: Map} book into the normalized
// snapshot shape detectLargeRestingOrders/updateHeatmap expect.
export function bookToSnapshot(book) {
  const toLevels = (map) => [...map.entries()].map(([price, size]) => ({ price, size }));
  return { bids: toLevels(book.bids), asks: toLevels(book.asks) };
}

export function detectLargeRestingOrders(snapshot, { sizeThreshold }) {
  const flagged = (side) => (level) => ({ side, price: level.price, size: level.size });
  return [
    ...snapshot.bids.filter((l) => l.size >= sizeThreshold).map(flagged("bid")),
    ...snapshot.asks.filter((l) => l.size >= sizeThreshold).map(flagged("ask")),
  ].sort((a, b) => b.size - a.size);
}

// Rolling exponential-decay accumulator so stale observations fade rather
// than a single large snapshot permanently dominating — pure (returns a new
// Map), DepthBookAggregator holds the running instance as its own state.
export function updateHeatmap(heatmap, snapshot, { heatmapDecay }) {
  const next = new Map();
  for (const [price, weight] of heatmap.entries()) {
    const decayed = weight * heatmapDecay;
    if (decayed > 0.01) next.set(price, decayed); // drop negligible residue instead of growing the map forever
  }
  for (const level of [...snapshot.bids, ...snapshot.asks]) {
    next.set(level.price, (next.get(level.price) ?? 0) + level.size);
  }
  return next;
}

export function topHeatmapZones(heatmap, count) {
  return [...heatmap.entries()]
    .map(([price, weight]) => ({ price, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count);
}

export class DepthBookAggregator {
  constructor(cfg) {
    this.cfg = cfg;
    this.book = { bids: new Map(), asks: new Map() };
    this.heatmap = new Map();
    this.lastSnapshot = null;
    this.lastEventAt = null;
  }

  onDepthEvent(rawEntries) {
    this.lastEventAt = new Date();
    applyDepthEntries(this.book, rawEntries);
    this.lastSnapshot = bookToSnapshot(this.book);
    this.heatmap = updateHeatmap(this.heatmap, this.lastSnapshot, this.cfg);
  }
}
