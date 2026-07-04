import React, { useState } from 'react';
import { runBacktest } from '../api';

export default function Backtest({ onRunComplete }) {
  const [dateFrom, setDateFrom] = useState('2018-01-01');
  const [dateTo, setDateTo] = useState('2024-12-31');
  const [holdDays, setHoldDays] = useState(60);
  const [positionPct, setPositionPct] = useState(10);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(null);

  async function handleRun() {
    setRunning(true);
    setStatus({ type: 'info', msg: 'Running backtest...' });
    try {
      const res = await runBacktest({
        dateFrom,
        dateTo,
        holdDays: parseInt(holdDays),
        positionPct: parseFloat(positionPct) / 100,
      });

      if (res.data?.error) {
        setStatus({ type: 'error', msg: res.data.error });
      } else {
        setStatus({ type: 'success', msg: `Backtest complete. ${res.data.metrics.totalTrades} trades processed.` });
        onRunComplete(res.data.runId);
      }
    } catch (e) {
      setStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <p className="page-title">Backtest Configuration</p>

      <div className="card">
        <p className="card-title">Strategy Parameters</p>
        <p style={{ color: 'var(--text2)', marginBottom: 20, lineHeight: 1.7 }}>
          By-the-book PEAD implementation. No stops, no take profits. Hold period is fixed calendar trading days.
          Position sizing is flat % of starting capital ($100,000). Change parameters and compare runs in Results.
        </p>

        <div className="form-grid">
          <div className="field">
            <label>Date From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>Date To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="field">
            <label>Hold Period (Trading Days)</label>
            <input
              type="number"
              value={holdDays}
              min={5} max={120}
              onChange={e => setHoldDays(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Position Size (% of Capital)</label>
            <input
              type="number"
              value={positionPct}
              min={1} max={25}
              onChange={e => setPositionPct(e.target.value)}
            />
          </div>
        </div>

        <div className="card" style={{ background: 'var(--surface2)', marginBottom: 20 }}>
          <p className="card-title">Fixed Parameters (Academic spec)</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              ['Entry', 'Open of reaction day'],
              ['Exit', 'Close of day N (time-based)'],
              ['Stop loss', 'None'],
              ['Take profit', 'None'],
              ['Filter', 'Concordant only'],
              ['Capital', '$100,000'],
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
          {running ? 'Running Backtest...' : '▶  Run Backtest'}
        </button>

        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>
    </div>
  );
}
