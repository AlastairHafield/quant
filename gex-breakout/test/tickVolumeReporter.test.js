import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appLevelSymbolFor,
  etDateAndTime,
  createTickVolumeBuffer,
  bufferTickVolumeBar,
  flushTickVolume,
} from "../src/tickVolumeReporter.js";

test("appLevelSymbolFor: maps TopstepX's bare instrument symbol to the app-level key everything else stores bars under", () => {
  assert.equal(appLevelSymbolFor("ES"), "ES=F");
  assert.equal(appLevelSymbolFor("MES"), "MES=F");
  assert.equal(appLevelSymbolFor("NQ"), "NQ"); // unmapped symbol passes through rather than throwing
});

test("etDateAndTime: reads date/ny_time straight off a nowET()-style Date's local getters", () => {
  const t = new Date(2026, 8, 2, 9, 45); // month is 0-indexed: September 2, 2026, 9:45am
  assert.deepEqual(etDateAndTime(t), { date: "2026-09-02", ny_time: 945 });
});

test("etDateAndTime: pads single-digit month/day", () => {
  const t = new Date(2026, 0, 5, 16, 5); // Jan 5, 16:05
  assert.deepEqual(etDateAndTime(t), { date: "2026-01-05", ny_time: 1605 });
});

test("bufferTickVolumeBar: appends a row shaped for the backend's tick-volume schema", () => {
  const buffer = createTickVolumeBuffer();
  bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 45), { buyVolume: 30, sellVolume: 12 });
  assert.deepEqual(buffer.rows, [{ date: "2026-09-02", ny_time: 945, buy_volume: 30, sell_volume: 12 }]);
});

test("bufferTickVolumeBar: caps buffer growth rather than accumulating forever during an extended backend outage", () => {
  const buffer = createTickVolumeBuffer();
  for (let i = 0; i < 2005; i++) {
    bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 45), { buyVolume: 1, sellVolume: 1 });
  }
  assert.equal(buffer.rows.length, 2000);
});

test("flushTickVolume: on success, sends everything buffered and clears it", async () => {
  const buffer = createTickVolumeBuffer();
  bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 45), { buyVolume: 30, sellVolume: 12 });
  bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 46), { buyVolume: 20, sellVolume: 5 });

  let sentBody = null;
  const fakeFetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true };
  };

  await flushTickVolume(buffer, "ES", "http://backend", "secret123", fakeFetch);

  assert.equal(sentBody.symbol, "ES=F");
  assert.equal(sentBody.rows.length, 2);
  assert.deepEqual(buffer.rows, []);
});

test("flushTickVolume: on failure, leaves the buffer intact for the next attempt", async () => {
  const buffer = createTickVolumeBuffer();
  bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 45), { buyVolume: 30, sellVolume: 12 });

  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await flushTickVolume(buffer, "ES", "http://backend", "secret123", fakeFetch);

  assert.equal(buffer.rows.length, 1);
});

test("flushTickVolume: a bar buffered WHILE the request is in flight is neither lost nor double-sent", async () => {
  const buffer = createTickVolumeBuffer();
  bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 45), { buyVolume: 30, sellVolume: 12 });

  let sentBody = null;
  const fakeFetch = async (url, opts) => {
    // Simulate a new live bar arriving mid-flight, before this request resolves —
    // real risk here: naive "clear the whole buffer after send" logic would
    // silently drop this row (it was never actually sent).
    bufferTickVolumeBar(buffer, new Date(2026, 8, 2, 9, 46), { buyVolume: 20, sellVolume: 5 });
    sentBody = JSON.parse(opts.body);
    return { ok: true };
  };

  await flushTickVolume(buffer, "ES", "http://backend", "secret123", fakeFetch);

  assert.equal(sentBody.rows.length, 1); // only the bar that existed when the request was built
  assert.equal(sentBody.rows[0].ny_time, 945);
  // The bar buffered mid-flight must still be sitting in the buffer, not lost.
  assert.equal(buffer.rows.length, 1);
  assert.equal(buffer.rows[0].ny_time, 946);
});

test("flushTickVolume: no-op with nothing buffered (doesn't call fetch at all)", async () => {
  const buffer = createTickVolumeBuffer();
  let called = false;
  await flushTickVolume(buffer, "ES", "http://backend", "secret123", async () => {
    called = true;
    return { ok: true };
  });
  assert.equal(called, false);
});
