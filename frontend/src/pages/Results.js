import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from 'recharts';
import { getBacktestRuns, getBacktestTrades } from '../api';

const r = (n) => typeof n === 'number' ? Math.round(n * 100) / 100 : '—';
const pct = (n) => typeof n === 'number' ? (n >= 0 ? '+' : '') + r(n) + '%' : '—';
const dollar = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(r(n)).toLocaleString() : '—';

export default function Results({ initialRunId }) {
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadRuns();
  }, []);

  useEffect(() => {
    if (initialRunId) selectRun(initialRunId);
  }, [initialRunId]);

  async function loadRuns() {
    try {
      const res = await getBacktestRuns();
      setRuns(res.data || []);
      if (res.data?.length > 0 && !selectedRun) {
        selectRun(res.data[0].id);
      }
    } catch (e) {}
  }

  async function selectRun(id) {
    setLoading(true);
    try {
      const run = runs.find(r => r.id === id);
      setSelectedRun(run || { id });
      const res = await getBacktestTrades(id);
      setTrades(res.data || []);
      if (run === undefined) {
        await loadRuns();
      }
    } catch (e) {} finally {
      setLoading(false);
    }
  }

  // Build equity curve from trades
  const equityCurve = buildEquityCurve(trades);
  // Return distribution
  const returnDist = buildReturnDist(trades);

  const m = selectedRun || {};

  return (
    <div>
      <p className="page-title">Backtest Results</p>

      {runs.length > 0 && (
        <div className="card">
          <p className="card-title">Run History</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {runs.map(run => (
              <button
                key={run.id}
                className={`btn ${selectedRun?.id === run.id ? 'btn-primary' : ''}`}
                onClick={() => selectRun(run.id)}
                style={{ fontSize: 10 }}
              >
                #{run.id} — {run.date_from} → {run.date_to}
                <span style={{ marginLeft: 8, opacity: 0.7 }}>{run.total_trades} trades</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="spinner" /> Loading results...</div>
      ) : trades.length === 0 ? (
        <div className="empty">No results yet. Run a backtest first.</div>
      ) : (
        <>
          {/* METRICS */}
          <div className="metrics-row">
            {[
              { label: 'Total Return', value: pct(m.total_return_pct), cls: m.total_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Total P&L', value: dollar(m.total_return_pct ? (m.total_return_pct / 100) * 100000 : null), cls: m.total_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Win Rate', value: pct(m.win_rate), cls: m.win_rate >= 50 ? 'pos' : 'neg' },
              { label: 'Avg Trade', value: pct(m.avg_trade_return_pct), cls: m.avg_trade_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Sharpe', value: r(m.sharpe), cls: m.sharpe >= 1 ? 'pos' : m.sharpe >= 0 ? '' : 'neg' },
              { label: 'Max Drawdown', value: pct(m.max_drawdown_pct), cls: 'neg' },
              { label: 'Total Trades', value: m.total_trades, cls: '' },
            ].map(item => (
              <div key={item.label} className="metric">
                <div className="metric-label">{item.label}</div>
                <div className={`metric-value ${item.cls}`} style={{ fontSize: 18 }}>{item.value}</div>
              </div>
            ))}
          </div>

          {/* CHARTS */}
          <div className="two-col">
            <div className="card">
              <p className="card-title">Equity Curve</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={equityCurve}>
                  <XAxis dataKey="date" tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <YAxis tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} tickFormatter={v => '$' + (v/1000).toFixed(0) + 'k'} />
                  <Tooltip
                    contentStyle={{ background: '#111318', border: '1px solid #1e222d', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)' }}
                    formatter={(v) => ['$' + v.toLocaleString(), 'Equity']}
                  />
                  <ReferenceLine y={100000} stroke="#1e222d" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="equity" stroke="#00d4aa" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <p className="card-title">Trade Return Distribution</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={returnDist}>
                  <XAxis dataKey="bucket" tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <YAxis tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#111318', border: '1px solid #1e222d', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)' }}
                  />
                  <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                    {returnDist.map((entry, i) => (
                      <Cell key={i} fill={entry.bucket.startsWith('-') ? '#ff4d6a' : '#00d4aa'} fillOpacity={0.7} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* TRADE LOG */}
          <div className="card">
            <p className="card-title">Trade Log ({trades.length} trades)</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Signal</th>
                    <th>Entry Date</th>
                    <th>Entry Price</th>
                    <th>Exit Date</th>
                    <th>Exit Price</th>
                    <th>Hold Days</th>
                    <th>Return %</th>
                    <th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td style={{ color: 'var(--accent)' }}>{t.symbol}</td>
                      <td><span className={t.signal === 'LONG' ? 'tag-long' : 'tag-short'}>{t.signal}</span></td>
                      <td>{t.entry_date}</td>
                      <td>${t.entry_price?.toFixed(2)}</td>
                      <td>{t.exit_date}</td>
                      <td>${t.exit_price?.toFixed(2)}</td>
                      <td>{t.hold_days}</td>
                      <td className={t.return_pct >= 0 ? 'tag-long' : 'tag-short'}>
                        {t.return_pct >= 0 ? '+' : ''}{t.return_pct?.toFixed(2)}%
                      </td>
                      <td className={t.pnl_dollars >= 0 ? 'tag-long' : 'tag-short'}>
                        {dollar(t.pnl_dollars)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function buildEquityCurve(trades) {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
  let equity = 100000;
  const points = [{ date: sorted[0].entry_date, equity }];
  for (const t of sorted) {
    equity += t.pnl_dollars;
    points.push({ date: t.exit_date, equity: Math.round(equity) });
  }
  return points;
}

function buildReturnDist(trades) {
  const buckets = {};
  const boundaries = [-20, -15, -10, -5, 0, 5, 10, 15, 20];
  for (const t of trades) {
    const r = t.return_pct;
    let bucket = r < boundaries[0] ? `<${boundaries[0]}%` : `>${boundaries[boundaries.length - 1]}%`;
    for (let i = 0; i < boundaries.length - 1; i++) {
      if (r >= boundaries[i] && r < boundaries[i + 1]) {
        bucket = `${boundaries[i]}%`;
        break;
      }
    }
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }
  return Object.entries(buckets)
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    .map(([bucket, count]) => ({ bucket, count }));
}
