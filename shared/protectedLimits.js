// Hard risk ceilings enforced independent of any bot's own (agent-editable)
// config.js — the mechanism that makes "full autonomy, hard caps" (the
// chosen agent-autonomy level) actually mean something. A strategy-tuning
// change lives in each bot's own config.js (stopParam, gapMinPct, sizing,
// etc.) and can be proposed/merged freely; this file is the one thing that
// isn't part of that surface — same deliberate exception to this repo's
// self-contained-module convention Phase 0's shared/accountRisk.js and
// shared/killSwitch.js already are, for the same reason (risk enforcement
// has to stay uniform and out of the config an agent is actually iterating
// on, not per-bot and edit-along-with-everything-else).
//
// Raising this ceiling is possible (it's still just a file in the repo) but
// requires a human to specifically edit THIS file rather than happening as
// an incidental side effect of a strategy-tuning change to some bot's own
// config.js — the promotion gate (promotionGate.js) treats a diff touching
// this file as requiring the master kill-switch owner's sign-off, not the
// automated path.

// Absolute ceiling on contracts per single order, regardless of what any
// bot's own sizing math (flat, ladder, or flow-grade multiplier) computes —
// mirrors the equity ladder's own existing cap (15) as the one already
// deliberately chosen for this account size, but enforced here so a bug or
// a bad config change in an individual bot can't silently exceed it.
export const MAX_CONTRACTS_PER_ORDER = 15;

// Clamps a computed order size down to the hard ceiling — never up; a
// strategy that (correctly) wants fewer contracts than the ceiling is left
// untouched. Returns the same value type (number) so call sites can use
// this as a drop-in wrapper around their own sizing function's result.
export function clampToMaxContracts(size) {
  if (typeof size !== "number" || !Number.isFinite(size)) return 0;
  return Math.max(0, Math.min(size, MAX_CONTRACTS_PER_ORDER));
}
