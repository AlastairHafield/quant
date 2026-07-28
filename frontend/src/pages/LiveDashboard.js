import React, { useState } from 'react';
import GexBreakoutDashboard from './GexBreakoutDashboard';
import MechanicalOrbDashboard from './MechanicalOrbDashboard';
import TradeJournal from './TradeJournal';
import PracticeMode from './PracticeMode';
import StrategyConfig from './StrategyConfig';

const STRATS = [
  { id: 'gex', label: 'GEX Breakout', icon: '⬤', Component: GexBreakoutDashboard },
  { id: 'morb', label: 'Mechanical ORB', icon: '⬤', Component: MechanicalOrbDashboard },
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {STRATS.map((s) => (
          <button
            key={s.id}
            className={`btn ${strat === s.id ? 'btn-primary' : ''}`}
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
