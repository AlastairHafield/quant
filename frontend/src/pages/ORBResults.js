import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { getORBRuns, getORBTrades, getORBSweep } from '../api';

const r  = (n) => typeof n === 'number' ? Math.round(n * 100) / 100 : '—';
const pct = (n) => typeof n === 'number' ? (n >= 0 ? '+' : '') + r(n) + '%' : '—';
const dollar = (n) => typeof n === 'number' ? (n >= 0 ? '+$' : '-$') + Math.abs(r(n)).toLocaleString() : '—';

const EXIT_COLORS = { TARGET: '#00d4aa', STOP: '#ff4d6a', TIME: '#e8b93c', EOD: '#888fa0' };

export default function ORBResults({ initialRunId, initialSweepId }) {
  const [runs, setRuns]          = useState([]);
  const [selectedRun, setSelRun] = useState(null);
  const [trades, setTrades]      = useState([]);
  const [sweepRuns, setSweepRuns] = useState([]);
  const [loading, setLoading]    = useState(false);

  useEffect(() => { loadRuns(!initialRunId && !initialSweepId); }, []);
  useEffect(() => { if (initialRunId) selectRun(initialRunId); }, [initialRunId]);
  useEffect(() => { if (initialSweepId) openSweep(initialSweepId); }, [initialSweepId]);

  async function loadRuns(autoSelectFirst = false) {
    try {
      const res = await getORBRuns();
      const data = res.data || [];
      setRuns(data);
      if (autoSelectFirst && data.length > 0) selectRun(data[0].id, data);
      return data;
    } catch (e) { return []; }
  }

  async function selectRun(id, runList = null) {
    setLoading(true);
    try {
      let list = runList || runs;
      let run = list.find(x => x.id === id);
      if (!run) {
        list = await loadRuns();
        run = list.find(x => x.id === id);
      }
      setSelRun(run || { id });
      if (run?.sweep_id) {
        const sw = await getORBSweep(run.sweep_id);
        setSweepRuns(sw.data || []);
      } else {
        setSweepRuns([]);
      }
      const res = await getORBTrades(id);
      setTrades(res.data || []);
    } catch (e) {} finally { setLoading(false); }
  }

  async function openSweep(sweepId) {
    setLoading(true);
    try {
      await loadRuns();
      const sw = await getORBSweep(sweepId);
      const data = sw.data || [];
      setSweepRuns(data);
      if (data.length > 0) {
        setSelRun(data[0]);
        const res = await getORBTrades(data[0].id);
        setTrades(res.data || []);
      }
    } catch (e) {} finally { setLoading(false); }
  }

  const m = selectedRun ? safeParse(selectedRun.metrics) : null;
  const params = selectedRun ? safeParse(selectedRun.params) : null;
  const accountSize = params?.accountSize ?? 100000;
  const equityCurve = buildEquityCurve(trades, accountSize);
  const oosStart = trades.find(t => t.sample === 'OOS')?.trade_date;

  return (
    <div>
      <p className="page-title">Opening-Range Breakout Results</p>

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
                #{run.id} {run.symbol} ({run.timeframe})
                {run.sweep_id && <span style={{ marginLeft: 6, opacity: 0.7 }}>⚙sweep</span>}
                <span style={{ marginLeft: 8, opacity: 0.7 }}>{run.total_trades} trades</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="spinner" /> Loading results...</div>
      ) : !selectedRun ? (
        <div className="empty">No results yet. Run a backtest in the ORB Lab first.</div>
      ) : (
        <>
          {/* Sweep leaderboard */}
          {sweepRuns.length > 1 && (
            <div className="card">
              <p className="card-title">Sweep Leaderboard — ranked by out-of-sample Sharpe ({sweepRuns.length} combos)</p>
              <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th><th>Params</th><th>Trades</th>
                      <th>IS Sharpe</th><th>OOS Sharpe</th>
                      <th>IS Ret</th><th>OOS Ret</th>
                      <th>OOS PF</th><th>OOS Win%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sweepRuns.map((run, i) => (
                      <tr key={run.id}
                        onClick={() => selectRun(run.id)}
                        style={{ cursor: 'pointer', background: selectedRun?.id === run.id ? 'var(--surface2)' : undefined }}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{i + 1}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>{comboLabel(run, sweepRuns)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{run.total_trades}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={run.is_sharpe >= 0 ? 'tag-long' : 'tag-short'}>{r(run.is_sharpe)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700 }} className={run.oos_sharpe >= 0 ? 'tag-long' : 'tag-short'}>{r(run.oos_sharpe)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={run.is_return_pct >= 0 ? 'tag-long' : 'tag-short'}>{pct(run.is_return_pct)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={run.oos_return_pct >= 0 ? 'tag-long' : 'tag-short'}>{pct(run.oos_return_pct)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(run.oos_profit_factor)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r(run.oos_win_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 6 }}>
                A real edge shows positive IS AND OOS with similar numbers, and its neighbours in the table are also decent.
                A top row whose neighbours are all red is curve-fit — don't trust it. Re-check the winner at a higher costPct too.
              </div>
            </div>
          )}

          {/* Full / IS / OOS comparison */}
          {m && (
            <div className="card">
              <p className="card-title">
                {selectedRun.symbol} · {selectedRun.timeframe}
                &nbsp;·&nbsp; {selectedRun.date_from} → {selectedRun.date_to}
                &nbsp;·&nbsp; OOS starts {m.splitDate}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th></th>
                      <th>Full Period</th>
                      <th>In-Sample (tuning)</th>
                      <th style={{ color: '#00d4aa' }}>Out-of-Sample (honest)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Trades',        s => s.totalTrades,                    v => v],
                      ['Win Rate',      s => s.winRate,                        v => pct(v)],
                      ['Total Return',  s => s.totalReturnPct,                 v => pct(v)],
                      ['Total P&L',     s => s.totalPnlDollars,                v => dollar(v)],
                      ['Avg Trade',     s => s.avgTradeReturnPct,              v => pct(v)],
                      ['Sharpe',        s => s.sharpe,                         v => r(v)],
                      ['Profit Factor', s => s.profitFactor,                   v => r(v)],
                      ['Expectancy',    s => s.expectancy,                     v => dollar(v)],
                      ['Avg Win / Loss', s => `${pct(s.avgWinPct)} / ${pct(s.avgLossPct)}`, v => v],
                      ['Max Drawdown',  s => s.maxDrawdownPct,                 v => pct(v)],
                      ['Exits T/S/Time/EOD', s => `${s.targetHits}/${s.stopHits}/${s.timeExits}/${s.eodExits}`, v => v],
                    ].map(([label, get, fmt]) => (
                      <tr key={label}>
                        <td style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{label}</td>
                        {[m.full, m.is, m.oos].map((set, i) => {
                          const raw = get(set);
                          const num = typeof raw === 'number' ? raw : null;
                          const cls = num == null ? '' :
                            (label === 'Max Drawdown') ? 'tag-short' :
                            (label === 'Trades') ? '' :
                            num >= (label === 'Win Rate' ? 50 : label === 'Profit Factor' ? 1 : 0) ? 'tag-long' : 'tag-short';
                          return (
                            <td key={i} className={cls} style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: i === 2 ? 700 : 400 }}>
                              {fmt(raw)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {m.oos.totalTrades < 50 && (
                <div style={{ color: '#e8b93c', fontSize: 11, fontFamily: 'var(--mono)', marginTop: 6 }}>
                  ⚠ Only {m.oos.totalTrades} out-of-sample trades — too few to trust. Widen the date range or loosen the entry.
                </div>
              )}
            </div>
          )}

          {/* Equity curve */}
          {equityCurve.length > 0 && (
            <div className="card">
              <p className="card-title">Equity Curve {oosStart ? '(dashed line = OOS start)' : ''}</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={equityCurve}>
                  <XAxis dataKey="date" tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} />
                  <YAxis domain={['auto', 'auto']} tick={{ fill: '#555b6a', fontSize: 9 }} tickLine={false} tickFormatter={v => '$' + (v / 1000).toFixed(1) + 'k'} />
                  <Tooltip
                    contentStyle={{ background: '#111318', border: '1px solid #1e222d', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)' }}
                    formatter={v => ['$' + v.toLocaleString(), 'Equity']}
                  />
                  <ReferenceLine y={accountSize} stroke="#1e222d" strokeDasharray="3 3" />
                  {oosStart && <ReferenceLine x={oosStart} stroke="#e8b93c" strokeDasharray="4 4" />}
                  <Line type="monotone" dataKey="equity" stroke="#00d4aa" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Regime breakdown */}
          {m && (
            <div className="two-col">
              <BreakdownCard title="By Daily Trend Regime" data={m.byTrend}
                hint="If UP/DOWN days are red and FLAT is green (or vice versa), tighten the trend/ADX filter." />
              <BreakdownCard title="By Entry Hour (NY)" data={m.byHour}
                hint="If late-morning/afternoon hours bleed, tighten the entry cutoff." />
            </div>
          )}
          {m && (
            <div className="two-col">
              <BreakdownCard title="By Direction" data={m.bySignal}
                hint="If one side bleeds, restrict Direction or use the trend-align filter." />
              <BreakdownCard title="By Day of Week" data={m.byDow}
                hint="If one day is consistently red, exclude it via the DOW mask." />
            </div>
          )}
          {params && (
            <div className="card">
              <p className="card-title">Parameters Used</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 4 }}>
                {Object.entries(params).filter(([k]) => !['symbol', 'dateFrom', 'dateTo', 'sweepId'].includes(k)).map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 10 }}>{k}</span>
                    <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontSize: 10 }}>{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trade log */}
          <div className="card">
            <p className="card-title">Trade Log ({trades.length} trades)</p>
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Time</th><th>Dir</th><th>Entry</th><th>Target</th><th>Stop</th>
                    <th>Exit</th><th>Result</th><th>Bars</th><th>OR%</th><th>Gap%</th><th>Regime</th><th>Sample</th><th>Return %</th><th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.trade_date}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(t.entry_time)}</td>
                      <td><span className={t.signal === 'LONG' ? 'tag-long' : 'tag-short'}>{t.signal}</span></td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.entry_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#00d4aa' }}>{t.target_price?.toFixed(2) ?? '—'}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ff4d6a' }}>{t.stop_price?.toFixed(2)}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.exit_price?.toFixed(2)}</td>
                      <td>
                        <span style={{
                          padding: '2px 6px', borderRadius: 3, fontSize: 10, fontFamily: 'var(--mono)',
                          background: (EXIT_COLORS[t.exit_result] || '#555b6a') + '22',
                          color: EXIT_COLORS[t.exit_result] || '#555b6a',
                        }}>{t.exit_result}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{t.bars_held}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.or_range_pct}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.gap_pct}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>{t.regime_trend}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 10, color: t.sample === 'OOS' ? '#e8b93c' : 'var(--text3)' }}>{t.sample}</td>
                      <td className={t.return_pct >= 0 ? 'tag-long' : 'tag-short'}>
                        {t.return_pct >= 0 ? '+' : ''}{t.return_pct?.toFixed(2)}%
                      </td>
                      <td className={t.pnl_dollars >= 0 ? 'tag-long' : 'tag-short'}>{dollar(t.pnl_dollars)}</td>
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

function BreakdownCard({ title, data, hint }) {
  const rows = Object.entries(data || {});
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th></th><th>Trades</th><th>Win %</th><th>Avg Ret</th><th>P&amp;L</th></tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>{k}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{v.trades}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={v.winRate >= 50 ? 'tag-long' : 'tag-short'}>{r(v.winRate)}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={v.avgReturnPct >= 0 ? 'tag-long' : 'tag-short'}>{pct(v.avgReturnPct)}</td>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }} className={v.totalPnl >= 0 ? 'tag-long' : 'tag-short'}>{dollar(v.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: 'var(--text3)', fontSize: 10, fontFamily: 'var(--mono)', marginTop: 6 }}>{hint}</div>
    </div>
  );
}

// Show only the params that differ across the sweep
function comboLabel(run, sweepRuns) {
  const p = safeParse(run.params) || {};
  const keys = Object.keys(p).filter(k => {
    const vals = new Set(sweepRuns.map(x => JSON.stringify((safeParse(x.params) || {})[k])));
    return vals.size > 1;
  });
  return keys.map(k => `${k}=${p[k]}`).join('  ') || '(base)';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function fmtTime(t) {
  if (t == null) return '—';
  const h = Math.floor(t / 100), m = t % 100;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function buildEquityCurve(trades, startEquity = 100000) {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || (a.entry_time - b.entry_time));
  let equity = startEquity;
  const points = [{ date: sorted[0].trade_date, equity }];
  for (const t of sorted) {
    equity += t.pnl_dollars;
    points.push({ date: t.trade_date, equity: Math.round(equity) });
  }
  return points;
}
