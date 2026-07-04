import React, { useState } from 'react';
import { runMRBacktest, runMRSweep } from '../api';

const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];

const selectStyle = {
  background: 'var(--surface2)', color: 'var(--text1)',
  border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 13, width: '100%',
};

const SIGNAL_INFO = {
  VWAP_FADE:   'Fade stretches from session VWAP: enter when close is ≥ Z std-devs away, target = revert to VWAP.',
  RSI_BB_FADE: 'Fade short-period RSI extremes (optionally confirmed by a Bollinger band breach), target = middle band.',
  GAP_FADE:    'Fade the overnight gap on the first bar of the day, target = prior day close. Ignores the session window.',
  PDL_FADE:    'Fade shallow pokes through the prior day high/low, target = retrace back into the prior day range.',
};

// Numeric params available to the sweep, per signal type (plus shared ones)
const SWEEPABLE = {
  VWAP_FADE:   [['zEntry', 'Z-Score Entry']],
  RSI_BB_FADE: [['rsiLow', 'RSI Low'], ['rsiHigh', 'RSI High'], ['bbStd', 'BB Std Dev']],
  GAP_FADE:    [['gapMinPct', 'Gap Min %'], ['gapMaxPct', 'Gap Max %']],
  PDL_FADE:    [['maxPenetrationATR', 'Max Penetration (ATR)'], ['retraceTargetPct', 'Retrace Target %']],
};
const SWEEPABLE_SHARED = [
  ['atrStopMult', 'ATR Stop Mult'],
  ['timeStopBars', 'Time Stop (bars)'],
  ['maxTradesPerDay', 'Max Trades/Day'],
  ['maxDailyADX', 'Max Daily ADX'],
  ['vixMax', 'VIX Max'],
];

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

export default function MRLab({ onRunComplete, onSweepComplete }) {
  const [symbol, setSymbol]         = useState('SPY');
  const [customSymbol, setCustomSym] = useState('');
  const [timeframe, setTimeframe]   = useState('1h');
  const [dateFrom, setDateFrom]     = useState('2025-01-02');
  const [dateTo, setDateTo]         = useState('2026-06-30');

  const [signalType, setSignalType] = useState('VWAP_FADE');
  const [zEntry, setZEntry]         = useState(2.0);
  const [rsiLen, setRsiLen]         = useState(2);
  const [rsiLow, setRsiLow]         = useState(10);
  const [rsiHigh, setRsiHigh]       = useState(90);
  const [bbLen, setBbLen]           = useState(20);
  const [bbStd, setBbStd]           = useState(2);
  const [requireBB, setRequireBB]   = useState(true);
  const [gapMinPct, setGapMinPct]   = useState(0.3);
  const [gapMaxPct, setGapMaxPct]   = useState(2.0);
  const [maxPenATR, setMaxPenATR]   = useState(0.5);
  const [retracePct, setRetracePct] = useState(25);

  const [trendMode, setTrendMode]     = useState('OFF');
  const [maxDailyADX, setMaxDailyADX] = useState(0);
  const [vixMax, setVixMax]           = useState(0);
  const [atrPctileMin, setAtrPctMin]  = useState(0);
  const [atrPctileMax, setAtrPctMax]  = useState(100);
  const [sessionStart, setSessionStart] = useState('10:00');
  const [sessionEnd, setSessionEnd]     = useState('15:30');

  const [direction, setDirection]       = useState('BOTH');
  const [atrStopMult, setAtrStopMult]   = useState(1.5);
  const [fixedStop, setFixedStop]       = useState(0.5);
  const [timeStopBars, setTimeStopBars] = useState(0);
  const [maxTradesPerDay, setMaxTrades] = useState(2);

  // Position sizing
  const [sizingMode, setSizingMode]   = useState('NOTIONAL');
  const [accountSize, setAccountSize] = useState(100000);
  const [positionPct, setPositionPct] = useState(10);   // NOTIONAL mode: % of account deployed
  const [riskPct, setRiskPct]         = useState(0.5);  // RISK mode: % of account risked to stop
  const [compound, setCompound]       = useState(true);

  const [running, setRunning] = useState(false);
  const [status, setStatus]   = useState(null);

  // Sweep state: 3 slots, each { param, from, to, step }
  const [showSweep, setShowSweep] = useState(false);
  const [sweepTrend, setSweepTrend] = useState(false);
  const [slots, setSlots] = useState([
    { param: '', from: 1, to: 3, step: 0.5 },
    { param: '', from: 0, to: 0, step: 0 },
    { param: '', from: 0, to: 0, step: 0 },
  ]);
  const [sweeping, setSweeping] = useState(false);
  const [sweepStatus, setSweepStatus] = useState(null);

  const activeSymbol = symbol === 'CUSTOM' ? customSymbol.toUpperCase() : symbol;
  const sweepOptions = [...(SWEEPABLE[signalType] || []), ...SWEEPABLE_SHARED];

  function buildParams() {
    return {
      signalType,
      timeframe,
      direction,
      sizingMode,
      accountSize: parseFloat(accountSize),
      positionPct: parseFloat(positionPct) / 100,
      riskPct: parseFloat(riskPct) / 100,
      compound,
      zEntry: parseFloat(zEntry),
      rsiLen: parseInt(rsiLen), rsiLow: parseFloat(rsiLow), rsiHigh: parseFloat(rsiHigh),
      bbLen: parseInt(bbLen), bbStd: parseFloat(bbStd), requireBB,
      gapMinPct: parseFloat(gapMinPct), gapMaxPct: parseFloat(gapMaxPct),
      maxPenetrationATR: parseFloat(maxPenATR), retraceTargetPct: parseFloat(retracePct),
      atrStopMult: parseFloat(atrStopMult), fixedStop: parseFloat(fixedStop),
      timeStopBars: parseInt(timeStopBars), maxTradesPerDay: parseInt(maxTradesPerDay),
      sessionStart: timeToHHMM(sessionStart), sessionEnd: timeToHHMM(sessionEnd),
      trendMode, maxDailyADX: parseFloat(maxDailyADX), vixMax: parseFloat(vixMax),
      atrPctileMin: parseFloat(atrPctileMin), atrPctileMax: parseFloat(atrPctileMax),
    };
  }

  function buildGrid() {
    const grid = {};
    for (const s of slots) {
      if (!s.param) continue;
      const vals = range(parseFloat(s.from), parseFloat(s.to), parseFloat(s.step));
      if (vals.length > 1) grid[s.param] = vals;
    }
    if (sweepTrend) grid.trendMode = ['OFF', 'ALIGN', 'FLAT_ONLY'];
    return grid;
  }

  const comboCount = Object.values(buildGrid()).reduce((n, vals) => n * vals.length, 1);
  const hasGrid = Object.keys(buildGrid()).length > 0;

  async function handleRun() {
    if (!activeSymbol) { setStatus({ type: 'error', msg: 'Enter a symbol.' }); return; }
    setRunning(true);
    setStatus({ type: 'info', msg: `Running ${signalType} on ${activeSymbol} (${timeframe}). First run may take 30–60s while data downloads...` });
    try {
      const res = await runMRBacktest({ symbol: activeSymbol, dateFrom, dateTo, ...buildParams() });
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
    if (!hasGrid) { setSweepStatus({ type: 'error', msg: 'Set at least one parameter range (or enable trend-mode sweep).' }); return; }
    setSweeping(true);
    setSweepStatus({ type: 'info', msg: `Running ${comboCount} combos on ${activeSymbol} (${timeframe})... data downloads once, then each combo is fast.` });
    try {
      const res = await runMRSweep({ symbol: activeSymbol, dateFrom, dateTo, baseParams: buildParams(), grid: buildGrid() });
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
      <p className="page-title">Mean-Reversion Lab</p>

      <div className="card" style={{ marginBottom: 16, background: 'var(--surface2)', padding: '10px 16px' }}>
        <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
          Hunt for an intraday mean-reversion edge. Results always split into in-sample (first 70% of days, for tuning)
          and out-of-sample (last 30%, the honest number). Regime filters use the PRIOR day's daily chart — no lookahead.
          All positions are flat by end of day. Under ~50 trades, results are noise.
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
                placeholder="e.g. ES=F" maxLength={10} />
            </div>
          )}
          <div className="field">
            <label>Timeframe</label>
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)} style={selectStyle}>
              <option value="1h">1 Hour (up to 2 years — best for edge-finding)</option>
              <option value="15m">15 Min (last ~60 days only)</option>
              <option value="5m">5 Min (last ~60 days only)</option>
            </select>
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
        {timeframe !== '1h' && (
          <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
            ⚠ Yahoo only serves ~60 days of {timeframe} bars — too little for a trustworthy IS/OOS split.
            Find the edge on 1h first, then spot-check it on {timeframe}.
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-title">Signal</p>
        <div className="form-grid">
          <div className="field">
            <label>Signal Type</label>
            <select value={signalType} onChange={e => setSignalType(e.target.value)} style={selectStyle}>
              <option value="VWAP_FADE">VWAP Stretch Fade</option>
              <option value="RSI_BB_FADE">RSI / Bollinger Fade</option>
              <option value="GAP_FADE">Opening Gap Fade</option>
              <option value="PDL_FADE">Prior-Day Extreme Fade</option>
            </select>
          </div>
          {signalType === 'VWAP_FADE' && (
            <div className="field">
              <label>Z-Score Entry (std devs from VWAP)</label>
              <input type="number" value={zEntry} min={0.5} max={5} step={0.25} onChange={e => setZEntry(e.target.value)} />
            </div>
          )}
          {signalType === 'RSI_BB_FADE' && (<>
            <div className="field">
              <label>RSI Length</label>
              <input type="number" value={rsiLen} min={2} max={14} step={1} onChange={e => setRsiLen(e.target.value)} />
            </div>
            <div className="field">
              <label>RSI Low (long entry ≤)</label>
              <input type="number" value={rsiLow} min={1} max={40} step={1} onChange={e => setRsiLow(e.target.value)} />
            </div>
            <div className="field">
              <label>RSI High (short entry ≥)</label>
              <input type="number" value={rsiHigh} min={60} max={99} step={1} onChange={e => setRsiHigh(e.target.value)} />
            </div>
            <div className="field">
              <label>Bollinger Length</label>
              <input type="number" value={bbLen} min={10} max={50} step={1} onChange={e => setBbLen(e.target.value)} />
            </div>
            <div className="field">
              <label>Bollinger Std Dev</label>
              <input type="number" value={bbStd} min={1} max={4} step={0.25} onChange={e => setBbStd(e.target.value)} />
            </div>
            <div className="field">
              <label>Require BB Breach</label>
              <select value={requireBB ? 'YES' : 'NO'} onChange={e => setRequireBB(e.target.value === 'YES')} style={selectStyle}>
                <option value="YES">Yes — RSI + band breach</option>
                <option value="NO">No — RSI alone</option>
              </select>
            </div>
          </>)}
          {signalType === 'GAP_FADE' && (<>
            <div className="field">
              <label>Gap Min %</label>
              <input type="number" value={gapMinPct} min={0.1} max={5} step={0.1} onChange={e => setGapMinPct(e.target.value)} />
            </div>
            <div className="field">
              <label>Gap Max % (skip runaway gaps)</label>
              <input type="number" value={gapMaxPct} min={0.5} max={10} step={0.1} onChange={e => setGapMaxPct(e.target.value)} />
            </div>
          </>)}
          {signalType === 'PDL_FADE' && (<>
            <div className="field">
              <label>Max Penetration (× ATR)</label>
              <input type="number" value={maxPenATR} min={0.1} max={3} step={0.1} onChange={e => setMaxPenATR(e.target.value)} />
            </div>
            <div className="field">
              <label>Retrace Target (% of prior-day range)</label>
              <input type="number" value={retracePct} min={5} max={100} step={5} onChange={e => setRetracePct(e.target.value)} />
            </div>
          </>)}
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          {SIGNAL_INFO[signalType]}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Market Regime Filters</p>
        <div className="form-grid">
          <div className="field">
            <label>Daily Trend Filter</label>
            <select value={trendMode} onChange={e => setTrendMode(e.target.value)} style={selectStyle}>
              <option value="OFF">Off — trade every day</option>
              <option value="ALIGN">Align — longs in uptrend, shorts in downtrend</option>
              <option value="FLAT_ONLY">Flat only — trade only range-bound days</option>
            </select>
          </div>
          <div className="field">
            <label>Max Daily ADX (0 = off; &lt;20 = choppy)</label>
            <input type="number" value={maxDailyADX} min={0} max={60} step={1} onChange={e => setMaxDailyADX(e.target.value)} />
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
          <div className="field">
            <label>Session Start (NY)</label>
            <input type="time" value={sessionStart} onChange={e => setSessionStart(e.target.value)} />
          </div>
          <div className="field">
            <label>Session End (NY)</label>
            <input type="time" value={sessionEnd} onChange={e => setSessionEnd(e.target.value)} />
          </div>
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          Trend / ADX / ATR / VIX are read from the PRIOR day's daily chart. Filters decide which days are tradeable;
          the session window decides which bars can trigger entries (gap fade always uses the first bar).
        </div>
      </div>

      <div className="card">
        <p className="card-title">Exits &amp; Risk</p>
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
            <label>ATR Stop Multiple (0 = use fixed $)</label>
            <input type="number" value={atrStopMult} min={0} max={5} step={0.25} onChange={e => setAtrStopMult(e.target.value)} />
          </div>
          <div className="field">
            <label>Fixed Stop ($, if ATR mult = 0)</label>
            <input type="number" value={fixedStop} min={0.05} max={20} step={0.05} onChange={e => setFixedStop(e.target.value)} />
          </div>
          <div className="field">
            <label>Time Stop (bars, 0 = off)</label>
            <input type="number" value={timeStopBars} min={0} max={50} step={1} onChange={e => setTimeStopBars(e.target.value)} />
          </div>
          <div className="field">
            <label>Max Trades / Day</label>
            <input type="number" value={maxTradesPerDay} min={1} max={10} step={1} onChange={e => setMaxTrades(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Position Sizing</p>
        <div className="form-grid">
          <div className="field">
            <label>Sizing Mode</label>
            <select value={sizingMode} onChange={e => setSizingMode(e.target.value)} style={selectStyle}>
              <option value="NOTIONAL">Fixed % notional — deploy % of account</option>
              <option value="RISK">Risk % per trade — size off the stop</option>
            </select>
          </div>
          <div className="field">
            <label>Account Size ($)</label>
            <input type="number" value={accountSize} min={1000} max={100000000} step={1000} onChange={e => setAccountSize(e.target.value)} />
          </div>
          {sizingMode === 'NOTIONAL' ? (
            <div className="field">
              <label>Position Size (% of account)</label>
              <input type="number" value={positionPct} min={1} max={500} step={1} onChange={e => setPositionPct(e.target.value)} />
            </div>
          ) : (
            <div className="field">
              <label>Risk per Trade (% of account)</label>
              <input type="number" value={riskPct} min={0.05} max={10} step={0.05} onChange={e => setRiskPct(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Compounding</label>
            <select value={compound ? 'YES' : 'NO'} onChange={e => setCompound(e.target.value === 'YES')} style={selectStyle}>
              <option value="YES">Compound equity — size off running balance</option>
              <option value="NO">Fixed capital — size off starting balance</option>
            </select>
          </div>
        </div>
        <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 4 }}>
          {sizingMode === 'RISK'
            ? 'Each trade is sized so a stop-out loses exactly this % of the account. With tight intraday stops this implies large notional (leverage) — that’s normal for risk-based sizing.'
            : 'Each trade deploys this % of the account as dollar exposure; P&L = notional × the trade’s % move.'}
          &nbsp;Sizing scales your $ return and % drawdown — it does NOT change Sharpe, win rate, or profit factor.
        </div>

        <button className="btn btn-primary" onClick={handleRun} disabled={running || sweeping} style={{ marginTop: 12 }}>
          {running && <span className="spinner" />}
          {running ? 'Running...' : '▶  Run MR Backtest'}
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
              Give up to 3 parameters a range. Every combination is backtested with the settings above as the base,
              then ranked by OUT-OF-SAMPLE Sharpe — so the winner isn't just the best curve-fit. Max 500 combos.
            </p>
            {slots.map((s, i) => (
              <div key={i} className="form-grid" style={{ marginBottom: 4 }}>
                <div className="field">
                  <label>Parameter {i + 1}</label>
                  <select value={s.param} onChange={e => setSlot(i, { param: e.target.value })} style={selectStyle}>
                    <option value="">— none —</option>
                    {sweepOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
              <input type="checkbox" id="sweepTrend" checked={sweepTrend} onChange={e => setSweepTrend(e.target.checked)} />
              <label htmlFor="sweepTrend" style={{ color: 'var(--text2)', fontSize: 12, fontFamily: 'var(--mono)', cursor: 'pointer' }}>
                Also sweep trend filter (Off / Align / Flat-only)
              </label>
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
