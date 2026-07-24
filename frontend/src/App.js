import React, { useState } from 'react';
import Universe from './pages/Universe';
import DataLoader from './pages/DataLoader';
import Backtest from './pages/Backtest';
import Results from './pages/Results';
import SDZones from './pages/SDZones';
import SDResults from './pages/SDResults';
import MRLab from './pages/MRLab';
import MRResults from './pages/MRResults';
import ORBLab from './pages/ORBLab';
import ORBResults from './pages/ORBResults';
import GexBreakoutDashboard from './pages/GexBreakoutDashboard';
import MechanicalOrbDashboard from './pages/MechanicalOrbDashboard';
import './App.css';

const PEAD_TABS = [
  { id: 'universe', label: 'Universe',  icon: '◈' },
  { id: 'data',     label: 'Data Load', icon: '⬇' },
  { id: 'backtest', label: 'PEAD',      icon: '▶' },
  { id: 'results',  label: 'Results',   icon: '◉' },
];

const SD_TABS = [
  { id: 'sd-zones',   label: 'S&D Zones',   icon: '▣' },
  { id: 'sd-results', label: 'S&D Results', icon: '◈' },
];

const MR_TABS = [
  { id: 'mr-lab',     label: 'MR Lab',     icon: '⇄' },
  { id: 'mr-results', label: 'MR Results', icon: '◉' },
];

const ORB_TABS = [
  { id: 'orb-lab',     label: 'ORB Lab',     icon: '⌁' },
  { id: 'orb-results', label: 'ORB Results', icon: '◉' },
];

const GEX_TABS = [
  { id: 'gex-dashboard', label: 'Live Dashboard', icon: '⬤' },
];

const MORB_TABS = [
  { id: 'morb-dashboard', label: 'Live Dashboard', icon: '⬤' },
];

const GROUPS = [
  { name: 'PEAD',      tabs: PEAD_TABS },
  { name: 'S&D',       tabs: SD_TABS },
  { name: 'MEAN REV',  tabs: MR_TABS },
  { name: 'ORB',       tabs: ORB_TABS },
  { name: 'GEX BREAKOUT', tabs: GEX_TABS },
  { name: 'MECHANICAL ORB', tabs: MORB_TABS },
];

const BUILD = 'v1.3';

export default function App() {
  const [tab, setTab]             = useState('universe');
  const [navOpen, setNavOpen]      = useState(false);
  const [lastRunId, setLastRunId] = useState(null);
  const [lastSDRunId, setLastSD]  = useState(null);
  const [lastMRRunId, setLastMR]  = useState(null);
  const [lastMRSweep, setLastMRSweep] = useState(null);
  const [lastORBRunId, setLastORB] = useState(null);
  const [lastORBSweep, setLastORBSweep] = useState(null);

  function selectTab(id) {
    setTab(id);
    setNavOpen(false);
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">QUANT</span>
          <span className="logo-sub">Multi-Strategy Engine</span>
          <span className="logo-build">{BUILD}</span>
        </div>

        <button className="nav-toggle" aria-label="Toggle navigation" onClick={() => setNavOpen(v => !v)}>
          <span className="nav-toggle-icon">{navOpen ? '✕' : '☰'}</span>
        </button>

        <nav className="nav nav-desktop">
          {GROUPS.map((g, gi) => (
            <React.Fragment key={g.name}>
              {gi > 0 && <span className="nav-divider" />}
              <span className="nav-group-label">{g.name}</span>
              {g.tabs.map(t => (
                <button key={t.id} className={`nav-btn ${tab === t.id ? 'active' : ''}`} onClick={() => selectTab(t.id)}>
                  <span className="nav-icon">{t.icon}</span>{t.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
      </header>

      {navOpen && (
        <nav className="nav-mobile">
          {GROUPS.map(g => (
            <div key={g.name} className="nav-mobile-group">
              <span className="nav-group-label">{g.name}</span>
              {g.tabs.map(t => (
                <button key={t.id} className={`nav-btn nav-btn-mobile ${tab === t.id ? 'active' : ''}`} onClick={() => selectTab(t.id)}>
                  <span className="nav-icon">{t.icon}</span>{t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}

      <main className="main">
        {tab === 'universe'   && <Universe />}
        {tab === 'data'       && <DataLoader />}
        {tab === 'backtest'   && <Backtest onRunComplete={(id) => { setLastRunId(id); selectTab('results'); }} />}
        {tab === 'results'    && <Results initialRunId={lastRunId} />}
        {tab === 'sd-zones'   && <SDZones onRunComplete={(id) => { setLastSD(id); selectTab('sd-results'); }} />}
        {tab === 'sd-results' && <SDResults initialRunId={lastSDRunId} />}
        {tab === 'mr-lab'     && (
          <MRLab
            onRunComplete={(id) => { setLastMR(id); setLastMRSweep(null); selectTab('mr-results'); }}
            onSweepComplete={(sweepId) => { setLastMRSweep(sweepId); setLastMR(null); selectTab('mr-results'); }}
          />
        )}
        {tab === 'mr-results' && <MRResults initialRunId={lastMRRunId} initialSweepId={lastMRSweep} />}
        {tab === 'orb-lab'     && (
          <ORBLab
            onRunComplete={(id) => { setLastORB(id); setLastORBSweep(null); selectTab('orb-results'); }}
            onSweepComplete={(sweepId) => { setLastORBSweep(sweepId); setLastORB(null); selectTab('orb-results'); }}
          />
        )}
        {tab === 'orb-results' && <ORBResults initialRunId={lastORBRunId} initialSweepId={lastORBSweep} />}
        {tab === 'gex-dashboard' && <GexBreakoutDashboard />}
        {tab === 'morb-dashboard' && <MechanicalOrbDashboard />}
      </main>
    </div>
  );
}
