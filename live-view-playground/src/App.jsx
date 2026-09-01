import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserLiveView } from 'bedrock-agentcore/browser/live-view';
import './dcv-quality-shim.js';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

const fmtAge = (ms) => {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// Rough burn estimate: ~0.5 vCPU active blend + ~4 GB peak on AgentCore
// consumption pricing ($0.0895/vCPU-hr + $0.00945/GB-hr).
const estCost = (elapsedMs) => (elapsedMs / 3_600_000) * (0.5 * 0.0895 + 4 * 0.00945);

function StatusDot({ status }) {
  return <span className={`dot ${status === 'READY' ? 'dot-ready' : 'dot-dead'}`} />;
}

// Memoized so the 1s timer tick doesn't re-render the DCV viewer, and
// pointer-events are cut while the agent drives: DCV input is always live
// (take-control only suspends the agent), so a wandering mouse hovers real
// links on the remote page — every hover repaint re-encodes as a flash.
const LiveViewPane = React.memo(function LiveViewPane({ url, width, height, interactive }) {
  return (
    <div className="dcv-host" style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
      <BrowserLiveView signedUrl={url} remoteWidth={width} remoteHeight={height} />
    </div>
  );
});

export default function App() {
  const [ctx, setCtx] = useState(null);
  const [browserId, setBrowserId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null); // sessionId
  const [live, setLive] = useState(null); // { url, automationStreamStatus, createdAt, timeoutSeconds, viewport }
  const [liveError, setLiveError] = useState(null);
  const [navUrl, setNavUrl] = useState('https://example.com');
  const [timeoutChoice, setTimeoutChoice] = useState(900);
  const [taskQ, setTaskQ] = useState('What is the population of Spokane, Washington?');
  const [taskUrl, setTaskUrl] = useState('https://en.wikipedia.org/wiki/Spokane,_Washington');
  const [task, setTask] = useState(null); // { running, result, error, durationMs }
  const attachPollRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [, forceTick] = useState(0); // 1s re-render for timers

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    api('/api/context')
      .then((c) => {
        setCtx(c);
        setBrowserId(c.browsers[0]?.browserId ?? null);
      })
      .catch((e) => flash(`context: ${e.message}`));
  }, []);

  const refreshSessions = useCallback(() => {
    if (!browserId) return;
    api(`/api/sessions?browserId=${encodeURIComponent(browserId)}`)
      .then((r) => setSessions(r.items))
      .catch((e) => flash(`sessions: ${e.message}`));
  }, [browserId]);

  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 5000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  const connect = useCallback(async (sessionId) => {
    setSelected(sessionId);
    setLive(null);
    setLiveError(null);
    try {
      const r = await api(`/api/live-url?browserId=${encodeURIComponent(browserId)}&sessionId=${encodeURIComponent(sessionId)}`);
      setLive(r);
    } catch (e) {
      setLiveError(e.message);
    }
  }, [browserId]);

  const startSession = async () => {
    setBusy(true);
    try {
      const r = await api('/api/sessions', { method: 'POST', body: { browserId, timeoutSeconds: timeoutChoice } });
      refreshSessions();
      // Give the session a beat to come up before grabbing the stream.
      setTimeout(() => connect(r.sessionId), 1500);
    } catch (e) {
      flash(`start: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async (sessionId) => {
    setBusy(true);
    try {
      await api(`/api/sessions?browserId=${encodeURIComponent(browserId)}&sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (selected === sessionId) { setSelected(null); setLive(null); }
      refreshSessions();
    } catch (e) {
      flash(`stop: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const humanControl = live?.automationStreamStatus === 'DISABLED';

  const toggleControl = async () => {
    setBusy(true);
    try {
      const r = await api('/api/control', { method: 'POST', body: { browserId, sessionId: selected, takeControl: !humanControl } });
      setLive((l) => (l ? { ...l, automationStreamStatus: r.automationStreamStatus } : l));
    } catch (e) {
      flash(`control: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const runTask = async () => {
    const startedAt = Date.now();
    setTask({ running: true });
    // Auto-attach the live view to the agent's session the moment it appears.
    const before = new Set(sessions.map((s) => s.sessionId));
    attachPollRef.current = setInterval(async () => {
      try {
        const r = await api(`/api/sessions?browserId=${encodeURIComponent(browserId)}`);
        setSessions(r.items);
        const fresh = r.items.find((s) => s.status === 'READY' && !before.has(s.sessionId));
        if (fresh) {
          clearInterval(attachPollRef.current);
          attachPollRef.current = null;
          connect(fresh.sessionId);
        }
      } catch { /* keep polling */ }
    }, 2000);
    try {
      const result = await api('/api/task', { method: 'POST', body: { question: taskQ, url: taskUrl } });
      setTask({ running: false, result, durationMs: Date.now() - startedAt });
    } catch (e) {
      setTask({ running: false, error: e.message, durationMs: Date.now() - startedAt });
    } finally {
      if (attachPollRef.current) { clearInterval(attachPollRef.current); attachPollRef.current = null; }
      refreshSessions();
    }
  };

  const doNavigate = async () => {
    setBusy(true);
    try {
      await api('/api/navigate', { method: 'POST', body: { browserId, sessionId: selected, url: navUrl } });
      flash(`agent navigated to ${navUrl}`);
    } catch (e) {
      flash(`navigate: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const elapsed = live?.createdAt ? Date.now() - new Date(live.createdAt).getTime() : 0;
  const ttlLeft = live?.createdAt && live?.timeoutSeconds
    ? new Date(live.createdAt).getTime() + live.timeoutSeconds * 1000 - Date.now()
    : null;
  const ttlFrac = ttlLeft !== null && live?.timeoutSeconds ? Math.max(0, ttlLeft / (live.timeoutSeconds * 1000)) : null;
  const viewport = live?.viewport ?? ctx?.viewport ?? { width: 1456, height: 819 };

  const selectedMeta = useMemo(() => sessions.find((s) => s.sessionId === selected), [sessions, selected]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Browser Ops <span className="sub">AgentCore live view playground</span></div>
        <div className="topbar-right">
          {ctx && (
            <select value={browserId ?? ''} onChange={(e) => { setBrowserId(e.target.value); setSelected(null); setLive(null); }}>
              {ctx.browsers.map((b) => <option key={b.browserId} value={b.browserId}>{b.name}</option>)}
            </select>
          )}
          <span className="region">{ctx?.region ?? '…'}</span>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <div className="rail-head">
            <span>Sessions</span>
            <button className="ghost" onClick={refreshSessions}>↻</button>
          </div>

          <div className="new-session">
            <select value={timeoutChoice} onChange={(e) => setTimeoutChoice(Number(e.target.value))}>
              <option value={300}>TTL 5 min</option>
              <option value={900}>TTL 15 min</option>
              <option value={3600}>TTL 1 hour</option>
              <option value={28800}>TTL 8 hours (max)</option>
            </select>
            <button className="primary" disabled={busy || !browserId} onClick={startSession}>New session</button>
          </div>

          <div className="session-list">
            {sessions.length === 0 && <div className="empty-note">No sessions. Start one, or run a back-office task and watch it appear.</div>}
            {sessions.map((s) => (
              <div key={s.sessionId} className={`session-card ${selected === s.sessionId ? 'sel' : ''} ${s.status !== 'READY' ? 'dead' : ''}`}
                   onClick={() => s.status === 'READY' && connect(s.sessionId)}>
                <div className="session-row1">
                  <StatusDot status={s.status} />
                  <span className="session-name">{s.name ?? 'unnamed'}</span>
                  {s.status === 'READY' && (
                    <button className="ghost danger" title="Stop session" onClick={(e) => { e.stopPropagation(); stopSession(s.sessionId); }}>■</button>
                  )}
                </div>
                <div className="session-row2">
                  <code>{s.sessionId?.slice(0, 12)}…</code>
                  <span>{s.createdAt ? fmtAge(Date.now() - new Date(s.createdAt).getTime()) : ''} old</span>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className="stage">
          <section className="task-card">
            <div className="task-head">Agent task <span className="sub">InvokeAgentRuntime → back-office → gpt-5-mini</span></div>
            <div className="task-form">
              <input value={taskQ} onChange={(e) => setTaskQ(e.target.value)} placeholder="question" />
              <input value={taskUrl} onChange={(e) => setTaskUrl(e.target.value)} placeholder="https://…" />
              <button className="primary" disabled={task?.running || !browserId} onClick={runTask}>
                {task?.running ? 'Running…' : 'Run task'}
              </button>
            </div>
            {task?.running && <div className="task-status">Invoking the runtime — its browser session will appear in the sidebar and auto-attach. First run can take ~30s (cold microVM).</div>}
            {task?.error && <div className="task-status err">Task failed: {task.error}</div>}
            {task?.result && (
              <div className="task-result">
                <div className="task-answer">{task.result.answer}</div>
                <div className="task-meta">{task.result.title} · {(task.durationMs / 1000).toFixed(1)}s end to end</div>
              </div>
            )}
          </section>

          {!selected && (
            <div className="placeholder">
              <div className="placeholder-title">No session connected</div>
              <div>Pick a READY session on the left, start one, or run an agent task above.</div>
            </div>
          )}

          {selected && (
            <>
              <div className="stage-head">
                <div className="stage-title">
                  <StatusDot status={selectedMeta?.status ?? live?.sessionStatus ?? 'READY'} />
                  <code>{selected}</code>
                  <span className={`pill ${humanControl ? 'pill-human' : 'pill-agent'}`}>
                    {humanControl ? 'HUMAN CONTROL' : 'AGENT DRIVING'}
                  </span>
                </div>
                <div className="stage-stats">
                  <span title="Session age">⏱ {fmtAge(elapsed)}</span>
                  {ttlLeft !== null && (
                    <span title="Time until the hard TTL kills this session" className={ttlLeft < 60_000 ? 'ttl-low' : ''}>
                      TTL {fmtAge(ttlLeft)}
                    </span>
                  )}
                  <span title="Very rough consumption estimate (0.5 vCPU + 4 GB blend)">~${estCost(elapsed).toFixed(4)}</span>
                </div>
              </div>

              {ttlFrac !== null && (
                <div className="ttl-bar"><div className="ttl-fill" style={{ width: `${ttlFrac * 100}%` }} /></div>
              )}

              <div className="controls">
                <button className={humanControl ? 'warn' : 'primary'} disabled={busy || !live} onClick={toggleControl}>
                  {humanControl ? 'Hand back to agent' : 'Take control'}
                </button>
                <div className="nav-group">
                  <input value={navUrl} onChange={(e) => setNavUrl(e.target.value)} placeholder="https://…"
                         onKeyDown={(e) => e.key === 'Enter' && doNavigate()} />
                  <button disabled={busy || !live || humanControl} title={humanControl ? 'Agent stream is suspended while you have control' : 'Drive the browser over CDP, like the agent does'} onClick={doNavigate}>
                    Agent: go
                  </button>
                </div>
                <button className="ghost" disabled={busy} onClick={() => connect(selected)} title="Mint a fresh presigned URL and reconnect">Reconnect</button>
                <button className="ghost danger" disabled={busy} onClick={() => stopSession(selected)}>Stop session</button>
              </div>

              <div className="viewport" style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}>
                {liveError && <div className="placeholder"><div className="placeholder-title">Live view failed</div><div>{liveError}</div></div>}
                {!live && !liveError && <div className="placeholder">Connecting…</div>}
                {live && (
                  <LiveViewPane
                    key={live.url}
                    url={live.url}
                    width={viewport.width}
                    height={viewport.height}
                    interactive={humanControl}
                  />
                )}
                {humanControl
                  ? <div className="control-banner">You have the wheel — automation stream suspended</div>
                  : live && <div className="viewonly-chip">view-only — Take control to interact</div>}
              </div>
            </>
          )}
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}

      <footer className="foot">
        Billing is consumption-based: active vCPU + peak memory over session lifetime. The TTL (<code>sessionTimeoutSeconds</code>)
        is a hard cap — max 8h — the session dies then even mid-task.
      </footer>
    </div>
  );
}
