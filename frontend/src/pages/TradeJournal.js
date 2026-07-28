import React, { useState, useEffect, useCallback } from 'react';
import { getTradeJournalTrades, getTradeJournalExitActions, getTradeJournalDailySummaries } from '../api';

const r = (n, d = 2) => typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : '—';
const fmtUsd = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2) : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-US', { hour12: false }) : '—';

// All day-keys in this app are ET calendar dates (Date.prototype.toDateString(),
// computed from nowET() server-side) — the browser has to mirror that exact
// conversion rather than just using its own local "today", or "today" here
// could point at the wrong day for a UK-based browser (e.g. after 8pm ET,
// which is already the next calendar day in BST/GMT).
function todayEtDayKey() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toDateString();
}

// A lightweight version of gex-breakout's dailySummary.js computeTradeStats,
// for a day that hasn't had its real summary written yet (summaries are only
// posted once, at end of day) — so "today so far" still shows real numbers
// instead of a blank state until the scheduled flush catches up.
function computeLiveStats(trades) {
  const closed = trades.filter((t) => t.status === 'closed' && t.realizedPnl != null);
  const real = closed.filter((t) => (t.accountRole ?? 'default') !== 'A');
  const wins = real.filter((t) => t.realizedPnl > 0);
  const losses = real.filter((t) => t.realizedPnl < 0);
  const totalRealizedPnl = real.reduce((sum, t) => sum + t.realizedPnl, 0);
  return {
    totalTrades: real.length,
    wins: wins.length,
    losses: losses.length,
    winRate: real.length ? wins.length / real.length : null,
    totalRealizedPnl,
    avgRMultiple: null,
  };
}

export default function TradeJournal() {
  const [summaries, setSummaries] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [trades, setTrades] = useState(null);
  const [exitActions, setExitActions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadSummaries();
  }, []);

  useEffect(() => {
    if (selectedDay) loadDay(selectedDay);
  }, [selectedDay]);

  async function loadSummaries() {
    try {
      const s = await getTradeJournalDailySummaries();
      setSummaries(s.data);
      setError(null);
      // Default to the most recent day with a real summary, or today (ET) if
      // nothing's been posted yet — never defaults to whatever Mongo happens
      // to return first (that's the exact bug this replaces).
      setSelectedDay(s.data[0]?.dayKey || todayEtDayKey());
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  const loadDay = useCallback(async (dayKey) => {
    try {
      const [t, e] = await Promise.all([
        getTradeJournalTrades({ dayKey }),
        getTradeJournalExitActions({ dayKey }),
      ]);
      setTrades(t.data);
      setExitActions(e.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, []);

  if (error) {
    return (
      <div>
        <p className="page-title">Trade Journal</p>
        <div className="status error">Failed to load: {error}</div>
      </div>
    );
  }

  if (!summaries || !selectedDay) {
    return (
      <div>
        <p className="page-title">Trade Journal</p>
        <div className="empty"><span className="spinner" /> Loading...</div>
      </div>
    );
  }

  // Days available to jump to: every day with a posted summary, plus today
  // (ET) even before its summary exists — so "today so far" is always reachable.
  const availableDays = summaries.map((s) => s.dayKey);
  const today = todayEtDayKey();
  if (!availableDays.includes(today)) availableDays.unshift(today);
  const dayIndex = availableDays.indexOf(selectedDay);

  const postedSummary = summaries.find((s) => s.dayKey === selectedDay);
  const liveStats = trades ? computeLiveStats(trades) : null;
  const displayStats = postedSummary ? postedSummary.trades : liveStats;
  const isLive = !postedSummary;

  return (
    <div>
      <p className="page-title">Trade Journal</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={dayIndex >= availableDays.length - 1}
            onClick={() => setSelectedDay(availableDays[dayIndex + 1])}
          >
            ← Earlier
          </button>
          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px' }}
          >
            {availableDays.map((d) => (
              <option key={d} value={d}>{d}{d === today ? ' (today)' : ''}</option>
            ))}
          </select>
          <button
            className="btn"
            disabled={dayIndex <= 0}
            onClick={() => setSelectedDay(availableDays[dayIndex - 1])}
          >
            Later →
          </button>
          {selectedDay !== today && (
            <button className="btn btn-primary" onClick={() => setSelectedDay(today)}>Jump to today</button>
          )}
        </div>
      </div>

      {displayStats && (
        <div className="metrics-row">
          <div className="metric">
            <div className="metric-label">{selectedDay}{isLive && ' (live, no summary posted yet)'}</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {displayStats.totalTrades} trades, {displayStats.wins}W/{displayStats.losses}L
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Realized P&amp;L</div>
            <div className={`metric-value ${displayStats.totalRealizedPnl >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: 16 }}>
              {fmtUsd(displayStats.totalRealizedPnl)}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Win Rate</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {displayStats.winRate != null ? `${(displayStats.winRate * 100).toFixed(0)}%` : '—'}
            </div>
          </div>
          <div className="metric">
            <div className="metric-label">Avg R</div>
            <div className="metric-value" style={{ fontSize: 16 }}>
              {displayStats.avgRMultiple != null ? displayStats.avgRMultiple.toFixed(2) : '—'}
            </div>
          </div>
          {postedSummary && (
            <div className="metric">
              <div className="metric-label">Dynamic Exits Value</div>
              <div className="metric-value pos" style={{ fontSize: 16 }}>
                {fmtUsd(postedSummary.dynamicExits.totalValueImpact)}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <p className="card-title">Trades on {selectedDay} ({trades?.length ?? 0})</p>
        {!trades ? (
          <div className="empty"><span className="spinner" /> Loading...</div>
        ) : trades.length === 0 ? (
          <div className="empty">No trades recorded on this day.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Opened</th><th>System</th><th>Strategy</th><th>Account</th><th>Dir</th>
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
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: (t.accountRole ?? 'default') === 'A' ? 'var(--yellow)' : 'var(--text3)' }}>
                      {(t.accountRole ?? 'default') === 'A' ? 'practice' : 'real'}
                    </td>
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
        <p className="card-title">Dynamic Exit Actions on {selectedDay} ({exitActions?.length ?? 0})</p>
        {!exitActions?.length ? (
          <div className="empty">No dynamic-exit actions on this day.</div>
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
        <p className="card-title">All Daily Summaries ({summaries.length}) — click a row to jump to it</p>
        {!summaries.length ? (
          <div className="empty">No daily summaries yet — posted once at end of session.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Day</th><th>Trades</th><th>W/L</th><th>Win Rate</th><th>Avg R</th><th>P&amp;L</th><th>Dynamic Exit Value</th></tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr
                    key={s.dayKey}
                    onClick={() => setSelectedDay(s.dayKey)}
                    style={{ cursor: 'pointer', background: s.dayKey === selectedDay ? 'var(--bg2)' : undefined }}
                  >
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
