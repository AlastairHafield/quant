import React, { useState, useEffect } from 'react';
import { getUniverse, buildUniverse, removeStock } from '../api';

const fmt = (n) => n ? (n / 1e9).toFixed(1) + 'B' : '—';
const fmtVol = (n) => n ? (n / 1e6).toFixed(1) + 'M' : '—';

export default function Universe() {
  const [universe, setUniverse] = useState([]);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await getUniverse();
      setUniverse(res.data || []);
    } catch (e) {
      setStatus({ type: 'error', msg: 'Failed to load universe: ' + e.message });
    } finally {
      setLoading(false);
    }
  }

  async function handleBuild() {
    setBuilding(true);
    setStatus({ type: 'info', msg: 'Building universe from S&P 500. This takes 3–5 minutes due to API rate limits. Check back shortly.' });
    try {
      await buildUniverse();
      setTimeout(() => load(), 5000);
    } catch (e) {
      setStatus({ type: 'error', msg: e.message });
    } finally {
      setBuilding(false);
    }
  }

  async function handleRemove(symbol) {
    setRemoving(symbol);
    try {
      await removeStock(symbol);
      setUniverse(prev => prev.filter(s => s.symbol !== symbol));
    } catch (e) {
      setStatus({ type: 'error', msg: `Failed to remove ${symbol}: ${e.message}` });
    } finally {
      setRemoving(null);
    }
  }

  const sectors = [...new Set(universe.map(s => s.sector))].sort();

  return (
    <div>
      <p className="page-title">Stock Universe</p>

      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Total Stocks</div>
          <div className="metric-value">{universe.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Sectors</div>
          <div className="metric-value">{sectors.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Selection</div>
          <div className="metric-value" style={{ fontSize: 14 }}>Dynamic</div>
        </div>
        <div className="metric">
          <div className="metric-label">Source</div>
          <div className="metric-value" style={{ fontSize: 14 }}>S&amp;P 500</div>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Universe Management</p>
        <p style={{ color: 'var(--text2)', marginBottom: 16, lineHeight: 1.7 }}>
          Universe is built dynamically from the S&amp;P 500, filtered by market cap ≥$10B,
          avg daily volume ≥1M shares. Stocks are ranked by market cap. Rebuild monthly or when you want fresh selection.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={handleBuild} disabled={building}>
            {building && <span className="spinner" />}
            {building ? 'Building...' : 'Build / Refresh Universe'}
          </button>
          <button className="btn" onClick={load} disabled={loading}>
            {loading && <span className="spinner" />}
            Reload
          </button>
        </div>
        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>

      <div className="card">
        <p className="card-title">Current Universe ({universe.length} stocks)</p>
        {universe.length === 0 ? (
          <div className="empty">No stocks loaded. Build universe first.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th>Sector</th>
                  <th>Market Cap</th>
                  <th>Avg Volume</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {universe.map((s, i) => (
                  <tr key={s.symbol}>
                    <td style={{ color: 'var(--text3)' }}>{i + 1}</td>
                    <td style={{ color: 'var(--accent)', fontWeight: 500 }}>{s.symbol}</td>
                    <td style={{ color: 'var(--text)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</td>
                    <td><span className="sector-badge">{s.sector}</span></td>
                    <td>{fmt(s.market_cap)}</td>
                    <td>{fmtVol(s.avg_volume)}</td>
                    <td>
                      <button
                        className="btn-remove"
                        onClick={() => handleRemove(s.symbol)}
                        disabled={removing === s.symbol}
                        title={`Remove ${s.symbol}`}
                      >
                        {removing === s.symbol ? '…' : '×'}
                      </button>
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
