import React, { useState } from 'react';
import { runSDBacktest, parsePineScript } from '../api';

const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'TQQQ', 'SQQQ'];

const selectStyle = {
  background: 'var(--surface2)', color: 'var(--text1)',
  border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 13, width: '100%',
};

function timeToHHMM(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 100 + m;
}

function hhmmToTime(n) {
  const h = Math.floor(n / 100);
  const m = n % 100;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

export default function SDZones({ onRunComplete }) {
  const [symbol, setSymbol]           = useState('SPY');
  const [customSymbol, setCustomSym]  = useState('');
  const [dateFrom, setDateFrom]       = useState('2024-07-01');
  const [dateTo, setDateTo]           = useState('2026-05-24');
  const [thresholdPct, setThreshold]  = useState(10);
  const [div, setDiv]                 = useState(50);
  const [stopBuffer, setStopBuffer]   = useState(0.04);
  const [positionPct, setPositionPct] = useState(10);
  const [rrRatio, setRrRatio]         = useState(1.5);
  const [sessionStart, setSessionStart] = useState('09:30');
  const [sessionEnd, setSessionEnd]     = useState('11:00');
  const [direction, setDirection]       = useState('BOTH');
  const [timeframe, setTimeframe]       = useState('1h');
  const [running, setRunning]         = useState(false);
  const [status, setStatus]           = useState(null);

  const [pineCode, setPineCode]   = useState('');
  const [parsing, setParsing]     = useState(false);
  const [parseStatus, setParseStatus] = useState(null);
  const [showPine, setShowPine]   = useState(false);

  const activeSymbol = symbol === 'CUSTOM' ? customSymbol.toUpperCase() : symbol;

  async function handleRun() {
    if (!activeSymbol) {
      setStatus({ type: 'error', msg: 'Enter a symbol.' });
      return;
    }
    setRunning(true);
    setStatus({ type: 'info', msg: `Fetching ${timeframe} data for ${activeSymbol} and running backtest. First run may take 30–60 seconds while data downloads...` });
    try {
      const res = await runSDBacktest({
        symbol: activeSymbol,
        dateFrom,
        dateTo,
        div: parseInt(div),
        thresholdPct: parseFloat(thresholdPct),
        stopBuffer: parseFloat(stopBuffer),
        positionPct: parseFloat(positionPct) / 100,
        rrRatio: parseFloat(rrRatio),
        sessionStart: timeToHHMM(sessionStart),
        sessionEnd: timeToHHMM(sessionEnd),
        direction,
        timeframe,
      });

      if (!res.success) {
        setStatus({ type: 'error', msg: res.error || 'Backtest failed.' });
      } else {
        const m = res.data.metrics;
        setStatus({
          type: 'success',
          msg: `Done — ${m.totalTrades} trades, ${m.winRate}% win rate, ${m.totalReturnPct >= 0 ? '+' : ''}${m.totalReturnPct}% return.`,
        });
        onRunComplete(res.data.runId);
      }
    } catch (e) {
      setStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally {
      setRunning(false);
    }
  }

  async function handleParse() {
    if (!pineCode.trim()) return;
    setParsing(true);
    setParseStatus(null);
    try {
      const res = await parsePineScript({ code: pineCode });
      if (!res.success) {
        setParseStatus({ type: 'error', msg: res.error || 'Parse failed.' });
        return;
      }
      const p = res.data;
      let filled = [];
      if (p.rrRatio != null)        { setRrRatio(p.rrRatio); filled.push('R:R Ratio'); }
      if (p.sessionStart != null)  { setSessionStart(hhmmToTime(p.sessionStart)); filled.push('Session Start'); }
      if (p.sessionEnd != null)    { setSessionEnd(hhmmToTime(p.sessionEnd)); filled.push('Session End'); }
      if (p.direction != null)     { setDirection(p.direction); filled.push('Direction'); }
      if (p.stopBuffer != null)    { setStopBuffer(p.stopBuffer); filled.push('Stop Buffer'); }
      if (p.thresholdPct != null)  { setThreshold(p.thresholdPct); filled.push('Threshold %'); }
      if (p.div != null)           { setDiv(p.div); filled.push('Resolution'); }
      setParseStatus({
        type: 'success',
        msg: filled.length > 0
          ? `Auto-filled: ${filled.join(', ')}.`
          : 'No parameters detected — check your Pine Script code.',
      });
    } catch (e) {
      setParseStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally {
      setParsing(false);
    }
  }

  return (
    <div>
      <p className="page-title">Supply &amp; Demand Zone Backtest</p>

      <div className="card" style={{ marginBottom: 16, background: 'var(--surface2)', padding: '10px 16px' }}>
        <span style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
          Zones are built from prior day's bars using volume-weighted bin analysis.
          Entry when price touches a zone during the session window with correct approach direction.
          Stop = entry candle low/high ± buffer. Target = entry ± (stop distance × R:R ratio).
          Both 1h and 15m support up to ~2 years of history. 15m fetches in 58-day chunks on first run.
        </span>
      </div>

      {/* Pine Script Import */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          onClick={() => setShowPine(v => !v)}>
          <p className="card-title" style={{ margin: 0 }}>Auto-fill from Pine Script</p>
          <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>{showPine ? '▲ hide' : '▼ expand'}</span>
        </div>
        {showPine && (
          <div style={{ marginTop: 12 }}>
            <p style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 8 }}>
              Paste your Pine Script strategy below. Claude AI will read it and auto-fill the parameters it can detect.
            </p>
            <textarea
              value={pineCode}
              onChange={e => setPineCode(e.target.value)}
              placeholder="Paste Pine Script code here..."
              rows={10}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--surface2)', color: 'var(--text1)',
                border: '1px solid var(--border)', borderRadius: 4,
                padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 12,
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <button className="btn" onClick={handleParse} disabled={parsing || !pineCode.trim()}>
                {parsing && <span className="spinner" />}
                {parsing ? 'Parsing...' : '✦ Parse with Claude AI'}
              </button>
              {parseStatus && (
                <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: parseStatus.type === 'success' ? 'var(--green)' : 'var(--red)' }}>
                  {parseStatus.msg}
                </span>
              )}
            </div>
          </div>
        )}
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
              <input
                type="text"
                value={customSymbol}
                onChange={e => setCustomSym(e.target.value.toUpperCase())}
                placeholder="e.g. ES=F"
                maxLength={10}
              />
            </div>
          )}
          <div className="field">
            <label>Timeframe</label>
            <select value={timeframe} onChange={e => setTimeframe(e.target.value)} style={selectStyle}>
              <option value="1h">1 Hour (up to 2 years)</option>
              <option value="15m">15 Min (up to 2 years, chunked)</option>
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
      </div>

      <div className="card">
        <p className="card-title">Strategy Parameters</p>
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
            <label>R:R Ratio (e.g. 1.5 = 1.5× risk)</label>
            <input type="number" value={rrRatio} min={0.25} max={10} step={0.25}
              onChange={e => setRrRatio(e.target.value)} />
          </div>
          <div className="field">
            <label>Session Start (NY)</label>
            <input type="time" value={sessionStart} onChange={e => setSessionStart(e.target.value)} />
          </div>
          <div className="field">
            <label>Session End (NY)</label>
            <input type="time" value={sessionEnd} onChange={e => setSessionEnd(e.target.value)} />
          </div>
          <div className="field">
            <label>Stop Buffer ($)</label>
            <input type="number" value={stopBuffer} min={0.01} max={5} step={0.01}
              onChange={e => setStopBuffer(e.target.value)} />
          </div>
          <div className="field">
            <label>Position Size (% of $100k)</label>
            <input type="number" value={positionPct} min={1} max={100} step={1}
              onChange={e => setPositionPct(e.target.value)} />
          </div>
          <div className="field">
            <label>Threshold % (Zone Volume)</label>
            <input type="number" value={thresholdPct} min={1} max={50} step={0.5}
              onChange={e => setThreshold(e.target.value)} />
          </div>
          <div className="field">
            <label>Resolution (Bins)</label>
            <input type="number" value={div} min={10} max={200} step={5}
              onChange={e => setDiv(e.target.value)} />
          </div>
        </div>

        <div className="card" style={{ background: 'var(--surface2)', marginBottom: 20 }}>
          <p className="card-title">Fixed Parameters</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['Entry',        'Bar close touching zone'],
              ['Stop (long)',  'Entry candle low − buffer'],
              ['Stop (short)', 'Entry candle high + buffer'],
              ['Target',       'Entry ± (stop distance × R:R)'],
              ['Max trades',   '1 per session'],
              ['EOD exit',     'Last bar close if no fill'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{k}</span>
                <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 11 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" onClick={handleRun} disabled={running}>
          {running && <span className="spinner" />}
          {running ? 'Running...' : '▶  Run S&D Backtest'}
        </button>

        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>
    </div>
  );
}
