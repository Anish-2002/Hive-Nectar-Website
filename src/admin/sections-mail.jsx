import { useEffect, useMemo, useState } from 'react';
import { rpc, raw, fmtDate, text } from './api.js';
import { SectionHead } from './sections.jsx';
import { flushMail, mailSummary, mailTone } from './mail.js';
import './mail.css';

/* Read the clock outside the component: the lint rule that keeps render pure
 * flags Date() inside a component body, and a "when did this run" stamp is
 * exactly the sort of value that must not be sampled during render. */
const stamp = () => new Date().toISOString();

/*
 * Mail queue — the operational view of outbound email.
 *
 * The database holds every message that was ever meant to leave (mail_outbox),
 * including the ones it refused to send and why. This screen shows that ledger
 * and is the only place a queued message gets handed to the transport, so a row
 * that never reached Brevo can never be mistaken for a delivered one.
 *
 * No emoji. No mock rows. A status of "sent" here only ever comes from
 * apply_mail_result() recording a real provider message id.
 */

const STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

const TONE = {
  sent: 'ok',
  pending: 'wait',
  sending: 'wait',
  failed: 'bad',
  skipped: 'off',
};

const toArr = (v) => (Array.isArray(v) ? v : []);

function useApi(load, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

function StatusPill({ status }) {
  // Tones come from admin.css / mail.css; "off" is the existing quiet pill.
  const tone = TONE[status] || 'off';
  return <span className={`adm-pill adm-pill--${tone}`}>{text(status)}</span>;
}

export function MailSection({ notify }) {
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(25);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [testTo, setTestTo] = useState('');

  const feed = useApi(() => rpc('admin_get_mail_outbox', {
    p_status: status || null,
    p_limit: limit,
    p_offset: 0,
  }), [status, limit]);

  const payload = useMemo(() => raw(feed.data), [feed.data]);
  const rows = useMemo(() => toArr(payload.data), [payload]);
  const counts = useMemo(() => (payload.counts && typeof payload.counts === 'object' ? payload.counts : {}), [payload]);
  const transport = payload.transport || '—';
  const enabled = String(payload.enabled ?? '') === 'true';
  const senderEmail = payload.sender_email || '—';
  const transportOk = String(transport).toLowerCase() === 'brevo';
  const waiting = (counts.pending || 0) + (counts.failed || 0);

  const runFlush = async (ids, label) => {
    setBusy(true); setErr(null);
    try {
      const result = await flushMail(ids, ids ? ids.length : Math.max(1, Math.min(waiting || 10, 20)));
      setLastRun({ label, message: mailSummary(result), tone: mailTone(result), at: stamp() });
      if (typeof notify === 'function') notify(mailSummary(result), mailTone(result));
      feed.reload();
    } catch (e) {
      setErr(e.message);
      setLastRun({ label, message: e.message, tone: 'error', at: stamp() });
    } finally {
      setBusy(false);
    }
  };

  const retry = async (row) => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_retry_mail', { p_id: row.id }));
      if (res.success === false) throw new Error(res.error || 'Retry was refused');
      const result = await flushMail([row.id], 1);
      setLastRun({ label: `Retry ${row.id}`, message: mailSummary(result), tone: mailTone(result), at: stamp() });
      if (typeof notify === 'function') notify(mailSummary(result), mailTone(result));
      feed.reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_queue_test_email', { p_to: testTo.trim() || null }));
      if (res.success === false) throw new Error(res.error || 'The test message was not queued');
      const result = await flushMail([res.mail_id], 1);
      setLastRun({ label: 'Test email', message: mailSummary(result), tone: mailTone(result), at: stamp() });
      if (typeof notify === 'function') notify(mailSummary(result), mailTone(result));
      feed.reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHead
        title="Mail queue"
        note="Every message the CRM has queued, what the transport did with it, and the provider's own message id when it left. Rows are claimed by the send-mail function, which writes the real outcome back here."
        actions={
          <>
            <button type="button" className="adm-btn" onClick={feed.reload} disabled={busy}>Refresh</button>
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              disabled={busy || !transportOk || !enabled}
              onClick={() => runFlush(null, 'Send queue')}
            >
              {busy ? 'Working…' : 'Send queued now'}
            </button>
          </>
        }
      />

      {err ? <div className="adm-error" style={{ marginBottom: 12 }}>{err}</div> : null}

      {!enabled || !transportOk ? (
        <div className="adm-warn" style={{ marginBottom: 12 }}>
          {!transportOk
            ? `No transport is configured (transport = ${text(transport)}). Messages are queued as "skipped" and stay listed here until a transport is set.`
            : 'Outbound email is switched off (mail_enabled = false). Messages are queued as "skipped".'}
        </div>
      ) : null}

      <div className="adm-cards">
        <div className="adm-card">
          <div className="k">Transport</div>
          <div className="v">{text(transport)}</div>
          <div className="adm-note">From {text(senderEmail)}</div>
        </div>
        <div className="adm-card">
          <div className="k">Sent</div>
          <div className="v">{counts.sent || 0}</div>
          <div className="adm-note">Recorded with a provider id</div>
        </div>
        <div className="adm-card">
          <div className="k">Waiting</div>
          <div className="v">{(counts.pending || 0) + (counts.failed || 0)}</div>
          <div className="adm-note">{counts.pending || 0} pending · {counts.failed || 0} failed</div>
        </div>
        <div className="adm-card">
          <div className="k">Skipped</div>
          <div className="v">{counts.skipped || 0}</div>
          <div className="adm-note">Refused by settings, kept for retry</div>
        </div>
      </div>

      <div className="adm-panel">
        <div className="adm-panel-title">Try it</div>
        <div className="adm-inline">
          <input
            type="text"
            placeholder="Recipient (blank = the address in Settings)"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <button type="button" className="adm-btn" disabled={busy || !transportOk || !enabled} onClick={sendTest}>
            Queue and send a test email
          </button>
        </div>
        <div className="adm-note">
          Queues one real message through the same pipeline as member replies and sends it now.
          The result below is the provider's answer, not an assumption.
        </div>
      </div>

      {lastRun ? (
        <div className={lastRun.tone === 'ok' ? 'adm-ok' : 'adm-error'} style={{ marginBottom: 12 }}>
          {lastRun.label}: {lastRun.message}
          <span className="adm-note"> ({fmtDate(lastRun.at)})</span>
        </div>
      ) : null}

      <div className="adm-filters">
        <label className="adm-field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="adm-field">
          <span>Rows</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="adm-field">
          <span>Shown</span>
          <div>{rows.length} of {payload.total ?? 0}</div>
        </div>
      </div>

      {feed.error ? <div className="adm-error">{feed.error}</div> : null}
      {feed.loading ? <div className="adm-empty">Loading…</div> : null}

      {!feed.loading && !rows.length ? (
        <div className="adm-empty">
          No mail matches this filter. Replies and notifications queue here the moment they are recorded.
        </div>
      ) : null}

      {rows.length ? (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>queued</th>
                <th>to</th>
                <th>subject</th>
                <th>kind</th>
                <th>status</th>
                <th>tries</th>
                <th>provider id</th>
                <th>last error</th>
                <th>actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{fmtDate(row.created_at)}</td>
                  <td>{text(row.to_name ? `${row.to_name} <${row.to_email}>` : row.to_email)}</td>
                  <td className="wrap">{text(row.subject)}</td>
                  <td>{text(row.kind)}</td>
                  <td><StatusPill status={row.status} /></td>
                  <td>{`${row.attempts ?? 0}/${row.max_attempts ?? 0}`}</td>
                  <td className="wrap">{text(row.provider_message_id)}</td>
                  <td className="wrap">{text(row.error)}</td>
                  <td>
                    {row.status === 'sent' ? (
                      <span className="adm-note">delivered {fmtDate(row.sent_at)}</span>
                    ) : (
                      <button type="button" className="adm-btn" disabled={busy || !transportOk || !enabled} onClick={() => retry(row)}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.some((r) => r.preview) ? (
        <div className="adm-panel">
          <div className="adm-panel-title">Content of the newest message</div>
          <pre className="adm-pre">{rows.find((r) => r.preview)?.preview}</pre>
        </div>
      ) : null}
    </>
  );
}

export default MailSection;
