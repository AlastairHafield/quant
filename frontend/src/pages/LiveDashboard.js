import React, { useState } from 'react';
import GexBreakoutDashboard from './GexBreakoutDashboard';
import MechanicalOrbDashboard from './MechanicalOrbDashboard';
import GapContinuationDashboard from './GapContinuationDashboard';
import TradeJournal from './TradeJournal';
import PracticeMode from './PracticeMode';
import StrategyConfig from './StrategyConfig';

// The three real, live-money strategies come first, each with its own tab —
// whatever trades a practice account (currently just GEX Breakout's Strategy
// A) lives only in Practice Mode, never mixed into these.
const STRATS = [
  { id: 'gex', label: 'GEX Breakout', icon: '⬤', Component: GexBreakoutDashboard },
  { id: 'morb', label: 'Mechanical ORB', icon: '⬤', Component: MechanicalOrbDashboard },
  { id: 'gapc', label: 'Gap Continuation', icon: '⬤', Component: GapContinuationDashboard },
  { id: 'practice', label: 'Practice Mode', icon: '🧪', Component: PracticeMode },
  { id: 'config', label: 'Strategy Config', icon: '⚙', Component: StrategyConfig },
  { id: 'journal', label: 'Trade Journal', icon: '📓', Component: TradeJournal },
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
