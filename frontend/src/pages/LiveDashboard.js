import React, { useState } from 'react';
import GexBreakoutDashboard from './GexBreakoutDashboard';
import TradeJournal from './TradeJournal';
import PracticeMode from './PracticeMode';
import StrategyConfig from './StrategyConfig';
import AgentHarnessDashboard from './AgentHarnessDashboard';

// gap-continuation and mechanical-orb (the two other bots that used to run
// here, both trading the real Combine) were decommissioned 2026-09-19 — all
// focus is now on the Order Flow Bot, which trades only its own practice
// account (see Practice Mode).
const STRATS = [
  { id: 'gex', label: 'GEX Breakout', icon: '⬤', Component: GexBreakoutDashboard },
  { id: 'practice', label: 'Practice Mode', icon: '🧪', Component: PracticeMode },
  { id: 'config', label: 'Strategy Config', icon: '⚙', Component: StrategyConfig },
  { id: 'journal', label: 'Trade Journal', icon: '📓', Component: TradeJournal },
  { id: 'harness', label: 'Agent Harness', icon: '🤖', Component: AgentHarnessDashboard },
];

export default function LiveDashboard() {
  const [strat, setStrat] = useState('gex');
  const active = STRATS.find((s) => s.id === strat);
  const Active = active.Component;

  return (
    <div>
      <div className="strat-tabs">
        {STRATS.map((s) => (
          <button
            key={s.id}
            className={`btn strat-tab ${strat === s.id ? 'btn-primary' : ''}`}
            onClick={() => setStrat(s.id)}
          >
            <span className="nav-icon">{s.icon}</span> {s.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
}
