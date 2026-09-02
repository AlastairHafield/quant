import React, { useState, useEffect, useRef } from 'react';
import { getGexBreakoutStatus } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false }) : '—';
const ageSec = (iso) => iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null;

const REGIME_CLASS = { TREND: 'pos', RANGE: 'neg' };

export default function GexBreakoutDashboard() {
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
      const res = await getGexBreakoutStatus();
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
        <p className="page-title">GEX Breakout — Order Flow Bot (Live Dashboard)</p>
        <div className="empty"><span className="spinner" /> Waiting for the worker's first status report...</div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div>
        <p className="page-title">GEX Breakout — Order Flow Bot (Live Dashboard)</p>
        <div className="status error">Backend unreachable ({error}).</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <p className="page-title">GEX Breakout — Order Flow Bot (Live Dashboard)</p>
        <div className="empty"><span className="spinner" /> Connecting to worker...</div>
      </div>
    );
  }

  const stale = ageSec(status.updatedAt) > 15;
  const ofLog = (status.recentLog || []).filter((row) => row.strategy === 'OF');

  return (
    <div>
      <p className="page-title">
        GEX Breakout — Order Flow Bot (Live Dashboard)
        {status.signalOnly && <span style={{ marginLeft: 10, color: 'var(--yellow)' }}>SIGNAL-ONLY MODE</span>}
        {stale && <span style={{ marginLeft: 10, color: 'var(--red)' }}>⚠ stale ({ageSec(status.updatedAt)}s)</span>}
      </p>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Regime</div>
          <div className={`metric-value ${REGIME_CLASS[status.regime] ?? ''}`} style={{ fontSize: 16 }}>
            {status.regime ?? '—'}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Prior-day ADX</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {r(status.adx, 1)} {status.adxOk ? '(trend-armed)' : ''}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Value Area (High / Low)</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {r(status.orderFlowDiagnostics?.valueArea?.high)} / {r(status.orderFlowDiagnostics?.valueArea?.low)}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">POC</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.orderFlowDiagnostics?.poc)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Last {status.instrumentData} Price</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.lastPrice)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Account Balance</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {status.account ? '$' + status.account.balance.toLocaleString() : '—'}
          </div>
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <p className="card-title">Day State — Order Flow Bot</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row label="Trades today" value={status.dayState.orderFlowTradesToday} />
            <Row label="W/L" value={`${status.dayState.winsToday?.OF ?? 0}W / ${status.dayState.lossesToday?.OF ?? 0}L`} />
            <Row
              label="Halted"
              value={status.dayState.haltedStrategies?.includes('OF') ? 'yes' : 'no'}
              warn={status.dayState.haltedStrategies?.includes('OF')}
            />
          </div>
        </div>

        <div className="card">
          <p className="card-title">Order Flow Walls (Value Area / POC)</p>
          <WallList label="Levels" walls={status.walls?.aboveSpot} />
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
        <p className="card-title">Recent Signals / Vetoes — Order Flow Bot ({ofLog.length})</p>
        {ofLog.length === 0 ? (
          <div className="empty">No signal evaluations yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Dir</th><th>Regime</th><th>Flow</th>
                  <th>Entry</th><th>Stop</th><th>Target</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {ofLog.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(row.ts)}</td>
                    <td>{row.direction && <span className={row.direction === 'long' ? 'tag-long' : 'tag-short'}>{row.direction}</span>}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{row.regime ?? '—'}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{row.flow_grade ?? '—'}</td>
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

function Row({ label, value, warn }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{label}</span>
      <span style={{ color: warn ? 'var(--red)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: warn ? 700 : 400 }}>{value}</span>
    </div>
  );
}

function WallList({ label, walls }) {
  return (
    <div>
      <div style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, marginBottom: 6 }}>{label.toUpperCase()}</div>
      {!walls || walls.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>none</div>
      ) : (
        walls.map((w, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(w.strike, 1)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{w.source ?? '—'}</span>
          </div>
        ))
      )}
    </div>
  );
}
