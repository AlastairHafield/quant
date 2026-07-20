import React, { useState } from 'react';
import { runORBBacktest, runORBSweep } from '../api';

const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];
const TF_MINUTES = { '15m': 15, '5m': 5, '1m': 1 };

const selectStyle = {
  background: 'var(--surface2)', color: 'var(--text1)',
  border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 13, width: '100%',
};

const TRIGGER_INFO = {
  CLOSE:        'Enter the moment a bar CLOSES beyond the OR high/low.',
  TOUCH:        'Enter the instant price crosses the level intrabar (stop-style fill at the level).',
  CLOSE_NEXT:   'One bar closes beyond the range → enter at the NEXT bar\'s open.',
  CLOSE_2:      'Two consecutive closes beyond the range → enter at the 2nd close.',
  RETEST:       'Break, then price pulls back to retest the level → enter at the level.',
  RETEST_CLOSE: 'Break, pull back, then a bar closes back through → enter at that close. Historically the best cost-survivor of the retest styles.',
  FAILED_FADE:  'Break, then a bar closes back INSIDE the range (failed breakout) → fade the reversal instead of the breakout.',
};

const CATEGORICAL_SWEEPS = [
  { key: 'direction', label: 'Direction', values: ['LONG', 'SHORT', 'BOTH'] },
  { key: 'trigger',   label: 'Trigger',   values: ['CLOSE', 'TOUCH', 'CLOSE_NEXT', 'CLOSE_2', 'RETEST', 'RETEST_CLOSE', 'FAILED_FADE'] },
  { key: 'stopMode',  label: 'Stop Mode', values: ['OR_OPPOSITE', 'OR_FRAC', 'ATR', 'FIXED_PCT'] },
  { key: 'targetMode', label: 'Target Mode', values: ['R_MULTIPLE', 'OR_MULTIPLE', 'ATR', 'FIXED_PCT', 'EOD', 'TRAIL'] },
  { key: 'vwapMode',  label: 'VWAP Filter', values: ['OFF', 'ALIGN'] },
];

const SWEEPABLE_NUMERIC = [
  ['stopParam', 'Stop Param'],
  ['targetParam', 'Target Param'],
  ['entryCutoffNum', 'Entry Cutoff (HHMM)'],
  ['minDailyADX', 'Min Daily ADX'],
  ['maxDailyADX', 'Max Daily ADX'],
  ['volMult', 'Volume Mult'],
  ['minORRangePct', 'Min OR Range %'],
  ['maxORRangePct', 'Max OR Range %'],
  ['atrPctileMin', 'ATR Pctile Min'],
  ['atrPctileMax', 'ATR Pctile Max'],
];

const DOW_KEYS = [['M', 'Mon'], ['T', 'Tue'], ['W', 'Wed'], ['R', 'Thu'], ['F', 'Fri']];

function timeToHHMM(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 100 + m;
}

function range(from, to, step) {
  const out = [];
  if (step <= 0) return out;
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 10000) / 10000);
  return out;
}

// Showcases the 2026-07-20 study's winner by default: 15-min OR, 1-min entries,
// LONG/CLOSE/OR_FRAC(1.5)/EOD, cutoff noon, ADX>=25 — both SPY & QQQ clear 5bp cost.
export default function ORBLab({ onRunComplete, onSweepComplete }) {
  const [symbol, setSymbol]         = useState('SPY');
  const [customSymbol, setCustomSym] = useState('');
  const [timeframe, setTimeframe]   = useState('1m');
  const [dateFrom, setDateFrom]     = useState('2026-04-01');
  const [dateTo, setDateTo]         = useState('2026-07-17');

  const [orWindowMin, setOrWindowMin] = useState(15);
  const [direction, setDirection]     = useState('LONG');
  const [firstOnly, setFirstOnly]     = useState(true);
  const [trigger, setTrigger]         = useState('CLOSE');
  const [entryCutoff, setEntryCutoff] = useState('12:00');
  const [maxTradesPerDay, setMaxTrades] = useState(1);

  const [stopMode, setStopMode]     = useState('OR_FRAC');
  const [stopParam, setStopParam]   = useState(1.5);
  const [targetMode, setTargetMode] = useState('EOD');
  const [targetParam, setTargetParam] = useState(2);
  const [timeStopBars, setTimeStopBars] = useState(0);

  const [minORRangePct, setMinORRange] = useState(0);
  const [maxORRangePct, setMaxORRange] = useState(0);
  const [volMult, setVolMult]         = useState(0);
  const [gapMode, setGapMode]         = useState('OFF');
  const [gapMinPct, setGapMinPct]     = useState(0.2);

  const [trendMode, setTrendMode]     = useState('OFF');
  const [vwapMode, setVwapMode]       = useState('OFF');
  const [minDailyADX, setMinDailyADX] = useState(25);
  const [maxDailyADX, setMaxDailyADX] = useState(0);
  const [vixMin, setVixMin]           = useState(0);
  const [vixMax, setVixMax]           = useState(0);
  const [atrPctileMin, setAtrPctMin]  = useState(0);
  const [atrPctileMax, setAtrPctMax]  = useState(100);
  const [dowMask, setDowMask]         = useState({ M: true, T: true, W: true, R: true, F: true });

  const [sizingMode, setSizingMode]   = useState('RISK');
  const [accountSize, setAccountSize] = useState(100000);
  const [positionPct, setPositionPct] = useState(10);
  const [riskPct, setRiskPct]         = useState(0.5);
  const [compound, setCompound]       = useState(false);
  const [maxLeverage, setMaxLeverage] = useState(0);
  const [costPct, setCostPct]         = useState(0.02);

  const [running, setRunning] = useState(false);
  const [status, setStatus]   = useState(null);

  const [showSweep, setShowSweep] = useState(false);
  const [catSweeps, setCatSweeps] = useState({});
  const [slots, setSlots] = useState([
    { param: '', from: 1, to: 3, step: 0.5 },
    { param: '', from: 0, to: 0, step: 0 },
    { param: '', from: 0, to: 0, step: 0 },
  ]);
  const [sweeping, setSweeping] = useState(false);
  const [sweepStatus, setSweepStatus] = useState(null);

  const activeSymbol = symbol === 'CUSTOM' ? customSymbol.toUpperCase() : symbol;
  const barMinutes = TF_MINUTES[timeframe];
  const orBars = Math.max(1, Math.round(orWindowMin / barMinutes));

  function buildDowMaskStr() {
    const on = DOW_KEYS.filter(([k]) => dowMask[k]).map(([k]) => k);
    return on.length === 5 ? 'ALL' : on.join('');
  }

  function buildParams() {
    return {
      timeframe, orBars, direction, firstOnly, trigger,
      sizingMode, accountSize: parseFloat(accountSize),
      positionPct: parseFloat(positionPct) / 100, riskPct: parseFloat(riskPct) / 100,
      compound, maxLeverage: parseFloat(maxLeverage), costPct: parseFloat(costPct) / 100,
      stopMode, stopParam: parseFloat(stopParam), targetMode, targetParam: parseFloat(targetParam),
      timeStopBars: parseInt(timeStopBars), maxTradesPerDay: parseInt(maxTradesPerDay),
      entryCutoff: timeToHHMM(entryCutoff),
      minORRangePct: parseFloat(minORRangePct), maxORRangePct: parseFloat(maxORRangePct),
      volMult: parseFloat(volMult), gapMode, gapMinPct: parseFloat(gapMinPct),
      trendMode, vwapMode, minDailyADX: parseFloat(minDailyADX), maxDailyADX: parseFloat(maxDailyADX),
      vixMin: parseFloat(vixMin), vixMax: parseFloat(vixMax),
      atrPctileMin: parseFloat(atrPctileMin), atrPctileMax: parseFloat(atrPctileMax),
      dowMask: buildDowMaskStr(),
    };
  }

  function buildGrid() {
    const grid = {};
    for (const s of slots) {
      if (!s.param) continue;
      const vals = range(parseFloat(s.from), parseFloat(s.to), parseFloat(s.step));
      if (vals.length <= 1) continue;
      // entryCutoffNum is a UI-only alias for entryCutoff (which itself is stored as HHMM)
      grid[s.param === 'entryCutoffNum' ? 'entryCutoff' : s.param] = vals;
    }
    for (const c of CATEGORICAL_SWEEPS) {
      if (catSweeps[c.key]) grid[c.key] = c.values;
    }
    return grid;
  }

  const comboCount = Object.values(buildGrid()).reduce((n, vals) => n * vals.length, 1);
  const hasGrid = Object.keys(buildGrid()).length > 0;

  async function handleRun() {
    if (!activeSymbol) { setStatus({ type: 'error', msg: 'Enter a symbol.' }); return; }
    setRunning(true);
    setStatus({ type: 'info', msg: `Running ${trigger} on ${activeSymbol} (${timeframe}, ${orWindowMin}m OR). First run may take a while while data downloads${timeframe === '1m' ? ' from Alpaca' : ''}...` });
    try {
      const res = await runORBBacktest({ symbol: activeSymbol, dateFrom, dateTo, ...buildParams() });
      if (!res.success) {
        setStatus({ type: 'error', msg: res.error || 'Backtest failed.' });
      } else {
        const m = res.data.metrics;
        const note = res.data.coverageNote ? ` ⚠ ${res.data.coverageNote}` : '';
        setStatus({
          type: 'success',
          msg: `Done — ${m.full.totalTrades} trades. IS: ${m.is.totalReturnPct >= 0 ? '+' : ''}${m.is.totalReturnPct.toFixed(2)}% / OOS: ${m.oos.totalReturnPct >= 0 ? '+' : ''}${m.oos.totalReturnPct.toFixed(2)}%.${note}`,
        });
        onRunComplete(res.data.runId);
      }
    } catch (e) {
      setStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally { setRunning(false); }
  }

  async function handleSweep() {
    if (!activeSymbol) { setSweepStatus({ type: 'error', msg: 'Enter a symbol.' }); return; }
    if (!hasGrid) { setSweepStatus({ type: 'error', msg: 'Set at least one parameter range, or enable a categorical sweep.' }); return; }
    setSweeping(true);
    setSweepStatus({ type: 'info', msg: `Running ${comboCount} combos on ${activeSymbol} (${timeframe})... data downloads once, then each combo is fast.` });
    try {
      const res = await runORBSweep({ symbol: activeSymbol, dateFrom, dateTo, baseParams: buildParams(), grid: buildGrid() });
      if (!res.success) {
        setSweepStatus({ type: 'error', msg: res.error || 'Sweep failed.' });
      } else {
        const top = res.data.results[0];
        const note = res.data.coverageNote ? ` ⚠ ${res.data.coverageNote}` : '';
        setSweepStatus({
          type: 'success',
          msg: `Sweep done — ${res.data.comboCount} combos. Best OOS Sharpe: ${top?.oosSharpe ?? '—'}.${note}`,
        });
        onSweepComplete(res.data.sweepId);
      }
    } catch (e) {
      setSweepStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally { setSweeping(false); }
  }

  function setSlot(i, patch) {
    setSlots(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s));
  }

  return (
    <div>
      <p className="page-title">Opening-Range Breakout Lab</p>

      <div className="card" style={{ marginBottom: 16, background: 'var(--surface2)', padding: '10px 16px' }}>
        <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
          Build the Opening Range from the first N minutes of the session, then trade the first breakout beyond it.
          Results split into in-sample (first 70% of days) and out-of-sample (last 30%). Regime filters use the PRIOR
          day's daily chart — no lookahead. Always flat by end of day. Default preset here is the 2026-07-20 study's
          winner: 15-min OR traded on 1-min bars, LONG/CLOSE/OR_FRAC(1.5)/EOD, cutoff noon, ADX≥25 — both SPY and QQQ
          clear a realistic 5bp round-trip cost, in-sample and out-of-sample.
        </span>
      </div>

      <div className="card">
        <p className="card-title">Instrument &amp; Date Range</p>
        <div className="form-grid">
          <div className="field">
            <label>Symbol</label>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} style={selectStyle}>
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
              <option value="CUSTOM">Custom…</option>
            </select>
          </div>
          {symbol === 'CUSTOM' && (
            <div className="field">
              <label>Custom Symbol</label>
              <input type="text" value={customSymbol} onChange={e => setCustomSym(e.target.value.toUpperCase())}
                placeholder="e.g. IWM" maxLength={10} />
            </div>
          )}
          <div className="field">
            <label>Entry Bar Size</label>
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)} style={selectStyle}>
              <option value="15m">15 Min (FMP/Yahoo, ~5yr history)</option>
              <option value="5m">5 Min (Yahoo, last ~60 days only)</option>
              <option value="1m">1 Min (Alpaca, ~5yr history on free IEX feed)</option>
            </select>
          </div>
          <div className="field">
            <label>OR Window (minutes)</label>
            <input type="number" value={orWindowMin} min={barMinutes} max={120} step={barMinutes} onChange={e => setOrWindowMin(e.target.value)} />
          </div>
          <div className="field">
            <label>Date From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Date To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          {orWindowMin}min OR = {orBars} × {timeframe} bar{orBars === 1 ? '' : 's'}.
          {timeframe === '5m' && ' ⚠ Yahoo only serves ~60 days of 5m bars.'}
          {timeframe === '1m' && ' ⚠ On a cold cache, a multi-year 1-min fetch can take 1-2 minutes — Heroku kills requests after 30s, so keep the first run on a new symbol/range to a few months, then widen once it\'s cached.'}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Opening Range &amp; Entry</p>
        <div className="form-grid">
          <div className="field">
            <label>Direction</label>
            <select value={direction} onChange={e => setDirection(e.target.value)} style={selectStyle}>
              <option value="BOTH">Both (Long &amp; Short)</option>
              <option value="LONG">Long Only</option>
              <option value="SHORT">Short Only</option>
            </select>
          </div>
          <div className="field">
            <label>Trigger</label>
            <select value={trigger} onChange={e => setTrigger(e.target.value)} style={selectStyle}>
              <option value="CLOSE">Close Beyond</option>
              <option value="TOUCH">Intrabar Touch</option>
              <option value="CLOSE_NEXT">Close, Enter Next Open</option>
              <option value="CLOSE_2">Two Consecutive Closes</option>
              <option value="RETEST">Break + Retest Level</option>
              <option value="RETEST_CLOSE">Break + Retest + Reclaim</option>
              <option value="FAILED_FADE">Failed Breakout Fade</option>
            </select>
          </div>
          <div className="field">
            <label>First Side Only (per day)</label>
            <select value={firstOnly ? 'YES' : 'NO'} onChange={e => setFirstOnly(e.target.value === 'YES')} style={selectStyle}>
              <option value="YES">Yes — only the first side to break</option>
              <option value="NO">No — allow both sides</option>
            </select>
          </div>
          <div className="field">
            <label>Entry Cutoff (NY time)</label>
            <input type="time" value={entryCutoff} onChange={e => setEntryCutoff(e.target.value)} />
          </div>
          <div className="field">
            <label>Max Trades / Day</label>
            <input type="number" value={maxTradesPerDay} min={1} max={10} step={1} onChange={e => setMaxTrades(e.target.value)} />
          </div>
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          {TRIGGER_INFO[trigger]}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Stop &amp; Target</p>
        <div className="form-grid">
          <div className="field">
            <label>Stop Mode</label>
            <select value={stopMode} onChange={e => setStopMode(e.target.value)} style={selectStyle}>
              <option value="OR_OPPOSITE">Opposite side of OR</option>
              <option value="OR_FRAC">× OR range</option>
              <option value="ATR">× ATR</option>
              <option value="FIXED_PCT">Fixed % of price</option>
            </select>
          </div>
          {stopMode !== 'OR_OPPOSITE' && (
            <div className="field">
              <label>Stop Param</label>
              <input type="number" value={stopParam} min={0.1} max={5} step={0.1} onChange={e => setStopParam(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Target Mode</label>
            <select value={targetMode} onChange={e => setTargetMode(e.target.value)} style={selectStyle}>
              <option value="R_MULTIPLE">× Risk (R multiple)</option>
              <option value="OR_MULTIPLE">× OR range from level</option>
              <option value="ATR">× ATR</option>
              <option value="FIXED_PCT">Fixed % of price</option>
              <option value="EOD">Ride to close (no target)</option>
              <option value="TRAIL">Trailing stop (× ATR)</option>
            </select>
          </div>
          {targetMode !== 'EOD' && (
            <div className="field">
              <label>Target Param</label>
              <input type="number" value={targetParam} min={0.25} max={10} step={0.25} onChange={e => setTargetParam(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Time Stop (bars, 0 = off)</label>
            <input type="number" value={timeStopBars} min={0} max={200} step={1} onChange={e => setTimeStopBars(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Setup Filters</p>
        <div className="form-grid">
          <div className="field">
            <label>Min OR Range % (0 = off)</label>
            <input type="number" value={minORRangePct} min={0} max={5} step={0.01} onChange={e => setMinORRange(e.target.value)} />
          </div>
          <div className="field">
            <label>Max OR Range % (0 = off)</label>
            <input type="number" value={maxORRangePct} min={0} max={10} step={0.01} onChange={e => setMaxORRange(e.target.value)} />
          </div>
          <div className="field">
            <label>Volume Mult (0 = off)</label>
            <input type="number" value={volMult} min={0} max={5} step={0.1} onChange={e => setVolMult(e.target.value)} />
          </div>
          <div className="field">
            <label>Gap Filter</label>
            <select value={gapMode} onChange={e => setGapMode(e.target.value)} style={selectStyle}>
              <option value="OFF">Off</option>
              <option value="GAP_ONLY">Require a gap ≥ min%</option>
              <option value="ALIGN">Breakout must match gap direction</option>
            </select>
          </div>
          {gapMode !== 'OFF' && (
            <div className="field">
              <label>Gap Min %</label>
              <input type="number" value={gapMinPct} min={0.05} max={5} step={0.05} onChange={e => setGapMinPct(e.target.value)} />
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Regime Filters (prior day)</p>
        <div className="form-grid">
          <div className="field">
            <label>Daily Trend Filter</label>
            <select value={trendMode} onChange={e => setTrendMode(e.target.value)} style={selectStyle}>
              <option value="OFF">Off</option>
              <option value="ALIGN">Align — breakout must match daily trend</option>
              <option value="UP_ONLY">Up only (longs only)</option>
              <option value="DOWN_ONLY">Down only (shorts only)</option>
            </select>
          </div>
          <div className="field">
            <label>Session VWAP Filter</label>
            <select value={vwapMode} onChange={e => setVwapMode(e.target.value)} style={selectStyle}>
              <option value="OFF">Off</option>
              <option value="ALIGN">Align — entry price must be beyond VWAP</option>
            </select>
          </div>
          <div className="field">
            <label>Min Daily ADX (0 = off; the lever from the 2026-07-20 study)</label>
            <input type="number" value={minDailyADX} min={0} max={60} step={1} onChange={e => setMinDailyADX(e.target.value)} />
          </div>
          <div className="field">
            <label>Max Daily ADX (0 = off)</label>
            <input type="number" value={maxDailyADX} min={0} max={60} step={1} onChange={e => setMaxDailyADX(e.target.value)} />
          </div>
          <div className="field">
            <label>VIX Min (0 = off)</label>
            <input type="number" value={vixMin} min={0} max={80} step={1} onChange={e => setVixMin(e.target.value)} />
          </div>
          <div className="field">
            <label>VIX Max (0 = off)</label>
            <input type="number" value={vixMax} min={0} max={80} step={1} onChange={e => setVixMax(e.target.value)} />
          </div>
          <div className="field">
            <label>ATR Percentile Min (0–100)</label>
            <input type="number" value={atrPctileMin} min={0} max={100} step={5} onChange={e => setAtrPctMin(e.target.value)} />
          </div>
          <div className="field">
            <label>ATR Percentile Max (0–100)</label>
            <input type="number" value={atrPctileMax} min={0} max={100} step={5} onChange={e => setAtrPctMax(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 4 }}>
          <label>Days of Week Allowed</label>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
            {DOW_KEYS.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text2)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                <input type="checkbox" checked={dowMask[k]} onChange={e => setDowMask(prev => ({ ...prev, [k]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Position Sizing &amp; Costs</p>
        <div className="form-grid">
          <div className="field">
            <label>Sizing Mode</label>
            <select value={sizingMode} onChange={e => setSizingMode(e.target.value)} style={selectStyle}>
              <option value="RISK">Risk % per trade — size off the stop</option>
              <option value="NOTIONAL">Fixed % notional — deploy % of account</option>
            </select>
          </div>
          <div className="field">
            <label>Account Size ($)</label>
            <input type="number" value={accountSize} min={1000} max={100000000} step={1000} onChange={e => setAccountSize(e.target.value)} />
          </div>
          {sizingMode === 'RISK' ? (
            <div className="field">
              <label>Risk per Trade (% of account)</label>
              <input type="number" value={riskPct} min={0.05} max={10} step={0.05} onChange={e => setRiskPct(e.target.value)} />
            </div>
          ) : (
            <div className="field">
              <label>Position Size (% of account)</label>
              <input type="number" value={positionPct} min={1} max={500} step={1} onChange={e => setPositionPct(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Max Leverage (0 = off)</label>
            <input type="number" value={maxLeverage} min={0} max={20} step={0.5} onChange={e => setMaxLeverage(e.target.value)} />
          </div>
          <div className="field">
            <label>Compounding</label>
            <select value={compound ? 'YES' : 'NO'} onChange={e => setCompound(e.target.value === 'YES')} style={selectStyle}>
              <option value="NO">Fixed capital — additive in R (recommended for sweeps)</option>
              <option value="YES">Compound equity — size off running balance</option>
            </select>
          </div>
          <div className="field">
            <label>Round-Trip Cost (% of notional)</label>
            <input type="number" value={costPct} min={0} max={0.5} step={0.01} onChange={e => setCostPct(e.target.value)} />
          </div>
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          This edge is thin — the 2026-07-20 study found configs that looked great at 2bp (0.02) cost went negative at 5bp (0.05).
          Always check both before trusting a result.
        </div>

        <button className="btn btn-primary" onClick={handleRun} disabled={running || sweeping} style={{ marginTop: 12 }}>
          {running && <span className="spinner" />}
          {running ? 'Running...' : '▶  Run ORB Backtest'}
        </button>
        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>

      {/* Sweep panel */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setShowSweep(v => !v)}>
          <p className="card-title" style={{ margin: 0 }}>Parameter Sweep — find the edge automatically</p>
          <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>{showSweep ? '▲ hide' : '▼ expand'}</span>
        </div>
        {showSweep && (
          <div style={{ marginTop: 12 }}>
            <p style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 10 }}>
              Give up to 3 numeric parameters a range, and/or toggle categorical dimensions below. Every combination is
              backtested with the settings above as the base, then ranked by OUT-OF-SAMPLE Sharpe. Max 2000 combos.
            </p>
            {slots.map((s, i) => (
              <div key={i} className="form-grid" style={{ marginBottom: 4 }}>
                <div className="field">
                  <label>Parameter {i + 1}</label>
                  <select value={s.param} onChange={e => setSlot(i, { param: e.target.value })} style={selectStyle}>
                    <option value="">— none —</option>
                    {SWEEPABLE_NUMERIC.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>From</label>
                  <input type="number" value={s.from} step="any" onChange={e => setSlot(i, { from: e.target.value })} disabled={!s.param} />
                </div>
                <div className="field">
                  <label>To</label>
                  <input type="number" value={s.to} step="any" onChange={e => setSlot(i, { to: e.target.value })} disabled={!s.param} />
                </div>
                <div className="field">
                  <label>Step</label>
                  <input type="number" value={s.step} step="any" onChange={e => setSlot(i, { step: e.target.value })} disabled={!s.param} />
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '12px 0' }}>
              {CATEGORICAL_SWEEPS.map(c => (
                <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text2)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!catSweeps[c.key]} onChange={e => setCatSweeps(prev => ({ ...prev, [c.key]: e.target.checked }))} />
                  Sweep {c.label} ({c.values.length})
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <button className="btn btn-primary" onClick={handleSweep} disabled={sweeping || running || !hasGrid}>
                {sweeping && <span className="spinner" />}
                {sweeping ? 'Sweeping...' : `▶  Run Sweep (${hasGrid ? comboCount : 0} combos)`}
              </button>
              {sweepStatus && (
                <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: sweepStatus.type === 'success' ? 'var(--green)' : sweepStatus.type === 'error' ? 'var(--red)' : 'var(--text3)' }}>
                  {sweepStatus.msg}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
