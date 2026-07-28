import React from 'react';

// Reference snapshot of each live strategy's actual config.js — NOT pulled
// live from each bot (only GEX Breakout pushes a status payload the frontend
// can read; Mechanical ORB and Gap Continuation don't currently expose their
// config over the wire). Update this whenever a bot's config.js changes.
const AS_OF = '2026-07-28';

const STRATEGIES = [
  {
    id: 'gex-a',
    system: 'GEX Breakout',
    strategy: 'Strategy A — 15-min ORB',
    account: 'Practice (own account, separate from Strategy B)',
    instrument: 'MES',
    timeframe: '15-min opening range (09:30–09:45 ET)',
    entryWindow: 'No new entries after 12:00 ET · force-flat 15:55 ET',
    entry: 'Close beyond the OR high/low (+1pt trigger buffer), order-flow grade required',
    stopTarget: 'Stop capped at 12pts · target capped at 30pts (2R fixed) · breakeven at 1R · 50% runner trails 2 bars past target',
    sizing: 'Base 4 contracts × wall-proximity multiplier — flat (ladder not applied on practice account)',
    riskLimits: 'Max 2 losses/day or 1 win halts the strategy for the day',
    execEnvVar: 'STRATEGY_A_EXECUTION_ENABLED',
  },
  {
    id: 'gex-b',
    system: 'GEX Breakout',
    strategy: 'Strategy B — General level breakout',
    account: 'Real Combine (50KTC) — shared with Mechanical ORB & Gap Continuation',
    instrument: 'MES',
    timeframe: 'No fixed window — evaluates GEX walls / flip point / daily levels / consolidation ranges continuously',
    entryWindow: 'No new entries after 12:00 ET · force-flat 15:55 ET',
    entry: 'Close beyond a trigger level (+1pt buffer), within-proximity + cooldown filters, order-flow grade required',
    stopTarget: 'Set relative to the broken level; failed-breakout / delta-divergence / absorption / regime-flip dynamic exits',
    sizing: 'Base 2 contracts × wall-proximity multiplier × equity ladder (1 base @ $50,000, +1 per $2,000 growth, capped 15x)',
    riskLimits: 'Max 3 trades/day, 60-min cooldown per level, max 2 losses/day or 1 win halts the strategy for the day',
    execEnvVar: 'EXECUTION_ENABLED (bot-wide)',
  },
  {
    id: 'morb',
    system: 'Mechanical ORB',
    strategy: 'Opening range breakout',
    account: 'Real Combine (50KTC) — shared with GEX Breakout B & Gap Continuation',
    instrument: 'MES',
    timeframe: '15-min opening range (09:30–09:45 ET)',
    entryWindow: 'No new entries after 12:00 ET · force-flat 15:55 ET',
    entry: 'LONG-only close beyond the OR high, prior-day ADX(14) ≥ 25 required to arm the day, one trade per day',
    stopTarget: 'Stop = 1.5 × opening-range width · rides to stop or session end (no fixed take-profit)',
    sizing: 'Flat 1 contract (ladder present in code but pinned off)',
    riskLimits: 'One trade per day, no separate win/loss halt (single-shot by design)',
    execEnvVar: 'MECHANICAL_ORB_EXECUTION_ENABLED',
  },
  {
    id: 'gapc',
    system: 'Gap Continuation',
    strategy: 'RTH gap continuation',
    account: 'Real Combine (50KTC) — shared with GEX Breakout B & Mechanical ORB',
    instrument: 'MES',
    timeframe: 'Evaluated once, at the first bar at/after the 09:30 ET open',
    entryWindow: 'One evaluation per day, at session open · force-flat 15:55 ET',
    entry: 'First RTH bar\'s open vs. prior RTH close ≥ 0.5% gap, direction follows the gap, prior-day ADX(14) ≥ 25 required',
    stopTarget: 'Stop = 0.5 × gap size · target = 1.0 × stop distance (1:1 R:R) · fills at the first bar\'s close',
    sizing: 'Flat 1 contract (ladder present in code but pinned off)',
    riskLimits: 'One evaluation per day (taken or vetoed), no separate win/loss halt',
    execEnvVar: 'GAP_CONTINUATION_EXECUTION_ENABLED',
  },
];

export default function StrategyConfig() {
  return (
    <div>
      <p className="page-title">Strategy Config</p>
      <div className="status" style={{ marginBottom: 16 }}>
        Reference snapshot as of {AS_OF} — this is a manually-maintained mirror of each bot's config.js, not pulled
        live. Live execution status/account balance/positions are on each bot's own dashboard tab (and Practice
        Mode for Strategy A).
      </div>

      {STRATEGIES.map((s) => (
        <div className="card" key={s.id} style={{ marginBottom: 16 }}>
          <p className="card-title">{s.system} — {s.strategy}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row label="Account" value={s.account} />
            <Row label="Instrument" value={s.instrument} />
            <Row label="Timeframe" value={s.timeframe} />
            <Row label="Entry window" value={s.entryWindow} />
            <Row label="Entry rule" value={s.entry} />
            <Row label="Stop / target" value={s.stopTarget} />
            <Row label="Sizing" value={s.sizing} />
            <Row label="Risk limits" value={s.riskLimits} />
            <Row label="Execution gate (Heroku config var)" value={s.execEnvVar} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11, minWidth: 190, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{value}</span>
    </div>
  );
}
