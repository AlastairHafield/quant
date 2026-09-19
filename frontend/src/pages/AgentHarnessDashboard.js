import React, { useState, useEffect, useCallback } from 'react';
import { getAgentHarnessAuditLog, submitAgentHarnessSuggestion, getAgentHarnessSuggestions } from '../api';

// The Phase 5 agent harness's own audit trail — what it watched, proposed,
// graded, promoted, or demoted, and why. Entries with a shared debateId
// (a proposal + the critiques it got — see backend/src/data/agentAuditLog.js)
// are rendered as one thread, oldest first, so a proposal → critique →
// verdict exchange reads the way it actually happened, not as an
// undifferentiated feed. This is a read-only mirror of what already posts to
// Discord (AGENT_HARNESS_DISCORD_WEBHOOK) — nothing here writes anything.

const TYPE_LABEL = { watch: 'Watch', proposal: 'Proposal', grade: 'Grade', promotion: 'Promotion', demotion: 'Demotion', error: 'Error' };
const TYPE_COLOR_VAR = {
  watch: 'var(--text3)',
  proposal: 'var(--accent2)',
  grade: 'var(--yellow)',
  promotion: 'var(--green)',
  demotion: 'var(--yellow)',
  error: 'var(--red)',
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { hour12: false }) : '—');

const STRATEGIES = ['', 'gex-breakout'];

// Free-text box so the user can steer the next scheduled run without
// editing PROTOCOL.md or the code directly — see backend/src/data/
// agentSuggestions.js and PROTOCOL.md's daily-loop step 0.5 (the routine
// reads unread ones via mcp__Quant__suggestions_list at the start of every
// run, then marks each one it actually acted on via suggestions_mark_read).
function SuggestionBox() {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getAgentHarnessSuggestions({ limit: 20 });
      setSuggestions(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitAgentHarnessSuggestion(text);
      setText('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <p className="card-title">Suggest something to the next run</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'e.g. "Check whether the absorption trigger is too loose on trend days" or "Look at Tuesday\'s drift before proposing anything new"'}
          rows={3}
          style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: 8, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || submitting}>
            {submitting ? 'Sending…' : 'Send to agent harness'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            Read by the next scheduled run — not answered here immediately.
          </span>
        </div>
        {error && <div className="status error">{error}</div>}
      </form>

      {suggestions?.length > 0 && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {suggestions.map((s) => (
            <div key={s._id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
              <span
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10, textTransform: 'uppercase',
                  color: s.status === 'new' ? 'var(--accent2)' : 'var(--text3)',
                }}
              >
                {s.status}
              </span>
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(s.createdAt)}</span>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentHarnessDashboard() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [strategy, setStrategy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await getAgentHarnessAuditLog({ strategy: strategy || undefined, limit: 200 });
      setEntries(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [strategy]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div>
        <p className="page-title">Agent Harness</p>
        <SuggestionBox />
        <div className="status error">Failed to load: {error}</div>
      </div>
    );
  }

  if (!entries) {
    return (
      <div>
        <p className="page-title">Agent Harness</p>
        <SuggestionBox />
        <div className="empty"><span className="spinner" /> Loading...</div>
      </div>
    );
  }

  // Entries without a debateId (a "watch"/"error" entry that never
  // originated a proposal — the routine logs these on quiet days) stand
  // alone rather than being forced into a group of one.
  const byDebate = new Map();
  const standalone = [];
  for (const e of entries) {
    if (e.debateId) {
      if (!byDebate.has(e.debateId)) byDebate.set(e.debateId, []);
      byDebate.get(e.debateId).push(e);
    } else {
      standalone.push(e);
    }
  }
  const debates = [...byDebate.values()]
    .map((es) => es.slice().sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt)))
    .sort((a, b) => new Date(b[b.length - 1].loggedAt) - new Date(a[a.length - 1].loggedAt));

  return (
    <div>
      <p className="page-title">Agent Harness — Debate Log</p>

      <SuggestionBox />

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>Strategy:</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '6px 10px' }}
          >
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>{s || 'All'}</option>
            ))}
          </select>
          <button className="btn" onClick={load}>Refresh</button>
        </div>
      </div>

      {debates.length === 0 && standalone.length === 0 && (
        <div className="empty">No audit-log entries yet — the scheduled agent hasn't run.</div>
      )}

      {debates.map((es) => {
        const proposal = es.find((e) => e.type === 'proposal') || es[0];
        return (
          <div className="card" key={proposal.debateId} style={{ marginBottom: 16 }}>
            <p className="card-title">
              {proposal.strategy} — debate {String(proposal.debateId).slice(0, 8)}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {es.map((e) => (
                <div key={e._id} style={{ borderLeft: `3px solid ${TYPE_COLOR_VAR[e.type] || 'var(--text3)'}`, paddingLeft: 10 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>
                    {fmtTime(e.loggedAt)} · {TYPE_LABEL[e.type] || e.type}
                    {e.role ? ` · ${e.role}` : ''}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 2 }}>{e.summary}</div>
                  {e.details && (
                    <pre style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                      {typeof e.details === 'string' ? e.details : JSON.stringify(e.details, null, 1)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {standalone.length > 0 && (
        <div className="card">
          <p className="card-title">Other entries ({standalone.length})</p>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>Time</th><th>Type</th><th>Strategy</th><th>Role</th><th>Summary</th></tr>
              </thead>
              <tbody>
                {standalone.map((e) => (
                  <tr key={e._id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtTime(e.loggedAt)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{TYPE_LABEL[e.type] || e.type}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{e.strategy}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{e.role || '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
