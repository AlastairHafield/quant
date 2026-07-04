import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell } from 'recharts';
import { getSDBacktestRuns, getSDBacktestTrades, runSDBacktest } from '../api';

const r  = (n) => typeof n === 'number' ? Math.round(n * 100) / 100 : '—';
const pct = (n) => typeof n === 'number' ? (n >= 0 ? '+' : '') + r(n) + '%' : '—';
const dollar = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(r(n)).toLocaleString() : '—';

const EXIT_COLORS = { TARGET: '#00d4aa', STOP: '#ff4d6a', EOD: '#888fa0' };

export default function SDResults({ initialRunId }) {
  const [runs, setRuns]           = useState([]);
  const [selectedRun, setSelRun]  = useState(null);
  const [trades, setTrades]       = useState([]);
  const [loading, setLoading]     = useState(false);

  const [rerunParams, setRerunParams]   = useState(null);
  const [rerunning, setRerunning]       = useState(false);
  const [rerunStatus, setRerunStatus]   = useState(null);
  const [showRerun, setShowRerun]       = useState(false);

  useEffect(() => { loadRuns(true); }, []);
  useEffect(() => { if (initialRunId) selectRun(initialRunId); }, [initialRunId]);

  useEffect(() => {
    if (selectedRun?.params) {
      const p = JSON.parse(selectedRun.params);
      setRerunParams({
        rrRatio:     p.rrRatio     ?? 1.5,
        stopBuffer:  p.stopBuffer  ?? 0.04,
        positionPct: Math.round((p.positionPct ?? 0.1)  * 100),
        direction:   p.direction   ?? 'BOTH',
      });
    }
  }, [selectedRun?.id]);

  async function loadRuns(autoSelectFirst = false) {
    try {
      const res = await getSDBacktestRuns();
      const data = res.data || [];
      setRuns(data);
      if (autoSelectFirst && data.length > 0 && !selectedRun) selectRun(data[0].id);
      return data;
    } catch (e) { return []; }
  }

  async function selectRun(id) {
    setLoading(true);
    try {
      let run = runs.find(r => r.id === id);
      if (!run) {
        const fresh = await loadRuns();
        run = fresh.find(r => r.id === id);
      }
      setSelRun(run || { id });
      const res = await getSDBacktestTrades(id);
      setTrades(res.data || []);
    } catch (e) {} finally { setLoading(false); }
  }

  async function handleRerun() {
    if (!selectedRun || !rerunParams) return;
    const p = JSON.parse(selectedRun.params || '{}');
    setRerunning(true);
    setRerunStatus({ type: 'info', msg: `Re-running ${selectedRun.symbol} with adjusted parameters...` });
    try {
      const res = await runSDBacktest({
        symbol:       selectedRun.symbol,
        dateFrom:     selectedRun.date_from,
        dateTo:       selectedRun.date_to,
        div:          p.div          ?? 50,
        thresholdPct: p.thresholdPct ?? 10,
        stopBuffer:   parseFloat(rerunParams.stopBuffer),
        positionPct:  parseFloat(rerunParams.positionPct) / 100,
        rrRatio:      parseFloat(rerunParams.rrRatio),
        sessionStart: p.sessionStart ?? 930,
        sessionEnd:   p.sessionEnd   ?? 1100,
        direction:    rerunParams.direction,
        timeframe:    p.timeframe    ?? '1h',
      });
      if (!res.success) {
        setRerunStatus({ type: 'error', msg: res.error || 'Re-run failed.' });
      } else {
        setRerunStatus({ type: 'success', msg: 'Re-run complete.' });
        await selectRun(res.data.runId);
      }
    } catch (e) {
      setRerunStatus({ type: 'error', msg: e.response?.data?.error || e.message });
    } finally { setRerunning(false); }
  }

  const equityCurve  = buildEquityCurve(trades);
  const exitDist     = buildExitDist(trades);
  const m = selectedRun || {};

  return (
    <div>
      <p className="page-title">S&amp;D Zone Results</p>

      {runs.length > 0 && (
        <div className="card">
          <p className="card-title">Run History</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {runs.map(run => {
              const p = run.params ? JSON.parse(run.params) : {};
              return (
                <button
                  key={run.id}
                  className={`btn ${selectedRun?.id === run.id ? 'btn-primary' : ''}`}
                  onClick={() => selectRun(run.id)}
                  style={{ fontSize: 10 }}
                >
                  #{run.id} {run.symbol} — {run.date_from} → {run.date_to}
                  <span style={{ marginLeft: 8, opacity: 0.7 }}>{run.total_trades} trades</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="spinner" /> Loading results...</div>
      ) : trades.length === 0 ? (
        <div className="empty">No results yet. Run a backtest first.</div>
      ) : (
        <>
          <div className="metrics-row">
            {[
              { label: 'Total Return',  value: pct(m.total_return_pct),         cls: m.total_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Total P&L',     value: dollar(m.total_return_pct != null ? m.total_return_pct / 100 * 100000 : null), cls: m.total_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Win Rate',      value: pct(m.win_rate),                 cls: m.win_rate >= 50 ? 'pos' : 'neg' },
              { label: 'Avg Trade',     value: pct(m.avg_trade_return_pct),     cls: m.avg_trade_return_pct >= 0 ? 'pos' : 'neg' },
              { label: 'Sharpe',        value: r(m.sharpe),                     cls: m.sharpe >= 1 ? 'pos' : m.sharpe >= 0 ? '' : 'neg' },
              { label: 'Max Drawdown',  value: pct(m.max_drawdown_pct),         cls: 'neg' },
              { label: 'Total Trades',  value: m.total_trades,                  cls: '' },
            ].map(item => (
              <div key={item.label} className="metric">
                <div className="metric-label">{item.label}</div>
                <div className={`metric-value ${item.cls}`} style={{ fontSize: 18 }}>{item.value}</div>
              </div>
            ))}
          </div>

          {/* Exit breakdown row */}
          <div className="metrics-row" style={{ marginTop: 0 }}>
            {[
              { label: 'Target Hits', value: trades.filter(t => t.exit_result === 'TARGET').length, cls: 'pos' },
              { label: 'Stop Hits',   value: trades.filter(t => t.exit_result === 'STOP').length,   cls: 'neg' },
              { label: 'EOD Exits',   value: trades.filter(t => t.exit_result === 'EOD').length,    cls: '' },
              { label: 'Long Trades', value: trades.filter(t => t.signal === 'LONG').length,        cls: 'pos' },
              { label: 'Short Trades',value: trades.filter(t => t.signal === 'SHORT').length,       cls: 'neg' },
            ].map(item => (
              <div key={item.label} className="metric">
                <div className="metric-label">{item.label}</div>
                <div className={`metric-value ${item.cls}`} style={{ fontSize: 18 }}>{item.value}</div>
              </div>
            ))}
          </div>

          {/* Re-run panel */}
          {rerunParams && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                onClick={() => setShowRerun(v => !v)}>
                <p className="card-title" style={{ margin: 0 }}>Adjust Risk &amp; Reward — Re-run</p>
                <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 12 }}>{showRerun ? '▲ hide' : '▼ expand'}</span>
              </div>
              {showRerun && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 10 }}>
                    Symbol: <b style={{ color: 'var(--text2)' }}>{selectedRun?.symbol}</b>
                    &nbsp;&nbsp;Range: <b style={{ color: 'var(--text2)' }}>{selectedRun?.date_from} → {selectedRun?.date_to}</b>
                    &nbsp;&nbsp;Timeframe: <b style={{ color: 'var(--text2)' }}>{JSON.parse(selectedRun?.params || '{}').timeframe || '1h'}</b>
                  </div>
                  <div className="form-grid">
                    <div className="field">
                      <label>R:R Ratio (e.g. 1.5 = 1.5× risk)</label>
                      <input type="number" value={rerunParams.rrRatio} min={0.25} max={10} step={0.25}
                        onChange={e => setRerunParams(p => ({ ...p, rrRatio: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Stop Buffer ($)</label>
                      <input type="number" value={rerunParams.stopBuffer} min={0.01} max={5} step={0.01}
                        onChange={e => setRerunParams(p => ({ ...p, stopBuffer: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Position Size (% of $100k)</label>
                      <input type="number" value={rerunParams.positionPct} min={1} max={100} step={1}
                        onChange={e => setRerunParams(p => ({ ...p, positionPct: e.target.value }))} />
                    </div>
                    <div className="field">
                      <label>Direction</label>
                      <select value={rerunParams.direction}
                        onChange={e => setRerunParams(p => ({ ...p, direction: e.target.value }))}
                        style={{ background: 'var(--surface2)', color: 'var(--text1)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontFamily: 'var(--mono)', fontSize: 13, width: '100%' }}>
                        <option value="BOTH">Both</option>
                        <option value="LONG">Long Only</option>
                        <option value="SHORT">Short Only</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <button className="btn btn-primary" onClick={handleRerun} disabled={rerunning}>
                      {rerunning && <span className="spinner" />}
                      {rerunning ? 'Running...' : '▶  Re-run'}
                    </button>
                    {rerunStatus && (
                      <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: rerunStatus.type === 'success' ? 'var(--green)' : rerunStatus.type === 'error' ? 'var(--red)' : 'var(--text3)' }}>
                        {rerunStatus.msg}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="two-col">
            <div className="card">
              <p className="card-title">Equity Curve</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={equityCurve}>
                  <XAxis dataKey="date" tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <YAxis tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'} />
                  <Tooltip
                    contentStyle={{ background: '#111318', border: '1px solid #1e222d', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)' }}
                    formatter={v => ['$' + v.toLocaleString(), 'Equity']}
                  />
                  <ReferenceLine y={100000} stroke="#1e222d" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="equity" stroke="#00d4aa" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <p className="card-title">Exit Type Distribution</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={exitDist}>
                  <XAxis dataKey="label" tick={{ fill: '#555b6a', fontSize: 11 }} tickLine={false} />
                  <YAxis tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#111318', border: '1px solid #1e222d', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)' }}
                  />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {exitDist.map((entry, i) => (
                      <Cell key={i} fill={EXIT_COLORS[entry.key] || '#555b6a'} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card">
            <p className="card-title">Trade Log ({trades.length} trades)</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Dir</th>
                    <th>Zone</th>
                    <th>Entry</th>
                    <th>Target</th>
                    <th>Stop</th>
                    <th>Exit</th>
                    <th>Result</th>
                    <th>R/R</th>
                    <th>Return %</th>
                    <th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.trade_date}</td>
                      <td><span className={t.signal === 'LONG' ? 'tag-long' : 'tag-short'}>{t.signal}</span></td>
                      <td style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>
                        {t.zone_top?.toFixed(2)} / {t.zone_bottom?.toFixed(2)}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.entry_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#00d4aa' }}>{t.target_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ff4d6a' }}>{t.stop_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.exit_price?.toFixed(2)}</td>
                      <td>
                        <span style={{
                          padding: '2px 6px', borderRadius: 3, fontSize: 10, fontFamily: 'var(--mono)',
                          background: EXIT_COLORS[t.exit_result] + '22',
                          color: EXIT_COLORS[t.exit_result],
                        }}>
                          {t.exit_result}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.rr_ratio?.toFixed(2)}</td>
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
  const sorted = [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  let equity = 100000;
  const points = [{ date: sorted[0].trade_date, equity }];
  for (const t of sorted) {
    equity += t.pnl_dollars;
    points.push({ date: t.trade_date, equity: Math.round(equity) });
  }
  return points;
}

function buildExitDist(trades) {
  const counts = { TARGET: 0, STOP: 0, EOD: 0 };
  for (const t of trades) counts[t.exit_result] = (counts[t.exit_result] || 0) + 1;
  return [
    { key: 'TARGET', label: 'Target Hit', count: counts.TARGET },
    { key: 'STOP',   label: 'Stop Hit',   count: counts.STOP   },
    { key: 'EOD',    label: 'EOD Exit',   count: counts.EOD    },
  ];
}
