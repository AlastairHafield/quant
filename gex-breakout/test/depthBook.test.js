import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLargeRestingOrders, updateHeatmap, topHeatmapZones, DepthBookAggregator } from "../src/depthBook.js";

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

test("DepthBookAggregator: onDepthEvent records the event time without throwing on an arbitrary payload", () => {
  const agg = new DepthBookAggregator();
  assert.equal(agg.lastEventAt, null);
  assert.doesNotThrow(() => agg.onDepthEvent({ anything: "the real shape is unconfirmed" }));
  assert.notEqual(agg.lastEventAt, null);
});
