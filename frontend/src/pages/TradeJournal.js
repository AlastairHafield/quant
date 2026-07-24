import React, { useState, useEffect } from 'react';
import { getTradeJournalTrades, getTradeJournalExitActions, getTradeJournalDailySummaries } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtUsd = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { hour12: false }) : '—';

export default function TradeJournal() {
  const [trades, setTrades] = useState(null);
  const [exitActions, setExitActions] = useState(null);
  const [summaries, setSummaries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const [t, e, s] = await Promise.all([
        getTradeJournalTrades(),
        getTradeJournalExitActions(),
        getTradeJournalDailySummaries(),
      ]);
      setTrades(t.data);
      setExitActions(e.data);
      setSummaries(s.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  if (error) {
    return (
      <div>
        <p className="page-title">Trade Journal</p>
        <div className="status error">Failed to load: {error}</div>
      </div>
    );
  }

  if (!trades) {
    return (
      <div>
        <p className="page-title">Trade Journal</p>
        <div className="empty"><span className="spinner" /> Loading...</div>
      </div>
    );
  }

  const today = summaries?.[0];

  return (
    <div>
      <p className="page-title">Trade Journal</p>

      {today && (
        <div className="metrics-row">
          <div className="metric">
            <div className="metric-label">Today ({today.dayKey})</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {today.trades.totalTrades} trades, {today.trades.wins}W/{today.trades.losses}L
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Realized P&amp;L</div>
            <div className={`metric-value ${today.trades.totalRealizedPnl >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: 16 }}>
              {fmtUsd(today.trades.totalRealizedPnl)}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Win Rate</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {today.trades.winRate != null ? `${(today.trades.winRate * 100).toFixed(0)}%` : '—'}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Avg R</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {today.trades.avgRMultiple != null ? today.trades.avgRMultiple.toFixed(2) : '—'}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Dynamic Exits Value</div>
            <div className="metric-value pos" style={{ fontSize: 16 }}>
              {fmtUsd(today.dynamicExits.totalValueImpact)}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <p className="card-title">Trades ({trades.length})</p>
        {trades.length === 0 ? (
          <div className="empty">No trades recorded yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Opened</th><th>System</th><th>Strategy</th><th>Dir</th>
                  <th>Entry</th><th>Orig. Stop</th><th>Orig. Target</th><th>Exit</th>
                  <th>Outcome</th><th>P&amp;L</th><th>MFE</th><th>MAE</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(t.openedAt)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.system}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.strategy}</td>
                    <td>{t.direction && <span className={t.direction === 'long' ? 'tag-long' : 'tag-short'}>{t.direction}</span>}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.entryPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{r(t.originalStopPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>{r(t.originalTargetPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.exitPrice)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.outcome ?? (t.status === 'open' ? 'open' : '—')}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: t.realizedPnl >= 0 ? 'var(--green)' : t.realizedPnl < 0 ? 'var(--red)' : undefined }}>
                      {fmtUsd(t.realizedPnl)}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.mfe)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(t.mae)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-title">Dynamic Exit Actions ({exitActions?.length ?? 0})</p>
        {!exitActions?.length ? (
          <div className="empty">No dynamic-exit actions recorded yet.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>Time</th><th>Strategy</th><th>Action</th><th>Reason</th><th>$ Impact</th></tr>
              </thead>
              <tbody>
                {exitActions.map((a) => (
                  <tr key={a._id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(a.ts)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{a.strategy}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{a.action}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{a.reason}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>{fmtUsd(a.valueImpact)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-title">Daily Summaries ({summaries?.length ?? 0})</p>
        {!summaries?.length ? (
          <div className="empty">No daily summaries yet — posted once at end of session.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Day</th><th>Trades</th><th>W/L</th><th>Win Rate</th><th>Avg R</th><th>P&amp;L</th><th>Dynamic Exit Value</th></tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.dayKey}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s.dayKey}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s.trades.totalTrades}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s.trades.wins}/{s.trades.losses}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {s.trades.winRate != null ? `${(s.trades.winRate * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {s.trades.avgRMultiple != null ? s.trades.avgRMultiple.toFixed(2) : '—'}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: s.trades.totalRealizedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {fmtUsd(s.trades.totalRealizedPnl)}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>{fmtUsd(s.dynamicExits.totalValueImpact)}</td>
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
