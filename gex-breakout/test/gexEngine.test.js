import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildGexProfile,
  computeNetGex,
  computeFlipPoint,
  computeWalls,
  computeGexSnapshot,
  computeGexSnapshotFromProfile,
  staleConfidence,
} from "../src/gexEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/chainSnapshot.json"), "utf8")
);

const gexOpts = {
  sign: { call: 1, put: -1 },
  staleness: { useVolumeBlend: false, blendWeight: 0.5, reducedConfidenceAfterET: { h: 12, m: 0 } },
  wallCount: 3,
};

test("buildGexProfile aggregates per-strike GEX and sorts ascending", () => {
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const strikes = profile.map((p) => p.strike);
  assert.deepEqual(strikes, [90, 95, 98, 100, 102, 105, 110]);

  const byStrike = Object.fromEntries(profile.map((p) => [p.strike, p.gex]));
  assert.equal(byStrike[90], -1000);
  assert.equal(byStrike[95], -5000);
  assert.equal(byStrike[98], -6000);
  assert.equal(byStrike[100], 10000); // 12000 call - 2000 put, aggregated
  assert.equal(byStrike[102], 12000);
  assert.equal(byStrike[105], 1000);
  assert.equal(byStrike[110], 250);
});

test("computeNetGex sums the full profile", () => {
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  assert.equal(computeNetGex(profile), 11250);
});

test("computeFlipPoint interpolates the zero-crossing strike", () => {
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const flip = computeFlipPoint(profile);
  assert.ok(Math.abs(flip - (100 + 1 / 3)) < 1e-9);
});

test("computeFlipPoint: with multiple crossings (a wide real chain has deep-OTM noise), picks the one nearest spot", () => {
  // A tiny spurious wobble far from spot, then the real crossing near the money.
  const profile = [
    { strike: 10, gex: -5 },
    { strike: 20, gex: 12 }, // crosses to positive here (spurious, far OTM)
    { strike: 30, gex: -12 }, // crosses back to negative
    { strike: 95, gex: -1000 },
    { strike: 100, gex: 2000 }, // the real crossing, near spot=102
    { strike: 105, gex: 500 },
  ];
  const flip = computeFlipPoint(profile, 102);
  assert.ok(flip > 95 && flip < 100, `expected the near-spot crossing, got ${flip}`);
});

test("computeFlipPoint: without a spot argument, falls back to the first crossing (old behavior)", () => {
  const profile = [
    { strike: 10, gex: -5 },
    { strike: 20, gex: 12 },
    { strike: 95, gex: -1000 },
    { strike: 100, gex: 2000 },
  ];
  const flip = computeFlipPoint(profile);
  assert.ok(flip > 10 && flip < 20);
});

test("computeWalls tags top-N strikes above/below spot by absolute GEX", () => {
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const walls = computeWalls(profile, fixture.spot, gexOpts);

  assert.deepEqual(
    walls.aboveSpot.map((w) => w.strike),
    [102, 105, 110]
  );
  assert.ok(walls.aboveSpot.every((w) => w.wallType === "POS_WALL"));

  assert.deepEqual(
    walls.belowSpot.map((w) => w.strike),
    [98, 95, 90]
  );
  assert.ok(walls.belowSpot.every((w) => w.wallType === "NEG_WALL"));
});

test("computeWalls respects wallCount cap", () => {
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const walls = computeWalls(profile, fixture.spot, { ...gexOpts, wallCount: 2 });
  assert.equal(walls.aboveSpot.length, 2);
  assert.equal(walls.belowSpot.length, 2);
});

test("staleConfidence is FULL before the cutoff and REDUCED after", () => {
  const before = new Date("2026-07-24T11:59:00");
  const after = new Date("2026-07-24T12:01:00");
  assert.equal(staleConfidence(before, gexOpts), "FULL");
  assert.equal(staleConfidence(after, gexOpts), "REDUCED");
});

test("staleConfidence is always FULL when volume-blend staleness handling is enabled", () => {
  const after = new Date("2026-07-24T15:00:00");
  const blended = { ...gexOpts, staleness: { ...gexOpts.staleness, useVolumeBlend: true } };
  assert.equal(staleConfidence(after, blended), "FULL");
});

test("computeGexSnapshot composes profile/netGex/flip/walls/confidence", () => {
  const now = new Date("2026-07-24T09:31:00");
  const snap = computeGexSnapshot(fixture.chain, fixture.spot, gexOpts, now);
  assert.equal(snap.netGex, 11250);
  assert.equal(snap.confidence, "FULL");
  assert.equal(snap.walls.aboveSpot[0].strike, 102);
  assert.equal(snap.asOf, now.toISOString());
});

test("computeGexSnapshotFromProfile matches computeGexSnapshot given the equivalent profile (e.g. a provider that pre-computes GEX per strike)", () => {
  const now = new Date("2026-07-24T09:31:00");
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const viaProfile = computeGexSnapshotFromProfile(profile, fixture.spot, gexOpts, now);
  const viaChain = computeGexSnapshot(fixture.chain, fixture.spot, gexOpts, now);
  assert.deepEqual(viaProfile, viaChain);
});

test("computeGexSnapshotFromProfile: a flipPointOverride wins over the computed crossing", () => {
  const now = new Date("2026-07-24T09:31:00");
  const profile = buildGexProfile(fixture.chain, fixture.spot, gexOpts);
  const snap = computeGexSnapshotFromProfile(profile, fixture.spot, gexOpts, now, 7486.12);
  assert.equal(snap.flipPoint, 7486.12);
  assert.equal(snap.netGex, 11250); // everything else still computed normally
});
