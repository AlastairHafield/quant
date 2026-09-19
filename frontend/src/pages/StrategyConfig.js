import React from 'react';

// Reference snapshot of the live strategy's actual config.js — NOT pulled
// live from the bot. Update this whenever gex-breakout's config.js changes.
//
// 2026-09-19: gap-continuation and mechanical-orb (both trading the real
// Combine) were decommissioned; their entries were removed from this page.
// The stale "Strategy B — General level breakout" entry was also removed —
// that code path was already deleted from gex-breakout/src/worker.js before
// this cleanup (see its own "Strategy B... was removed with GEX/FlashAlpha"
// comment), so the Order Flow Bot is the only strategy this bot runs.
const AS_OF = '2026-09-19';

const STRATEGIES = [
  {
    id: 'gex-of',
    system: 'GEX Breakout',
    strategy: 'Order Flow Bot',
    account: 'Practice (own account)',
    instrument: 'MES',
    timeframe: 'Regime-adaptive — GEX bias picks trend-following vs. mean-reversion each day, no fixed window',
    entryWindow: 'No new entries after 12:00 ET · force-flat 15:55 ET',
    entry: 'Regime picks the active zone set — footprint stacked buy/sell-imbalance zones on NEG_GAMMA (trend) days, session value area on POS_GAMMA (mean-reversion) days. 3 shared triggers evaluated against it: absorption at the zone edge, path-of-least-resistance (light-volume clean advance), lack-of-participation (declining volume + flattening delta) — plus failed-auction (POS_GAMMA-only, value-area probe-and-revert). Wall-proximity filter applies once a trigger fires.',
    stopTarget: 'Stop sits 1pt beyond the zone edge traded, capped at 12pt total risk · trend days trail behind the nearest zone instead of a fixed target · mean-reversion days target the opposite value-area edge',
    sizing: 'Base 2 contracts (fixed synthetic grade) × wall-proximity multiplier — flat (ladder not applied on practice account)',
    riskLimits: 'Max 3 trades/day, 60-min cooldown per zone, max 2 losses/day or 1 win halts the strategy for the day',
    execEnvVar: 'STRATEGY_OF_EXECUTION_ENABLED (also requires the bot-wide EXECUTION_ENABLED)',
  },
];

export default function StrategyConfig() {
  return (
    <div>
      <p className="page-title">Strategy Config</p>
      <div className="status" style={{ marginBottom: 16 }}>
        Reference snapshot as of {AS_OF} — this is a manually-maintained mirror of the bot's config.js, not pulled
        live. Live execution status/account balance/positions are on the bot's own dashboard tab (and Practice
        Mode).
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
    <div className="config-row">
      <span className="config-row-label">{label}</span>
      <span className="config-row-value">{value}</span>
    </div>
  );
}
