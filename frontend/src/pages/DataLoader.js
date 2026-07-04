import React, { useState, useEffect } from 'react';
import { loadData, getSignals, getUniverse } from '../api';

export default function DataLoader() {
  const [dateFrom, setDateFrom] = useState('2018-01-01');
  const [dateTo, setDateTo] = useState('2024-12-31');
  const [loading, setLoading] = useState(false);
  const [signals, setSignals] = useState([]);
  const [status, setStatus] = useState(null);
  const [universeSize, setUniverseSize] = useState(0);

  useEffect(() => {
    getUniverse().then(r => setUniverseSize(r.count || 0));
    fetchSignals();
  }, []);

  async function fetchSignals() {
    try {
      const res = await getSignals({ dateFrom, dateTo });
      setSignals(res.data || []);
    } catch (e) {}
  }

  async function handleLoad() {
    if (universeSize === 0) {
      setStatus({ type: 'error', msg: 'Build universe first (Universe tab).' });
      return;
    }
    setLoading(true);
    setStatus({ type: 'info', msg: `Fetching earnings data for ${universeSize} stocks from ${dateFrom} to ${dateTo}. This runs in background and will take 10–20 minutes. Signals will appear below as they load.` });
    try {
      await loadData({ dateFrom, dateTo });
      // Poll for signals
      const poll = setInterval(async () => {
        const res = await getSignals({ dateFrom, dateTo });
        setSignals(res.data || []);
      }, 10000);
      setTimeout(() => {
        clearInterval(poll);
        setStatus({ type: 'success', msg: 'Data load complete.' });
        setLoading(false);
        fetchSignals();
      }, 25 * 60 * 1000);
    } catch (e) {
      setStatus({ type: 'error', msg: e.message });
      setLoading(false);
    }
  }

  const longCount = signals.filter(s => s.signal === 'LONG').length;
  const shortCount = signals.filter(s => s.signal === 'SHORT').length;

  return (
    <div>
      <p className="page-title">Data Load</p>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Concordant Signals</div>
          <div className="metric-value">{signals.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Long Signals</div>
          <div className="metric-value pos">{longCount}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Short Signals</div>
          <div className="metric-value neg">{shortCount}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Universe</div>
          <div className="metric-value">{universeSize}</div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Load Earnings Data</p>
        <p style={{ color: 'var(--text2)', marginBottom: 16, lineHeight: 1.7 }}>
          Fetches historical earnings (actual vs consensus EPS) and price data for every stock in the universe.
          Applies the concordant filter: surprise direction must match price reaction direction.
          Data is cached locally — reloading the same range won't re-fetch.
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
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={handleLoad} disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? 'Loading...' : 'Load Data'}
          </button>
          <button className="btn" onClick={fetchSignals}>Refresh Signals</button>
        </div>
        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>

      <div className="card">
        <p className="card-title">Concordant Signals ({signals.length})</p>
        {signals.length === 0 ? (
          <div className="empty">No signals loaded. Run data load first.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Report Date</th>
                  <th>Actual EPS</th>
                  <th>Est EPS</th>
                  <th>Surprise %</th>
                  <th>Reaction %</th>
                  <th>Signal</th>
                  <th>Entry Date</th>
                </tr>
              </thead>
              <tbody>
                {signals.map(s => (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--accent)' }}>{s.symbol}</td>
                    <td>{s.report_date}</td>
                    <td>{s.actual_eps?.toFixed(2)}</td>
                    <td>{s.estimated_eps?.toFixed(2)}</td>
                    <td className={s.surprise_pct >= 0 ? 'tag-long' : 'tag-short'}>
                      {s.surprise_pct >= 0 ? '+' : ''}{s.surprise_pct?.toFixed(1)}%
                    </td>
                    <td className={s.reaction_pct >= 0 ? 'tag-long' : 'tag-short'}>
                      {s.reaction_pct >= 0 ? '+' : ''}{s.reaction_pct?.toFixed(1)}%
                    </td>
                    <td><span className={s.signal === 'LONG' ? 'tag-long' : 'tag-short'}>{s.signal}</span></td>
                    <td>{s.reaction_day}</td>
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
