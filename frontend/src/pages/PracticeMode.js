import React, { useState, useEffect, useRef } from 'react';
import { getGexBreakoutStatus, getTradeJournalTrades } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtUsd = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { hour12: false }) : '—';
const ageSec = (iso) => iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null;

// GEX Breakout's Order Flow Bot is currently the only strategy running on a
// practice account — everything else (Strategy B, Mechanical ORB, Gap
// Continuation) trades the real Combine. This page pulls GEX Breakout's
// status payload and shows only the orderFlowBot slice, plus the Order Flow
// Bot's own trades (accountRole "A") from the trade journal.
export default function PracticeMode() {
  const [status, setStatus] = useState(null);
  const [trades, setTrades] = useState(null);
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
      const [s, t] = await Promise.all([
        getGexBreakoutStatus(),
        getTradeJournalTrades({ accountRole: 'A' }),
      ]);
      setStatus(s.data);
      setTrades(t.data);
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
        <p className="page-title">Practice Mode</p>
        <div className="empty"><span className="spinner" /> Waiting for the worker's first status report...</div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div>
        <p className="page-title">Practice Mode</p>
        <div className="status error">Backend unreachable ({error}).</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <p className="page-title">Practice Mode</p>
        <div className="empty"><span className="spinner" /> Connecting...</div>
      </div>
    );
  }

  const a = status.orderFlowBot;
  const stale = ageSec(status.updatedAt) > 15;
  const aLog = (status.recentLog || []).filter((row) => row.strategy === 'OF');

  const closed = (trades || []).filter((t) => t.status === 'closed' && t.realizedPnl != null);
  const wins = closed.filter((t) => t.realizedPnl > 0).length;
  const losses = closed.filter((t) => t.realizedPnl < 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + t.realizedPnl, 0);

  return (
    <div>
      <p className="page-title">
        Practice Mode — GEX Breakout Order Flow Bot
        {a.signalOnly && <span style={{ marginLeft: 10, color: 'var(--yellow)' }}>SIGNAL-ONLY MODE</span>}
        {stale && <span style={{ marginLeft: 10, color: 'var(--red)' }}>⚠ stale ({ageSec(status.updatedAt)}s)</span>}
      </p>
      <div className="status" style={{ marginBottom: 16 }}>
        Not real money — practice account only. All-time P&amp;L below is fake and never mixes into the real
        Combine's numbers shown on the GEX Breakout or Trade Journal tabs.
      </div>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Regime</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{status.regime ?? '—'}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Practice Balance</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {a.account ? '$' + a.account.balance.toLocaleString() : '—'}
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">Wins / Losses (halt state)</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {status.dayState.winsToday?.OF ?? 0}W / {status.dayState.lossesToday?.OF ?? 0}L
          </div>
        </div>
        <div className="metric">
          <div className="metric-label">All-Time Trades / P&amp;L (fake $)</div>
          <div className="metric-value" style={{ fontSize: 16 }}>
            {closed.length} ({wins}W/{losses}L), {fmtUsd(totalPnl)}
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">
          Practice Account — {a.account?.name ?? '—'} · Open Positions ({a.openPositions?.length ?? 0})
        </p>
        {!a.openPositions?.length ? (
          <div className="empty">Flat — no open positions.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Contract</th><th>Side</th><th>Size</th><th>Avg Price</th></tr>
              </thead>
              <tbody>
                {a.openPositions.map((p) => (
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
        <p className="card-title">Recent Signals / Vetoes — Order Flow Bot ({aLog.length})</p>
        {aLog.length === 0 ? (
          <div className="empty">No signal evaluations yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Dir</th><th>Regime</th><th>Flow</th>
                  <th>Entry</th><th>Stop</th><th>Target</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {aLog.map((row, i) => (
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

      <div className="card">
        <p className="card-title">Practice Trades ({trades?.length ?? 0})</p>
        {!trades?.length ? (
          <div className="empty">No trades recorded yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Opened</th><th>Dir</th><th>Entry</th><th>Orig. Stop</th>
                  <th>Orig. Target</th><th>Exit</th><th>Outcome</th><th>P&amp;L (fake $)</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(t.openedAt)}</td>
                    <td>{t.direction && <span className={t.direction === 'long' ? 'tag-long' : 'tag-short'}>{t.direction}</span>}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.entryPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{r(t.originalStopPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>{r(t.originalTargetPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.exitPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.outcome ?? (t.status === 'open' ? 'open' : '—')}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: t.realizedPnl >= 0 ? 'var(--green)' : t.realizedPnl < 0 ? 'var(--red)' : undefined }}>
                      {fmtUsd(t.realizedPnl)}
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
