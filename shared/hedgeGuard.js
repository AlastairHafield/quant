// Formalizes the account's "absolutely no hedging" rule into shared,
// tested, safety-critical code — see agent-harness/PROTOCOL.md's
// non-negotiable rules. Before this, the protection existed only as an
// inline `openPositions.length > 0` check duplicated in gap-continuation and
// mechanical-orb's own worker.js — functionally correct, but nothing stopped
// a future proposal from touching that line without realizing what it was
// actually for. Routing it through shared/ means the same protection
// killSwitch.js/protectedLimits.js/accountRisk.js get: an agent proposal is
// told never to edit, weaken, or route around this file.
//
// gap-continuation and mechanical-orb trade the SAME real Combine account
// and the SAME instrument, as independent Heroku processes with no shared
// memory — but both poll that account's own real position list every few
// seconds (pollAccount), so the broker-reported state is the single source
// of truth this checks against, not either bot's own local trade tracking.
// That means each bot's check sees the OTHER bot's currently open position
// too, not just its own. gex-breakout's "default" role is also wired to this
// same real account (accountRoleFor in gex-breakout/src/worker.js) — dormant
// today since its only active strategy (the Order Flow Bot) is routed to a
// separate practice account, but it would share this exact exposure if ever
// reactivated.
//
// gex-breakout's Order Flow Bot itself enforces the same invariant on ITS
// OWN (practice) account a different, equally valid way
// (closeOnDirectionFlip/tradesRequiringCloseOnFlip in gex-breakout/src/
// worker.js: close every existing tracked trade on a contract before opening
// a new, conflicting-direction one, rather than simply refusing the new
// entry) — it doesn't call this module, but satisfies the same guarantee: a
// contract never holds two simultaneously open, opposing-direction
// positions on that account.

// ProjectX Gateway position type — confirmed live across this codebase
// (gap-continuation/src/worker.js, gex-breakout/src/worker.js).
export const POSITION_TYPE_TO_DIRECTION = { 1: "long", 2: "short" };

export function directionOfPosition(position) {
  return POSITION_TYPE_TO_DIRECTION[position.type] ?? null;
}

// gap-continuation/mechanical-orb's actual policy: at most ONE open position
// at a time across every strategy sharing this account, full stop — not
// merely "no opposing pair." A same-direction second position still doubles
// real risk beyond what either strategy alone was sized for, so it's
// refused too, not just a hedge.
export function wouldOpenSimultaneousPosition(openPositions) {
  return openPositions.length > 0;
}

// The narrower check — true only for a genuine opposing-direction conflict
// on the SAME contract, not a same-direction addition. Exported for a
// gex-breakout-style caller (or any future strategy) that deliberately
// allows stacking same-direction size rather than gap-continuation/
// mechanical-orb's stricter "at most one, period" policy — the ABSOLUTE
// rule this account-wide is that two OPPOSING positions must never coexist;
// wouldOpenSimultaneousPosition above is gap-continuation/mechanical-orb's
// own, stricter choice on top of that floor.
export function wouldHedge(openPositions, contractId, newDirection) {
  return openPositions.some((p) => {
    if (p.contractId !== contractId) return false;
    const dir = directionOfPosition(p);
    return dir != null && dir !== newDirection;
  });
}
