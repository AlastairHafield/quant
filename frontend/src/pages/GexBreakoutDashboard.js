import React, { useState, useEffect, useRef } from 'react';
import { getGexBreakoutStatus } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtGex = (v) => {
  if (typeof v !== 'number') return '—';
  const abs = Math.abs(v);
  const s = abs >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(0) + 'M';
  return (v >= 0 ? '+$' : '-$') + s.replace('-', '');
};
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour12: false }) : '—';
const ageSec = (iso) => iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null;

const REGIME_CLASS = { NEG_GAMMA: 'pos', POS_GAMMA: 'neg' };
const REGIME_STYLE_COLOR = { NEAR_FLIP: 'var(--yellow)' };

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
        <p className="page-title">GEX Breakout — Live Dashboard</p>
        <div className="empty"><span className="spinner" /> Waiting for the worker's first status report...</div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div>
        <p className="page-title">GEX Breakout — Live Dashboard</p>
        <div className="status error">Backend unreachable ({error}).</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <p className="page-title">GEX Breakout — Live Dashboard</p>
        <div className="empty"><span className="spinner" /> Connecting to worker...</div>
      </div>
    );
  }

  const stale = ageSec(status.updatedAt) > 15;

  return (
    <div>
      <p className="page-title">
        GEX Breakout — Live Dashboard
        {status.signalOnly && <span style={{ marginLeft: 10, color: 'var(--yellow)' }}>SIGNAL-ONLY MODE</span>}
        {stale && <span style={{ marginLeft: 10, color: 'var(--red)' }}>⚠ stale ({ageSec(status.updatedAt)}s)</span>}
      </p>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Regime</div>
          <div className={`metric-value ${REGIME_CLASS[status.regime] ?? ''}`}
               style={{ fontSize: 16, color: REGIME_STYLE_COLOR[status.regime] }}>
            {status.regime ?? '—'}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Net GEX</div>
          <div className={`metric-value ${status.gex?.netGex > 0 ? 'neg' : status.gex?.netGex < 0 ? 'pos' : ''}`} style={{ fontSize: 16 }}>
            {fmtGex(status.gex?.netGex)}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Flip Point (ES)</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.flipPointEs)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Basis (ES-SPX)</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.basis)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Last {status.instrumentData} Price</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{r(status.lastPrice)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">ORB H/L</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {status.orb.locked ? `${r(status.orb.high)} / ${r(status.orb.low)}` : 'forming...'}
          </div>
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <p className="card-title">Day State</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row label="ORB directions traded" value={status.dayState.orbTradedDirections.join(', ') || 'none'} />
            <Row label="Strategy B trades today" value={status.dayState.strategyBTradesToday} />
            <Row label="Consecutive losses" value={status.dayState.consecutiveLosses} warn={status.dayState.consecutiveLosses > 0} />
            <Row label="Halted for day" value={status.dayState.haltedForDay ? 'YES' : 'no'} warn={status.dayState.haltedForDay} />
          </div>
        </div>

        <div className="card">
          <p className="card-title">GEX Walls (ES terms)</p>
          <WallList label="Above spot" walls={status.wallsEs?.aboveSpot} />
          <div style={{ height: 10 }} />
          <WallList label="Below spot" walls={status.wallsEs?.belowSpot} />
        </div>
      </div>

      <div className="card">
        <p className="card-title">Recent Signals / Vetoes ({status.recentLog.length})</p>
        {status.recentLog.length === 0 ? (
          <div className="empty">No signal evaluations yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Strategy</th><th>Dir</th><th>Regime</th><th>Flow</th>
                  <th>Entry</th><th>Stop</th><th>Target</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {status.recentLog.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(row.ts)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{row.strategy ?? '—'}</td>
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
            <span className={w.wallType === 'POS_WALL' ? 'tag-short' : 'tag-long'} style={{ fontSize: 11 }}>{w.wallType}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(w.strike, 1)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{fmtGex(w.gex)}</span>
          </div>
        ))
      )}
    </div>
  );
}
