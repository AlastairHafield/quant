// Level 2 order-book depth — resting large-order detection and a decaying
// heatmap of where size tends to sit. Operates on a NORMALIZED snapshot
// shape this module defines itself: { bids: [{price, size}], asks: [{price,
// size}] }. TopstepX's real GatewayDepth wire format is unconfirmed (see
// dataSources/topstepx.js's subscribeDepth) — DepthBookAggregator.onDepthEvent
// is where that raw payload gets converted into this shape, once a live
// session confirms it. These pure functions don't need that confirmation to
// be built and tested now.

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
  constructor() {
    this.heatmap = new Map();
    this.lastSnapshot = null;
    this.lastEventAt = null;
  }

  // Deliberately logs the raw payload rather than guessing a parse — Phase 3b
  // deploys exactly this, observes one live session against a real contract,
  // and Phase 3c replaces this body with real parsing once the shape is
  // confirmed (same discipline as the GatewayTrade array surprise: verify
  // live before trusting the docs).
  onDepthEvent(rawData) {
    this.lastEventAt = new Date();
    console.log("GatewayDepth raw payload:", JSON.stringify(rawData));
  }
}
