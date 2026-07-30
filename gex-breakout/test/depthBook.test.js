import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOM_TYPE,
  applyDepthEntry,
  applyDepthEntries,
  bookToSnapshot,
  detectLargeRestingOrders,
  updateHeatmap,
  topHeatmapZones,
  DepthBookAggregator,
} from "../src/depthBook.js";

function emptyBook() {
  return { bids: new Map(), asks: new Map() };
}

test("applyDepthEntry sets absolute resting size for BID/ASK entries", () => {
  const book = emptyBook();
  applyDepthEntry(book, { type: DOM_TYPE.BID, price: 5498, volume: 20 });
  applyDepthEntry(book, { type: DOM_TYPE.ASK, price: 5502, volume: 15 });
  assert.equal(book.bids.get(5498), 20);
  assert.equal(book.asks.get(5502), 15);
});

test("applyDepthEntry removes a level when its volume goes to 0", () => {
  const book = emptyBook();
  applyDepthEntry(book, { type: DOM_TYPE.BID, price: 5498, volume: 20 });
  applyDepthEntry(book, { type: DOM_TYPE.BID, price: 5498, volume: 0 });
  assert.equal(book.bids.has(5498), false);
});

test("applyDepthEntry clears the whole book on RESET", () => {
  const book = emptyBook();
  applyDepthEntry(book, { type: DOM_TYPE.BID, price: 5498, volume: 20 });
  applyDepthEntry(book, { type: DOM_TYPE.ASK, price: 5502, volume: 15 });
  applyDepthEntry(book, { type: DOM_TYPE.RESET, price: 0, volume: 0 });
  assert.equal(book.bids.size, 0);
  assert.equal(book.asks.size, 0);
});

test("applyDepthEntry ignores TRADE/BEST_BID/BEST_ASK/NEW_BEST_BID/NEW_BEST_ASK/SESSION_LOW/SESSION_HIGH/FILL/UNKNOWN — no book state beyond the underlying BID/ASK", () => {
  const book = emptyBook();
  for (const type of [DOM_TYPE.TRADE, DOM_TYPE.BEST_BID, DOM_TYPE.BEST_ASK, DOM_TYPE.NEW_BEST_BID, DOM_TYPE.NEW_BEST_ASK, DOM_TYPE.SESSION_LOW, DOM_TYPE.SESSION_HIGH, DOM_TYPE.FILL, DOM_TYPE.UNKNOWN]) {
    applyDepthEntry(book, { type, price: 5500, volume: 999 });
  }
  assert.equal(book.bids.size, 0);
  assert.equal(book.asks.size, 0);
});

test("applyDepthEntries applies a whole batch in order, matching a real GatewayDepth payload shape", () => {
  const book = emptyBook();
  applyDepthEntries(book, [
    { type: DOM_TYPE.BID, price: 5498, volume: 20 },
    { type: DOM_TYPE.ASK, price: 5502, volume: 15 },
    { type: DOM_TYPE.NEW_BEST_BID, price: 5498, volume: 20 }, // redundant marker, no-op
    { type: DOM_TYPE.BID, price: 5498, volume: 12 }, // updates the same level
  ]);
  assert.equal(book.bids.get(5498), 12);
  assert.equal(book.asks.get(5502), 15);
});

test("bookToSnapshot converts the internal Maps to the normalized {bids,asks} level-array shape", () => {
  const book = emptyBook();
  book.bids.set(5498, 20);
  book.bids.set(5497, 5);
  book.asks.set(5502, 15);
  assert.deepEqual(bookToSnapshot(book), {
    bids: [{ price: 5498, size: 20 }, { price: 5497, size: 5 }],
    asks: [{ price: 5502, size: 15 }],
  });
});

test("detectLargeRestingOrders flags bid/ask levels at or above the size threshold", () => {
  const snapshot = {
    bids: [{ price: 5498, size: 50 }, { price: 5497, size: 150 }],
    asks: [{ price: 5502, size: 40 }, { price: 5503, size: 120 }],
  };
  const flagged = detectLargeRestingOrders(snapshot, { sizeThreshold: 100 });
  assert.deepEqual(flagged, [
    { side: "bid", price: 5497, size: 150 },
    { side: "ask", price: 5503, size: 120 },
  ]);
});

test("detectLargeRestingOrders returns nothing below the threshold", () => {
  const snapshot = { bids: [{ price: 5498, size: 50 }], asks: [{ price: 5502, size: 40 }] };
  assert.deepEqual(detectLargeRestingOrders(snapshot, { sizeThreshold: 100 }), []);
});

test("updateHeatmap decays existing weight and adds the new snapshot's sizes", () => {
  const heatmap = new Map([[5500, 100]]);
  const snapshot = { bids: [{ price: 5500, size: 20 }], asks: [] };
  const next = updateHeatmap(heatmap, snapshot, { heatmapDecay: 0.9 });
  assert.equal(next.get(5500), 100 * 0.9 + 20);
});

test("updateHeatmap drops negligible decayed residue instead of accumulating forever", () => {
  const heatmap = new Map([[5500, 0.015]]); // decays to 0.0075, below the 0.01 floor
  const snapshot = { bids: [], asks: [] };
  const next = updateHeatmap(heatmap, snapshot, { heatmapDecay: 0.5 });
  assert.equal(next.has(5500), false);
});

test("updateHeatmap does not mutate the input map", () => {
  const heatmap = new Map([[5500, 100]]);
  updateHeatmap(heatmap, { bids: [], asks: [] }, { heatmapDecay: 0.9 });
  assert.equal(heatmap.get(5500), 100);
});

test("topHeatmapZones returns the N heaviest levels, descending", () => {
  const heatmap = new Map([[5500, 10], [5501, 90], [5502, 50]]);
  assert.deepEqual(topHeatmapZones(heatmap, 2), [
    { price: 5501, weight: 90 },
    { price: 5502, weight: 50 },
  ]);
});

test("DepthBookAggregator: applies a real-shaped GatewayDepth batch, updates the snapshot, heatmap, and event time", () => {
  const agg = new DepthBookAggregator({ heatmapDecay: 0.98 });
  assert.equal(agg.lastEventAt, null);
  assert.equal(agg.lastSnapshot, null);

  agg.onDepthEvent([
    { type: DOM_TYPE.BID, price: 7372, volume: 13 },
    { type: DOM_TYPE.ASK, price: 7375, volume: 15 },
    { type: DOM_TYPE.TRADE, price: 7373, volume: 2568, currentVolume: 1 }, // ignored — not book state
  ]);

  assert.notEqual(agg.lastEventAt, null);
  assert.deepEqual(agg.lastSnapshot, { bids: [{ price: 7372, size: 13 }], asks: [{ price: 7375, size: 15 }] });
  assert.equal(agg.heatmap.get(7372), 13);
  assert.equal(agg.heatmap.get(7375), 15);

  // A second event: 7372's bid grows, decaying the running heatmap rather
  // than resetting it.
  agg.onDepthEvent([{ type: DOM_TYPE.BID, price: 7372, volume: 20 }]);
  assert.equal(agg.lastSnapshot.bids[0].size, 20);
  assert.equal(agg.heatmap.get(7372), 13 * 0.98 + 20);
});
