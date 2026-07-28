import React, { useState, useEffect, useRef } from 'react';
import { getGapContinuationStatus } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false }) : '—';
const ageSec = (iso) => iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null;

export default function GapContinuationDashboard() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [waitingForFirstReport, setWaitingForFirstReport] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 3000);
    return () => clearInterval(pollRef.current);
  }, []);

  async function load() {
    try {
      const res = await getGapContinuationStatus();
      setStatus(res.data);
      setError(null);
      setWaitingForFirstReport(false);
    } catch (e) {
      if (e.response?.status === 404) {
        setWaitingForFirstReport(true);
        setError(null);
      } else {
        setError(e.response?.data?.error || e.message);
      }
    }
  }

  if (waitingForFirstReport) {
    return (
      <div>
        <p className="page-title">Gap Continuation — Live Dashboard</p>
        <div className="empty"><span className="spinner" /> Waiting for the worker's first status report...</div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div>
        <p className="page-title">Gap Continuation — Live Dashboard</p>
        <div className="status error">Backend unreachable ({error}).</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <p className="page-title">Gap Continuation — Live Dashboard</p>
        <div className="empty"><span className="spinner" /> Connecting to worker...</div>
      </div>
    );
  }

  const stale = ageSec(status.updatedAt) > 15;

  return (
    <div>
      <p className="page-title">
        Gap Continuation — Live Dashboard
        {status.signalOnly && <span style={{ marginLeft: 10, color: 'var(--yellow)' }}>SIGNAL-ONLY MODE</span>}
        {stale && <span style={{ marginLeft: 10, color: 'var(--red)' }}>⚠ stale ({ageSec(status.updatedAt)}s)</span>}
      </p>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Prior RTH Close</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.priorClose)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Prior-Day ADX</div>
          <div className={`metric-value ${status.adxOk ? 'pos' : 'neg'}`} style={{ fontSize: 16 }}>
            {r(status.adx, 1)} {status.adxOk ? '(armed)' : '(below 25)'}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Evaluated Today</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{status.todayGapChecked ? 'YES' : 'not yet'}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Account Balance</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {status.account ? '$' + status.account.balance.toLocaleString() : '—'}
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">
          Account — {status.account?.name ?? '—'} · Open Positions ({status.openPositions?.length ?? 0})
        </p>
        {!status.openPositions?.length ? (
          <div className="empty">Flat — no open positions.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Contract</th><th>Side</th><th>Size</th><th>Avg Price</th></tr>
              </thead>
              <tbody>
                {status.openPositions.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{p.contractId}</td>
                    <td>
                      <span className={p.type === 1 ? 'tag-long' : p.type === 2 ? 'tag-short' : ''}>
                        {p.type === 1 ? 'LONG' : p.type === 2 ? 'SHORT' : `type ${p.type}`}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{p.size}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(p.averagePrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-title">Recent Signals / Vetoes ({status.recentLog?.length ?? 0})</p>
        {!status.recentLog?.length ? (
          <div className="empty">No signal evaluations yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Dir</th><th>Gap %</th><th>ADX</th>
                  <th>Entry</th><th>Stop</th><th>Target</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {status.recentLog.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(row.ts)}</td>
                    <td>{row.direction && <span className={row.direction === 'long' ? 'tag-long' : 'tag-short'}>{row.direction}</span>}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(row.gap_pct)}%</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(row.adx, 1)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(row.entry_price)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{r(row.stop_price)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>{r(row.target_price)}</td>
                    <td>
                      {row.veto_reason ? (
                        <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>veto: {row.veto_reason}</span>
                      ) : (
                        <span className="tag-long" style={{ fontSize: 10 }}>SIGNAL</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
