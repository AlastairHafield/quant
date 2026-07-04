import React, { useState } from 'react';
import Universe from './pages/Universe';
import DataLoader from './pages/DataLoader';
import Backtest from './pages/Backtest';
import Results from './pages/Results';
import SDZones from './pages/SDZones';
import SDResults from './pages/SDResults';
import MRLab from './pages/MRLab';
import MRResults from './pages/MRResults';
import './App.css';

const PEAD_TABS = [
  { id: 'universe', label: 'Universe',  icon: '◈', group: 'pead' },
  { id: 'data',     label: 'Data Load', icon: '⬇', group: 'pead' },
  { id: 'backtest', label: 'PEAD',      icon: '▶', group: 'pead' },
  { id: 'results',  label: 'Results',   icon: '◉', group: 'pead' },
];

const SD_TABS = [
  { id: 'sd-zones',   label: 'S&D Zones',   icon: '▣', group: 'sd' },
  { id: 'sd-results', label: 'S&D Results', icon: '◈', group: 'sd' },
];

const MR_TABS = [
  { id: 'mr-lab',     label: 'MR Lab',     icon: '⇄', group: 'mr' },
  { id: 'mr-results', label: 'MR Results', icon: '◉', group: 'mr' },
];

const ALL_TABS = [...PEAD_TABS, ...SD_TABS, ...MR_TABS];
const BUILD = 'v1.2';

export default function App() {
  const [tab, setTab]             = useState('universe');
  const [lastRunId, setLastRunId] = useState(null);
  const [lastSDRunId, setLastSD]  = useState(null);
  const [lastMRRunId, setLastMR]  = useState(null);
  const [lastMRSweep, setLastMRSweep] = useState(null);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">QUANT</span>
          <span className="logo-sub">Multi-Strategy Engine</span>
          <span className="logo-build">{BUILD}</span>
        </div>
        <nav className="nav">
          <span style={{ color: 'var(--text3)', fontSize: 10, fontFamily: 'var(--mono)', alignSelf: 'center', marginRight: 4 }}>PEAD</span>
          {PEAD_TABS.map(t => (
            <button key={t.id} className={`nav-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
          <span style={{ width: 1, background: 'var(--border)', margin: '4px 8px', alignSelf: 'stretch' }} />
          <span style={{ color: 'var(--text3)', fontSize: 10, fontFamily: 'var(--mono)', alignSelf: 'center', marginRight: 4 }}>S&amp;D</span>
          {SD_TABS.map(t => (
            <button key={t.id} className={`nav-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
          <span style={{ width: 1, background: 'var(--border)', margin: '4px 8px', alignSelf: 'stretch' }} />
          <span style={{ color: 'var(--text3)', fontSize: 10, fontFamily: 'var(--mono)', alignSelf: 'center', marginRight: 4 }}>MEAN REV</span>
          {MR_TABS.map(t => (
            <button key={t.id} className={`nav-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {tab === 'universe'   && <Universe />}
        {tab === 'data'       && <DataLoader />}
        {tab === 'backtest'   && <Backtest onRunComplete={(id) => { setLastRunId(id); setTab('results'); }} />}
        {tab === 'results'    && <Results initialRunId={lastRunId} />}
        {tab === 'sd-zones'   && <SDZones onRunComplete={(id) => { setLastSD(id); setTab('sd-results'); }} />}
        {tab === 'sd-results' && <SDResults initialRunId={lastSDRunId} />}
        {tab === 'mr-lab'     && (
          <MRLab
            onRunComplete={(id) => { setLastMR(id); setLastMRSweep(null); setTab('mr-results'); }}
            onSweepComplete={(sweepId) => { setLastMRSweep(sweepId); setLastMR(null); setTab('mr-results'); }}
          />
        )}
        {tab === 'mr-results' && <MRResults initialRunId={lastMRRunId} initialSweepId={lastMRSweep} />}
      </main>
    </div>
  );
}
