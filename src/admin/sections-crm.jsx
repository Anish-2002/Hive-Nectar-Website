import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rpc, raw, cleanPayload, fmtDate, text } from './api.js';
import { SectionHead, RawTable } from './sections.jsx';

/*
 * CRM modules for the Hive Nectar admin surface.
 *
 * Every read and write below goes through an admin_* RPC; nothing here touches a
 * table directly. The shapes are taken from the live function bodies in
 * information/admin-crm/sql/2026-10-13-11-crm-modules-part*.sql:
 *   - list endpoints return { success, rows: [...] } (some add counts / totals)
 *   - a refused call makes rpc() throw with the server's own error string, which
 *     is what gets shown — never a fabricated success.
 *
 * EMAIL IS NOT WIRED YET. Reply / notification RPCs return delivery_status
 * 'not_configured' with delivered:false. That is rendered honestly: the UI never
 * says an email was sent when the transport is absent.
 *
 * No emoji. No mock data. No alert()/prompt()/confirm(): every confirmation is an
 * inline two-step control so it can never be dismissed blindly.
 */

/* ───────────────────────────── small shared pieces ───────────────────────────── */

const REVIEW_STATUSES = ['new', 'in_review', 'needs_clarification', 'reviewed', 'flagged'];
const REVIEW_SOURCES = ['task_reflection', 'sigma_log'];
const TICKET_STATUSES = ['new', 'open', 'pending_customer', 'pending_internal', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RECOG_STATUSES = ['nominated', 'approved', 'awaiting_acceptance', 'awaiting_address',
  'ready_to_pack', 'packed', 'shipped', 'delivered', 'completed', 'rejected', 'declined',
  'cancelled', 'delivery_failed'];
const NECTAR_CATEGORIES = ['adjustment', 'correction', 'recognition', 'task', 'milestone', 'token', 'reversal'];
// Kinds the manual adjust RPC accepts (initial / allocation are written internally).
const STOCK_KINDS = ['restock', 'correction', 'return'];

// Forward fulfilment ranks, mirrored from admin_advance_recognition so the panel
// only ever offers a move the server will accept.
const RANK = {
  approved: 1, awaiting_acceptance: 1, awaiting_address: 2, ready_to_pack: 3,
  packed: 4, shipped: 5, delivered: 6, completed: 7,
};
const FORWARD_ORDER = ['awaiting_acceptance', 'awaiting_address', 'ready_to_pack',
  'packed', 'shipped', 'delivered', 'completed'];
const ADDRESS_TARGETS = ['ready_to_pack', 'packed', 'shipped', 'delivered', 'completed'];
const TERMINAL_TARGETS = ['cancelled', 'declined', 'delivery_failed'];

function forwardTargets(status) {
  const r = RANK[status];
  if (r === undefined) return [];
  return FORWARD_ORDER.filter((s) => RANK[s] > r);
}
function terminalTargets(status) {
  const r = RANK[status];
  const out = [];
  if (status === 'awaiting_acceptance') out.push('declined');
  if (r !== undefined && r < 4) out.push('cancelled');
  if (r === 4 || r === 5) out.push('delivery_failed');
  return out;
}

const toArr = (v) => (Array.isArray(v) ? v : []);
const money = (v) => (v === null || v === undefined || v === '') ? '—'
  : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whoName = (o) => (o && (o.name || [o.first_name, o.last_name].filter(Boolean).join(' ') || o.username || o.email)) || '—';

/** Honest one-line description of a delivery/email status. Never implies a send. */
function deliveryLabel(status) {
  switch (status) {
    case 'sent': return 'sent';
    case 'queued': return 'queued — not sent yet (no worker has picked it up)';
    case 'not_configured': return 'NOT emailed — no mail transport is configured; stored in-app only';
    case 'not_attempted': return 'not attempted (internal note, never emailed)';
    case 'failed': return 'failed';
    case 'bounced': return 'bounced';
    case 'stored_only': return 'stored in-app only';
    case undefined: case null: case '': return 'unknown';
    default: return String(status);
  }
}
function deliveryKind(status) {
  if (status === 'sent') return 'adm-pill adm-pill--ok';
  if (status === 'not_configured' || status === 'failed' || status === 'bounced') return 'adm-pill adm-pill--off';
  return 'adm-pill';
}

function useApi(load, deps = [], enabled = true) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  const depKey = JSON.stringify(deps);
  useLayoutEffect(() => { loadRef.current = load; });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    loadRef.current()
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: (e && e.message) || String(e) }); });
    return () => { alive = false; };
  }, [depKey, nonce, enabled]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return enabled ? { ...state, reload } : { loading: false, data: null, error: null, reload };
}

function Field({ label, children, wide }) {
  return (
    <div className={`adm-field${wide ? ' adm-field--wide' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  );
}

function opts(list, blank) {
  return (
    <>
      {blank ? <option value="">{blank}</option> : null}
      {list.map((s) => <option key={s} value={s}>{s}</option>)}
    </>
  );
}

function Drawer({ title, note, onClose, children }) {
  return (
    <div className="adm-drawer">
      <div className="adm-head">
        <div>
          <h2>{title}</h2>
          {note ? <p>{note}</p> : null}
        </div>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={onClose}>Close</button>
        </div>
      </div>
      {children}
    </div>
  );
}

function CountsBar({ counts, note }) {
  const entries = Object.entries(counts || {});
  return (
    <div className="adm-filters">
      {entries.map(([k, v]) => (
        <span key={k} className="adm-pill">{k.replace(/_/g, ' ')}: {text(v)}</span>
      ))}
      {note ? <span className="adm-note">{note}</span> : null}
    </div>
  );
}

function Pager({ offset, limit, total, onPrev, onNext }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="adm-filters">
      <button type="button" className="adm-btn adm-btn--small" onClick={onPrev} disabled={offset <= 0}>Previous</button>
      <span className="adm-note">Showing {from}–{to} of {total}</span>
      <button type="button" className="adm-btn adm-btn--small" onClick={onNext} disabled={offset + limit >= total}>Next</button>
    </div>
  );
}

/* ───────────────────────────── 1. Review Centre ───────────────────────────── */

export function ReviewCentreSection({ notify }) {
  const PAGE = 50;
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const queue = useApi(
    () => rpc('admin_get_review_queue', {
      p_status: status || null, p_source: source || null, p_search: search || null,
      p_limit: PAGE, p_offset: offset,
    }),
    [status, source, search, offset],
  );
  const payload = useMemo(() => raw(queue.data), [queue.data]);
  const list = useMemo(() => toArr(payload.rows), [payload]);
  const counts = useMemo(() => payload.counts || {}, [payload]);
  const total = Number(counts.total || 0);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = raw(await rpc('admin_sync_review_queue', {}));
      notify(`Queue synced — queued now: ${res.queued_now ?? 0}, in queue: ${res.total_in_queue ?? 0}`, 'ok');
      queue.reload();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <SectionHead
        title="Review centre"
        note="Member submissions (task reflections and standalone sigma logs) pulled into a queue. Sync imports new submissions idempotently; nothing is copied out of the source tables."
        actions={
          <>
            <button type="button" className="adm-btn" onClick={queue.reload}>Refresh</button>
            <button type="button" className="adm-btn adm-btn--primary" onClick={runSync} disabled={syncing}>
              {syncing ? 'Syncing' : 'Sync queue'}
            </button>
          </>
        }
      />
      {queue.error ? <div className="adm-error">{queue.error}</div> : null}
      <CountsBar counts={counts} note={`pending submissions: ${text(payload.pending_submissions ?? 0)}`} />
      <div className="adm-filters">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          {opts(REVIEW_STATUSES, 'All statuses')}
        </select>
        <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }}>
          {opts(REVIEW_SOURCES, 'All sources')}
        </select>
        <input value={searchInput} placeholder="Search name, email, username"
               onChange={(e) => setSearchInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(searchInput); setOffset(0); } }} />
        <button type="button" className="adm-btn" onClick={() => { setSearch(searchInput); setOffset(0); }}>Search</button>
        <button type="button" className="adm-btn" onClick={() => { setSearchInput(''); setSearch(''); setStatus(''); setSource(''); setOffset(0); }}>Clear</button>
      </div>
      {queue.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['created_at', 'member_name', 'member_email', 'source', 'status', 'assignee_name', 'excerpt']}
          empty="No submissions in the queue. Run Sync queue to import any waiting."
          onRowClick={(r) => setOpenId(r.id)}
        />
      )}
      <Pager offset={offset} limit={PAGE} total={total}
             onPrev={() => setOffset((o) => Math.max(0, o - PAGE))}
             onNext={() => setOffset((o) => o + PAGE)} />
      {openId ? (
        <ReviewDetail id={openId} notify={notify}
                      onClose={() => setOpenId(null)}
                      onChanged={() => queue.reload()} />
      ) : null}
    </>
  );
}

function ReviewDetail({ id, notify, onClose, onChanged }) {
  const item = useApi(() => rpc('admin_get_review_item', { p_id: id }), [id]);
  const ctx = useApi(() => rpc('admin_get_my_context'), []);
  const team = useApi(() => rpc('admin_get_team_overview'), []);
  const p = useMemo(() => raw(item.data), [item.data]);
  const review = p.review || {};
  const member = p.member || {};
  const task = p.task || {};
  const sub = p.submission || {};
  const history = useMemo(() => (Array.isArray(p.history) ? p.history : toArr(p.events)), [p]);
  const meId = raw(ctx.data).user_id || null;
  const admins = useMemo(() => {
    if (team.error || !team.data) return null;
    const members = toArr(raw(team.data).members);
    return members.map((m) => ({ id: m.user_id, label: whoName(m) + (m.email ? ` — ${m.email}` : '') }));
  }, [team.data, team.error]);

  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState(review.internal_notes || '');
  const [status, setStatus] = useState(review.status || 'new');
  const [reason, setReason] = useState('');
  const [reply, setReply] = useState('');
  const [channel, setChannel] = useState('in_app');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [delivery, setDelivery] = useState(null);

  const refresh = () => { item.reload(); if (onChanged) onChanged(); };

  const doAssign = async (userId, why) => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_assign_review', { p_id: id, p_assignee: userId || null, p_reason: why || null }));
      notify(`Assigned (status ${res.status || ''})`, 'ok');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doStatus = async () => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_set_review_status', {
        p_id: id, p_status: status, p_note: note || null, p_reason: reason || null,
      }));
      notify(`Status set to ${res.status || status}`, 'ok');
      setReason('');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const doReply = async () => {
    setBusy(true); setErr(null); setDelivery(null);
    try {
      const res = raw(await rpc('admin_reply_to_member', { p_id: id, p_body: reply, p_channel: channel }));
      setDelivery(res.delivery_status || res.email_status || null);
      notify('Reply recorded', 'ok');
      setReply('');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Drawer title={`Review — ${whoName(member)}`} note={`Source ${text(review.source)} · status ${text(review.status)}`} onClose={onClose}>
      {item.error ? <div className="adm-error">{item.error}</div> : null}
      {err ? <div className="adm-error" style={{ marginBottom: 12 }}>{err}</div> : null}
      {item.loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <div className="adm-panel">
            <div className="adm-panel-title">Member</div>
            <p className="adm-note">{whoName(member)} · {text(member.email)} · {text(member.username)} · tier {text(member.member_tier)}</p>
            <p className="adm-note">Nectar {text(member.nectar_points)} · status {text(member.member_status)}</p>
            <p className="adm-note">Current assignee: {text(p.assignee_name)} · reviewed {fmtDate(review.reviewed_at)}</p>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Task</div>
            <p className="adm-note">{task.id ? `${text(task.title)} · theme ${text(task.theme_id)} · stage ${text(task.stage)} · reward ${text(task.nectar_reward)}` : 'Standalone log (no task).'}</p>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Submission</div>
            {sub && Object.keys(sub).length ? (
              <>
                <p className="adm-note">Submitted {fmtDate(sub.created_at)}</p>
                {['define', 'measure', 'analysis', 'improve', 'control'].map((k) => (
                  <div key={k} style={{ marginTop: 8 }}>
                    <div className="adm-panel-title" style={{ margin: '8px 0 2px' }}>{k}</div>
                    <p className="adm-note" style={{ whiteSpace: 'pre-wrap' }}>{text(sub[k])}</p>
                  </div>
                ))}
              </>
            ) : <p className="adm-note">No submission body found for this source.</p>}
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Assign</div>
            <div className="adm-form">
              <Field label="assignee">
                {admins ? (
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="">— none / unassign —</option>
                    {admins.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                ) : (
                  <input value={assignee} placeholder="administrator uuid (team list unavailable)"
                         onChange={(e) => setAssignee(e.target.value)} />
                )}
              </Field>
            </div>
            {!admins ? <p className="adm-note">The team list could not be read, so paste an administrator's user id.</p> : null}
            <div className="adm-actions" style={{ marginTop: 10 }}>
              <button type="button" className="adm-btn" disabled={busy || !meId} onClick={() => doAssign(meId, 'Assigned to me')}>Assign to me</button>
              <button type="button" className="adm-btn" disabled={busy || (!assignee && admins)} onClick={() => doAssign(assignee, 'Assigned')}>Assign selected</button>
              <button type="button" className="adm-btn" disabled={busy} onClick={() => doAssign(null, 'Unassigned')}>Unassign</button>
            </div>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Status</div>
            <div className="adm-form">
              <Field label="status">
                <select value={status} onChange={(e) => setStatus(e.target.value)}>{opts(REVIEW_STATUSES)}</select>
              </Field>
              <Field label="internal note" wide>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              {status === 'flagged' ? (
                <Field label="flag reason (required)" wide>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              ) : null}
            </div>
            <div className="adm-actions" style={{ marginTop: 10 }}>
              <button type="button" className="adm-btn adm-btn--primary" onClick={doStatus} disabled={busy}>{busy ? 'Working' : 'Set status'}</button>
            </div>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Reply to member</div>
            <div className="adm-form">
              <Field label="channel">
                <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="in_app">in_app</option>
                  <option value="email">email</option>
                </select>
              </Field>
              <Field label="message" wide>
                <textarea value={reply} onChange={(e) => setReply(e.target.value)} />
              </Field>
            </div>
            {delivery ? (
              <p className="adm-note" style={{ marginTop: 10 }}>
                Delivery: <span className={deliveryKind(delivery)}>{deliveryLabel(delivery)}</span>
              </p>
            ) : null}
            <div className="adm-actions" style={{ marginTop: 10 }}>
              <button type="button" className="adm-btn adm-btn--primary" onClick={doReply} disabled={busy || !reply.trim()}>Record reply</button>
            </div>
          </div>

          {toArr(p.open_recognitions).length ? (
            <div className="adm-panel">
              <div className="adm-panel-title">Open recognitions for this member</div>
              {toArr(p.open_recognitions).map((r) => (
                <p className="adm-note" key={r.id}>{text(r.gift_name)} · {text(r.status)} · {fmtDate(r.created_at)}</p>
              ))}
            </div>
          ) : null}

          <div className="adm-panel">
            <div className="adm-panel-title">History</div>
            {history.length ? (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>when</th><th>kind</th><th>change</th><th>by</th><th>body</th></tr></thead>
                  <tbody>
                    {history.map((ev, i) => (
                      <tr key={`${ev.created_at}-${i}`}>
                        <td>{fmtDate(ev.created_at)}</td>
                        <td>{text(ev.kind)}</td>
                        <td>{text(ev.from_status)} to {text(ev.to_status)}</td>
                        <td>{text(ev.actor_name || ev.actor_email)}</td>
                        <td className="wrap">{text(ev.body)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="adm-note">No history yet.</p>}
          </div>
        </>
      )}
    </Drawer>
  );
}

/* ───────────────────────────── 2. Recognition & gifts ───────────────────────────── */

export function RecognitionSection({ notify }) {
  const PAGE = 50;
  const [tab, setTab] = useState('awards');
  const [awardStatus, setAwardStatus] = useState('');
  const [awardSearch, setAwardSearch] = useState('');
  const [awardQuery, setAwardQuery] = useState('');
  const [awardOffset, setAwardOffset] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [giftSearch, setGiftSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(true);
  const [movementsFor, setMovementsFor] = useState(null);

  const dash = useApi(() => rpc('admin_get_recognition_dashboard'), []);
  const dashData = useMemo(() => raw(dash.data), [dash.data]);
  const awards = useApi(
    () => rpc('admin_get_recognitions', {
      p_status: awardStatus || null, p_search: awardQuery || null, p_limit: PAGE, p_offset: awardOffset,
    }),
    [awardStatus, awardQuery, awardOffset],
  );
  const awardsData = useMemo(() => raw(awards.data), [awards.data]);
  const awardRows = useMemo(() => toArr(awardsData.rows), [awardsData]);
  const awardCounts = useMemo(() => awardsData.counts || {}, [awardsData]);
  const gifts = useApi(
    () => rpc('admin_get_gifts', { p_search: giftSearch || null, p_include_inactive: includeInactive }),
    [giftSearch, includeInactive],
  );
  const giftRows = useMemo(() => toArr(raw(gifts.data).rows), [gifts.data]);

  const refreshAll = () => { dash.reload(); awards.reload(); gifts.reload(); };

  return (
    <>
      <SectionHead
        title="Recognition & gifts"
        note="Nominate a member for a physical gift and move the award through fulfilment. Stock is allocated at the ready-to-pack step, which is the commit point."
        actions={<button type="button" className="adm-btn" onClick={refreshAll}>Refresh</button>}
      />
      {dash.error ? <div className="adm-error">{dash.error}</div> : null}

      <div className="adm-panel">
        <div className="adm-panel-title">Dashboard</div>
        <div className="adm-cards">
          {Object.entries(dashData.counts || {}).map(([k, v]) => (
            <div className="adm-card" key={k}><div className="k">{k.replace(/_/g, ' ')}</div><div className="v">{text(v)}</div></div>
          ))}
          <div className="adm-card"><div className="k">spend committed</div><div className="v">{money((dashData.spend || {}).committed)}</div></div>
          <div className="adm-card"><div className="k">spend delivered</div><div className="v">{money((dashData.spend || {}).delivered)}</div></div>
          <div className="adm-card"><div className="k">awarded count</div><div className="v">{text((dashData.spend || {}).awarded_count)}</div></div>
        </div>
        <div className="adm-split">
          <div>
            <h4 className="adm-panel-title">Low stock</h4>
            <RawTable list={toArr(dashData.low_stock)} columns={['name', 'sku', 'stock_quantity', 'unit_cost', 'is_active']} empty="No low-stock gifts." />
          </div>
          <div>
            <h4 className="adm-panel-title">Needs action</h4>
            {toArr(dashData.needs_action).length ? (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>status</th><th>member</th><th>gift</th><th>created</th><th /></tr></thead>
                  <tbody>
                    {toArr(dashData.needs_action).map((r) => (
                      <tr key={r.id}>
                        <td>{text(r.status)}</td>
                        <td>{text(r.member_name || r.member_email)}</td>
                        <td>{text(r.gift_name)}</td>
                        <td>{fmtDate(r.created_at)}</td>
                        <td><button type="button" className="adm-btn adm-btn--small" onClick={() => setOpenId(r.id)}>Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="adm-empty">Nothing needs action.</div>}
          </div>
        </div>
      </div>

      <div className="adm-filters">
        <button type="button" className={tab === 'awards' ? 'adm-btn adm-btn--primary' : 'adm-btn'} onClick={() => setTab('awards')}>Awards</button>
        <button type="button" className={tab === 'gifts' ? 'adm-btn adm-btn--primary' : 'adm-btn'} onClick={() => setTab('gifts')}>Gift catalogue</button>
      </div>

      {tab === 'awards' ? (
        <>
          <NominateForm notify={notify} gifts={giftRows} onDone={() => { awards.reload(); dash.reload(); }} />
          <CountsBar counts={awardCounts} />
          <div className="adm-filters">
            <select value={awardStatus} onChange={(e) => { setAwardStatus(e.target.value); setAwardOffset(0); }}>
              {opts(RECOG_STATUSES, 'All statuses')}
            </select>
            <input value={awardSearch} placeholder="Search member or gift"
                   onChange={(e) => setAwardSearch(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') { setAwardQuery(awardSearch); setAwardOffset(0); } }} />
            <button type="button" className="adm-btn" onClick={() => { setAwardQuery(awardSearch); setAwardOffset(0); }}>Search</button>
            <button type="button" className="adm-btn" onClick={() => { setAwardSearch(''); setAwardQuery(''); setAwardStatus(''); setAwardOffset(0); }}>Clear</button>
          </div>
          {awards.error ? <div className="adm-error">{awards.error}</div> : null}
          {awards.loading ? <div className="adm-empty">Loading…</div> : (
            <RawTable
              list={awardRows}
              columns={['created_at', 'member_name', 'member_email', 'gift_name', 'status', 'carrier', 'tracking_number', 'has_address']}
              empty="No awards yet."
              onRowClick={(r) => setOpenId(r.id)}
            />
          )}
          <Pager offset={awardOffset} limit={PAGE} total={Number(awardCounts.total || 0)}
                 onPrev={() => setAwardOffset((o) => Math.max(0, o - PAGE))}
                 onNext={() => setAwardOffset((o) => o + PAGE)} />
        </>
      ) : (
        <>
          <GiftForm notify={notify} onDone={() => { gifts.reload(); dash.reload(); }} />
          <div className="adm-filters">
            <input value={giftSearch} placeholder="Search name or sku" onChange={(e) => setGiftSearch(e.target.value)} />
            <label className="adm-note">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> include inactive
            </label>
          </div>
          {gifts.error ? <div className="adm-error">{gifts.error}</div> : null}
          {gifts.loading ? <div className="adm-empty">Loading…</div> : (
            <RawTable
              list={giftRows}
              columns={['name', 'sku', 'stock_quantity', 'unit_cost', 'eligibility', 'allocated', 'open_awards', 'is_active']}
              empty="No gifts in the catalogue."
            />
          )}
          {giftRows.map((g) => (
            <div className="adm-panel" key={g.id}>
              <div className="adm-panel-title">{g.name} · stock {text(g.stock_quantity)}</div>
              <div className="adm-filters" style={{ marginBottom: 8 }}>
                <button type="button" className="adm-btn adm-btn--small"
                        onClick={async () => {
                          try { await rpc('admin_set_gift_active', { p_id: g.id, p_is_active: !g.is_active }); notify('Gift updated', 'ok'); gifts.reload(); }
                          catch (e) { notify(e.message, 'error'); }
                        }}>
                  {g.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button type="button" className="adm-btn adm-btn--small"
                        onClick={() => setMovementsFor(g.id === movementsFor ? null : g.id)}>
                  {g.id === movementsFor ? 'Hide movements' : 'Stock movements'}
                </button>
              </div>
              <StockAdjust gift={g} notify={notify} onDone={() => { gifts.reload(); dash.reload(); }} />
              {g.id === movementsFor ? <MovementsPanel giftId={g.id} /> : null}
            </div>
          ))}
        </>
      )}

      {openId ? (
        <RecognitionDetail id={openId} notify={notify}
                           onClose={() => setOpenId(null)}
                           onChanged={() => { awards.reload(); dash.reload(); }} />
      ) : null}
    </>
  );
}

function GiftForm({ notify, onDone }) {
  const [values, setValues] = useState({
    name: '', sku: '', description: '', image_url: '', stock_quantity: '0', unit_cost: '', eligibility: '', is_active: true,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const gift = { ...cleanPayload(values), stock_quantity: Number(values.stock_quantity || 0), is_active: !!values.is_active };
      await rpc('admin_save_gift', { p_gift: gift });
      notify('Gift saved', 'ok');
      setValues({ name: '', sku: '', description: '', image_url: '', stock_quantity: '0', unit_cost: '', eligibility: '', is_active: true });
      setOpen(false);
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="adm-panel">
      <div className="adm-head">
        <div><div className="adm-panel-title">Add a gift</div></div>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide form' : 'New gift'}</button>
        </div>
      </div>
      {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {open ? (
        <>
          <div className="adm-form">
            <Field label="name *"><input value={values.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="sku"><input value={values.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            <Field label="stock quantity"><input type="number" value={values.stock_quantity} onChange={(e) => set('stock_quantity', e.target.value)} /></Field>
            <Field label="unit cost"><input type="number" step="0.01" value={values.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} /></Field>
            <Field label="eligibility"><input value={values.eligibility} onChange={(e) => set('eligibility', e.target.value)} /></Field>
            <Field label="image url"><input value={values.image_url} onChange={(e) => set('image_url', e.target.value)} /></Field>
            <Field label="description" wide><textarea value={values.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <Field label="active"><input type="checkbox" checked={values.is_active} onChange={(e) => set('is_active', e.target.checked)} /></Field>
          </div>
          <div className="adm-actions" style={{ marginTop: 10 }}>
            <button type="button" className="adm-btn adm-btn--primary" onClick={save} disabled={busy || !values.name.trim()}>{busy ? 'Saving' : 'Save gift'}</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function StockAdjust({ gift, notify, onDone }) {
  const [delta, setDelta] = useState('');
  const [kind, setKind] = useState('restock');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_adjust_gift_stock', {
        p_gift_id: gift.id, p_delta: Number(delta || 0), p_kind: kind, p_note: note || null,
      }));
      const after = res.stock_after ?? res.stock_quantity;
      notify(`Stock adjusted${after !== undefined ? ` — now ${after}` : ''}`, 'ok');
      setDelta(''); setNote('');
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      {err ? <div className="adm-error" style={{ marginBottom: 8 }}>{err}</div> : null}
      <div className="adm-form">
        <Field label="delta (e.g. 10 or -2)"><input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
        <Field label="kind"><select value={kind} onChange={(e) => setKind(e.target.value)}>{opts(STOCK_KINDS)}</select></Field>
        <Field label="note (required)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <div className="adm-actions" style={{ marginTop: 8 }}>
        <button type="button" className="adm-btn" onClick={apply} disabled={busy || !delta || !note.trim()}>{busy ? 'Applying' : 'Apply stock change'}</button>
      </div>
    </div>
  );
}

function MovementsPanel({ giftId }) {
  const mv = useApi(() => rpc('admin_get_gift_stock_movements', { p_gift_id: giftId, p_limit: 50 }), [giftId]);
  const rows = useMemo(() => toArr(raw(mv.data).rows), [mv.data]);
  if (mv.error) return <div className="adm-error">{mv.error}</div>;
  if (mv.loading) return <div className="adm-empty">Loading movements…</div>;
  return rows.length ? (
    <div className="adm-table-wrap" style={{ marginTop: 8 }}>
      <table className="adm-table">
        <thead><tr><th>when</th><th>kind</th><th>delta</th><th>stock after</th><th>note</th><th>by</th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{fmtDate(m.created_at)}</td><td>{text(m.kind)}</td><td>{text(m.delta)}</td>
              <td>{text(m.stock_after)}</td><td className="wrap">{text(m.note)}</td><td>{text(m.actor_email)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : <div className="adm-empty">No stock movements recorded.</div>;
}

function NominateForm({ notify, gifts, onDone }) {
  const [open, setOpen] = useState(false);
  const [memberId, setMemberId] = useState('');
  const [giftId, setGiftId] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const candidates = useApi(() => rpc('admin_get_recognition_candidates', { p_limit: 50 }), [], open);
  const candidateRows = useMemo(() => toArr(raw(candidates.data).rows), [candidates.data]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const ev = evidence.trim() ? [{ kind: 'note', note: evidence.trim() }] : null;
      const res = raw(await rpc('admin_nominate_recognition', {
        p_user_id: memberId, p_gift_id: giftId, p_reason: reason, p_evidence: ev, p_review_id: null,
      }));
      notify(`Nominated (${res.status || 'nominated'})`, 'ok');
      setMemberId(''); setGiftId(''); setReason(''); setEvidence('');
      setOpen(false);
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="adm-panel">
      <div className="adm-head">
        <div><div className="adm-panel-title">Nominate a member</div></div>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide form' : 'New nomination'}</button>
        </div>
      </div>
      {candidates.error ? <div className="adm-error" style={{ marginBottom: 8 }}>{candidates.error}</div> : null}
      {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {open ? (
        <>
          <div className="adm-form">
            <Field label="member">
              <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">— select a member —</option>
                {candidateRows.map((c) => (
                  <option key={c.member_id} value={c.member_id}>
                    {(c.name || c.email || c.username || c.member_id)} — {c.completed_tasks ?? 0} tasks, {c.reflections ?? 0} reflections
                  </option>
                ))}
              </select>
            </Field>
            <Field label="gift">
              <select value={giftId} onChange={(e) => setGiftId(e.target.value)}>
                <option value="">— select an active gift —</option>
                {gifts.filter((g) => g.is_active).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}{g.stock_quantity <= 2 ? ` (stock ${g.stock_quantity})` : ''}</option>
                ))}
              </select>
            </Field>
            <Field label="reason (required)" wide><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Field label="evidence note" wide><textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field>
          </div>
          <div className="adm-actions" style={{ marginTop: 10 }}>
            <button type="button" className="adm-btn adm-btn--primary" onClick={submit}
                    disabled={busy || !memberId || !giftId || !reason.trim()}>{busy ? 'Nominating' : 'Nominate'}</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RecognitionDetail({ id, notify, onClose, onChanged }) {
  const det = useApi(() => rpc('admin_get_recognition', { p_id: id }), [id]);
  const p = useMemo(() => raw(det.data), [det.data]);
  const rec = p.recognition || {};
  const member = p.member || {};
  const gift = p.gift || {};
  const evidence = useMemo(() => toArr(p.evidence), [p]);
  const events = useMemo(() => toArr(p.events), [p]);
  const stockRows = useMemo(() => (Array.isArray(p.stock) ? p.stock : []), [p]);
  const [decision, setDecision] = useState('approve');
  const [decisionReason, setDecisionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = () => { det.reload(); if (onChanged) onChanged(); };

  const decide = async () => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_decide_recognition', { p_id: id, p_decision: decision, p_reason: decisionReason || null }));
      notify(`Recognition ${decision === 'approve' ? 'approved' : 'rejected'} (${res.status || ''})`, 'ok');
      setDecisionReason('');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Drawer title={`Award ${text(rec.status)}`} note={`${whoName(member)} · ${text(gift.name)}`} onClose={onClose}>
      {det.error ? <div className="adm-error">{det.error}</div> : null}
      {err ? <div className="adm-error" style={{ marginBottom: 12 }}>{err}</div> : null}
      {det.loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <div className="adm-panel">
            <div className="adm-panel-title">Award</div>
            <p className="adm-note">Status {text(rec.status)} · reason {text(rec.reason)} · nominated {fmtDate(rec.nominated_at)} · decided {fmtDate(rec.decided_at)}</p>
            <p className="adm-note">Member {whoName(member)} · {text(member.email)} · tier {text(member.member_tier)} · {text(member.nectar_points)} nectar</p>
            <p className="adm-note">Gift {text(gift.name)} · sku {text(gift.sku)} · stock {text(gift.stock_quantity)} · unit cost {money(gift.unit_cost)}</p>
            <p className="adm-note">Address: {[rec.recipient_name, rec.address_line1, rec.address_line2, rec.suburb, rec.state, rec.postcode, rec.country].filter(Boolean).join(', ') || '—'}</p>
            <p className="adm-note">
              Consent {rec.consent_at ? fmtDate(rec.consent_at) : 'not recorded'} · carrier {text(rec.carrier)} · tracking {text(rec.tracking_number)}
              {rec.tracking_url ? <> · <a href={rec.tracking_url} target="_blank" rel="noreferrer">track</a></> : null}
            </p>
          </div>

          {rec.status === 'nominated' ? (
            <div className="adm-panel">
              <div className="adm-panel-title">Decision</div>
              <div className="adm-form">
                <Field label="decision">
                  <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                    <option value="approve">approve</option>
                    <option value="reject">reject</option>
                  </select>
                </Field>
                <Field label="reason (required to reject)" wide>
                  <textarea value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />
                </Field>
              </div>
              <div className="adm-actions" style={{ marginTop: 10 }}>
                <button type="button" className="adm-btn adm-btn--primary" onClick={decide} disabled={busy}>{busy ? 'Working' : 'Record decision'}</button>
              </div>
            </div>
          ) : null}

          <FulfilmentPanel id={id} status={rec.status} onDone={refresh} notify={notify} />

          <div className="adm-panel">
            <div className="adm-panel-title">Evidence</div>
            {evidence.length ? evidence.map((e, i) => (
              <p className="adm-note" key={e.id || `${e.kind}-${i}`}>{text(e.kind)} · {text(e.note)}{e.ref_id ? ` (ref ${e.ref_id})` : ''}</p>
            )) : <p className="adm-note">No evidence attached.</p>}
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">History</div>
            {events.length ? (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>when</th><th>kind</th><th>change</th><th>by</th><th>body</th></tr></thead>
                  <tbody>
                    {events.map((ev, i) => (
                      <tr key={`${ev.created_at}-${i}`}>
                        <td>{fmtDate(ev.created_at)}</td><td>{text(ev.kind)}</td>
                        <td>{text(ev.from_status)} to {text(ev.to_status)}</td>
                        <td>{text(ev.actor_email)}</td><td className="wrap">{text(ev.body)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="adm-note">No history yet.</p>}
          </div>

          {stockRows.length ? (
            <div className="adm-panel">
              <div className="adm-panel-title">Stock movements for this award</div>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>when</th><th>kind</th><th>delta</th><th>stock after</th></tr></thead>
                  <tbody>
                    {stockRows.map((m, i) => (
                      <tr key={`${m.created_at}-${i}`}>
                        <td>{fmtDate(m.created_at)}</td><td>{text(m.kind)}</td><td>{text(m.delta)}</td><td>{text(m.stock_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

function FulfilmentPanel({ id, status, onDone, notify }) {
  const validOptions = useMemo(() => [...forwardTargets(status), ...terminalTargets(status)], [status]);
  const [target, setTarget] = useState('');
  const active = validOptions.includes(target) ? target : (validOptions[0] || '');
  const [accepted, setAccepted] = useState(false);
  const [consent, setConsent] = useState(false);
  const [addr, setAddr] = useState({
    recipient_name: '', address_line1: '', address_line2: '', suburb: '', state: '', postcode: '', country: '', phone: '',
  });
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const setA = (k, v) => setAddr((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    if (!active) return;
    setBusy(true); setErr(null);
    const payload = {};
    if (note.trim()) payload.note = note.trim();
    if (active === 'awaiting_address' && accepted) payload.accepted = true;
    if (ADDRESS_TARGETS.includes(active)) {
      if (accepted) payload.accepted = true;
      Object.assign(payload, cleanPayload(addr));
      if (consent) payload.consent = true;
    }
    if (active === 'shipped') Object.assign(payload, cleanPayload({ carrier, tracking_number: tracking, tracking_url: trackingUrl }));
    if (TERMINAL_TARGETS.includes(active)) payload.reason = reason.trim();
    try {
      const res = raw(await rpc('admin_advance_recognition', { p_id: id, p_status: active, p_payload: payload }));
      notify(`Moved to ${res.status || active}${res.stock_returned ? ' (stock returned)' : ''}`, 'ok');
      setReason(''); setNote('');
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (!validOptions.length) {
    return (
      <div className="adm-panel">
        <div className="adm-panel-title">Fulfilment</div>
        <p className="adm-note">No further fulfilment step is available from this status. {status === 'nominated' ? 'Approve or reject the nomination first.' : ''}</p>
      </div>
    );
  }

  const addrRequired = ADDRESS_TARGETS.includes(active);
  const terminal = TERMINAL_TARGETS.includes(active);

  return (
    <div className="adm-panel">
      <div className="adm-panel-title">Fulfilment</div>
      {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
      <div className="adm-form">
        <Field label="move to">
          <select value={active} onChange={(e) => { setTarget(e.target.value); setErr(null); }}>{opts(validOptions)}</select>
        </Field>
        <Field label="note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>

      {active === 'awaiting_address' ? (
        <div className="adm-form" style={{ marginTop: 8 }}>
          <Field label="member accepted"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /></Field>
        </div>
      ) : null}

      {addrRequired ? (
        <>
          <p className="adm-note" style={{ marginTop: 8 }}>A delivery address and recorded consent are required before this step.</p>
          <div className="adm-form">
            <Field label="recipient name"><input value={addr.recipient_name} onChange={(e) => setA('recipient_name', e.target.value)} /></Field>
            <Field label="address line 1"><input value={addr.address_line1} onChange={(e) => setA('address_line1', e.target.value)} /></Field>
            <Field label="address line 2"><input value={addr.address_line2} onChange={(e) => setA('address_line2', e.target.value)} /></Field>
            <Field label="suburb"><input value={addr.suburb} onChange={(e) => setA('suburb', e.target.value)} /></Field>
            <Field label="state"><input value={addr.state} onChange={(e) => setA('state', e.target.value)} /></Field>
            <Field label="postcode"><input value={addr.postcode} onChange={(e) => setA('postcode', e.target.value)} /></Field>
            <Field label="country"><input value={addr.country} onChange={(e) => setA('country', e.target.value)} /></Field>
            <Field label="phone"><input value={addr.phone} onChange={(e) => setA('phone', e.target.value)} /></Field>
            <Field label="member accepted"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /></Field>
            <Field label="consent to share delivery details"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /></Field>
          </div>
        </>
      ) : null}

      {active === 'shipped' ? (
        <div className="adm-form" style={{ marginTop: 8 }}>
          <Field label="carrier (required)"><input value={carrier} onChange={(e) => setCarrier(e.target.value)} /></Field>
          <Field label="tracking number (required)"><input value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
          <Field label="tracking url"><input value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} /></Field>
        </div>
      ) : null}

      {terminal ? (
        <div className="adm-form" style={{ marginTop: 8 }}>
          <Field label="reason (required)" wide><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      ) : null}

      <div className="adm-actions" style={{ marginTop: 10 }}>
        <button type="button" className="adm-btn adm-btn--primary" onClick={submit} disabled={busy}>{busy ? 'Working' : `Move to ${active}`}</button>
      </div>
    </div>
  );
}

/* ───────────────────────────── 3. Support inbox ───────────────────────────── */

export function SupportInboxSection({ notify }) {
  const PAGE = 50;
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [importing, setImporting] = useState(false);

  const tickets = useApi(
    () => rpc('admin_get_tickets', {
      p_status: status || null, p_priority: priority || null, p_search: search || null,
      p_limit: PAGE, p_offset: offset,
    }),
    [status, priority, search, offset],
  );
  const payload = useMemo(() => raw(tickets.data), [tickets.data]);
  const list = useMemo(() => toArr(payload.rows), [payload]);
  const counts = useMemo(() => payload.counts || {}, [payload]);
  const templates = useApi(() => rpc('admin_get_support_templates'), []);
  const templateRows = useMemo(() => toArr(raw(templates.data).rows), [templates.data]);

  const doImport = async () => {
    setImporting(true);
    try {
      const res = raw(await rpc('admin_import_inquiries', { p_limit: 100 }));
      notify(`Imported ${res.imported ?? 0} enquiries as tickets`, 'ok');
      tickets.reload();
    } catch (e) { notify(e.message, 'error'); }
    finally { setImporting(false); }
  };

  return (
    <>
      <SectionHead
        title="Support inbox"
        note="Imported enquiries become tickets with a threaded conversation. Replies are stored on the thread; email delivery is reported honestly and is not yet wired."
        actions={
          <>
            <button type="button" className="adm-btn" onClick={tickets.reload}>Refresh</button>
            <button type="button" className="adm-btn adm-btn--primary" onClick={doImport} disabled={importing}>
              {importing ? 'Importing' : 'Import enquiries'}
            </button>
          </>
        }
      />
      {tickets.error ? <div className="adm-error">{tickets.error}</div> : null}
      <CountsBar counts={counts} note={`unassigned: ${text(payload.unassigned ?? 0)} · overdue: ${text(payload.overdue ?? 0)}`} />
      <CreateTicket notify={notify} onDone={() => { tickets.reload(); }} />
      <div className="adm-filters">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>{opts(TICKET_STATUSES, 'All statuses')}</select>
        <select value={priority} onChange={(e) => { setPriority(e.target.value); setOffset(0); }}>{opts(TICKET_PRIORITIES, 'All priorities')}</select>
        <input value={searchInput} placeholder="Search subject, requester, email"
               onChange={(e) => setSearchInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(searchInput); setOffset(0); } }} />
        <button type="button" className="adm-btn" onClick={() => { setSearch(searchInput); setOffset(0); }}>Search</button>
        <button type="button" className="adm-btn" onClick={() => { setSearchInput(''); setSearch(''); setStatus(''); setPriority(''); setOffset(0); }}>Clear</button>
      </div>
      {tickets.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['last_activity', 'ticket_no', 'subject', 'requester_email', 'status', 'priority', 'assignee_name', 'messages', 'overdue']}
          empty="No tickets. Import enquiries to create the first ones."
          onRowClick={(r) => setOpenId(r.id)}
        />
      )}
      <Pager offset={offset} limit={PAGE} total={Number(counts.total || 0)}
             onPrev={() => setOffset((o) => Math.max(0, o - PAGE))}
             onNext={() => setOffset((o) => o + PAGE)} />

      <TemplatesPanel notify={notify} templates={templateRows} reload={() => templates.reload()} />

      {openId ? (
        <TicketDetail id={openId} notify={notify} templates={templateRows}
                      onClose={() => setOpenId(null)}
                      onChanged={() => tickets.reload()} />
      ) : null}
    </>
  );
}

function CreateTicket({ notify, onDone }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ subject: '', requester_email: '', requester_name: '', category: '', priority: 'normal', message: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setValues((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_create_ticket', { p_ticket: { ...values, source: 'crm' } }));
      notify(`Ticket ${res.ticket_no || ''} created`, 'ok');
      setValues({ subject: '', requester_email: '', requester_name: '', category: '', priority: 'normal', message: '' });
      setOpen(false);
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="adm-panel">
      <div className="adm-head">
        <div><div className="adm-panel-title">New ticket</div></div>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide form' : 'Create ticket'}</button>
        </div>
      </div>
      {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {open ? (
        <>
          <div className="adm-form">
            <Field label="subject *"><input value={values.subject} onChange={(e) => set('subject', e.target.value)} /></Field>
            <Field label="requester email *"><input value={values.requester_email} onChange={(e) => set('requester_email', e.target.value)} /></Field>
            <Field label="requester name"><input value={values.requester_name} onChange={(e) => set('requester_name', e.target.value)} /></Field>
            <Field label="category"><input value={values.category} onChange={(e) => set('category', e.target.value)} /></Field>
            <Field label="priority"><select value={values.priority} onChange={(e) => set('priority', e.target.value)}>{opts(TICKET_PRIORITIES)}</select></Field>
            <Field label="first message" wide><textarea value={values.message} onChange={(e) => set('message', e.target.value)} /></Field>
          </div>
          <div className="adm-actions" style={{ marginTop: 10 }}>
            <button type="button" className="adm-btn adm-btn--primary" onClick={submit}
                    disabled={busy || !values.subject.trim() || !values.requester_email.trim()}>{busy ? 'Creating' : 'Create ticket'}</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TicketDetail({ id, notify, templates, onClose, onChanged }) {
  const det = useApi(() => rpc('admin_get_ticket', { p_id: id }), [id]);
  const team = useApi(() => rpc('admin_get_team_overview'), []);
  const p = useMemo(() => raw(det.data), [det.data]);
  const ticket = p.ticket || {};
  const member = p.member || {};
  const messages = useMemo(() => toArr(p.messages), [p]);
  const admins = useMemo(() => {
    if (team.error || !team.data) return null;
    return toArr(raw(team.data).members).map((m) => ({ id: m.user_id, label: whoName(m) + (m.email ? ` — ${m.email}` : '') }));
  }, [team.data, team.error]);

  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [mergeSource, setMergeSource] = useState('');
  const [mergeReason, setMergeReason] = useState('');

  const refresh = () => { det.reload(); if (onChanged) onChanged(); };

  const update = async (fields) => {
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_update_ticket', { p_ticket: { id, ...fields } }));
      notify(`Ticket updated (${res.status || ''} / ${res.priority || ''})`, 'ok');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const sendReply = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = raw(await rpc('admin_reply_ticket', {
        p_ticket_id: id, p_body: reply, p_internal: internal, p_template_id: templateId || null,
      }));
      setResult(res);
      notify(internal ? 'Internal note added' : 'Reply recorded', 'ok');
      setReply('');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const merge = async () => {
    if (!mergeSource.trim()) { setErr('A source ticket id is required'); return; }
    setBusy(true); setErr(null);
    try {
      const res = raw(await rpc('admin_merge_ticket', { p_target: id, p_source: mergeSource.trim(), p_reason: mergeReason || null }));
      notify(`Merged — moved ${res.moved_messages ?? 0} messages`, 'ok');
      setMergeSource(''); setMergeReason('');
      refresh();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const applyTemplate = (tid) => {
    setTemplateId(tid);
    const t = templates.find((x) => x.id === tid);
    if (t) setReply(t.body || '');
  };

  return (
    <Drawer title={`${text(ticket.ticket_no)} — ${text(ticket.subject)}`} note={`${text(ticket.status)} · ${text(ticket.priority)} · ${text(ticket.requester_email)}`} onClose={onClose}>
      {det.error ? <div className="adm-error">{det.error}</div> : null}
      {err ? <div className="adm-error" style={{ marginBottom: 12 }}>{err}</div> : null}
      {det.loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <div className="adm-panel">
            <div className="adm-panel-title">Ticket</div>
            <p className="adm-note">Requester {text(ticket.requester_name)} · {text(ticket.requester_email)} · member {text(member.name || member.email)}</p>
            <p className="adm-note">Source {text(ticket.source)} · category {text(ticket.category)} · created {fmtDate(ticket.created_at)} · SLA due {fmtDate(ticket.sla_due_at)}</p>
            <div className="adm-filters" style={{ marginTop: 8 }}>
              <select value={ticket.status || ''} onChange={(e) => update({ status: e.target.value })} disabled={busy}>{opts(TICKET_STATUSES)}</select>
              <select value={ticket.priority || ''} onChange={(e) => update({ priority: e.target.value })} disabled={busy}>{opts(TICKET_PRIORITIES)}</select>
              {admins ? (
                <select value={ticket.assignee_id || ''} onChange={(e) => update({ assignee_id: e.target.value || null })} disabled={busy}>
                  <option value="">— unassigned —</option>
                  {admins.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              ) : null}
            </div>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Conversation</div>
            {messages.length ? messages.map((m) => (
              <div key={m.id} style={{ borderLeft: '3px solid var(--adm-border)', paddingLeft: 10, marginBottom: 12 }}>
                <p className="adm-note">
                  <span className={m.direction === 'outbound' ? 'adm-pill adm-pill--ok' : m.direction === 'note' ? 'adm-pill adm-pill--off' : 'adm-pill'}>{text(m.direction)}</span>
                  {' '}{text(m.author_name || m.author_email)} · {fmtDate(m.created_at)}
                  {m.direction !== 'note' ? <> · email: <span className={deliveryKind(m.email_status)}>{deliveryLabel(m.email_status)}</span></> : null}
                </p>
                <p className="adm-note" style={{ whiteSpace: 'pre-wrap' }}>{text(m.body)}</p>
                {m.email_error ? <p className="adm-note">{text(m.email_error)}</p> : null}
              </div>
            )) : <p className="adm-note">No messages on this ticket.</p>}
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Reply</div>
            <div className="adm-form">
              <Field label="template">
                <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">— none —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="internal note"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /></Field>
              <Field label="body" wide><textarea value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
            </div>
            {internal ? <p className="adm-note">An internal note is never emailed to the member.</p> : null}
            {result ? (
              <p className="adm-note" style={{ marginTop: 8 }}>
                Delivery: <span className={deliveryKind(result.email_status)}>{deliveryLabel(result.email_status)}</span>
                {result.delivered === false && result.email_status !== 'not_attempted' ? ' — the member was NOT emailed.' : ''}
              </p>
            ) : null}
            <div className="adm-actions" style={{ marginTop: 10 }}>
              <button type="button" className="adm-btn adm-btn--primary" onClick={sendReply} disabled={busy || !reply.trim()}>
                {busy ? 'Working' : internal ? 'Add internal note' : 'Send reply'}
              </button>
            </div>
          </div>

          <div className="adm-panel">
            <div className="adm-panel-title">Merge another ticket into this one</div>
            <div className="adm-form">
              <Field label="source ticket id"><input value={mergeSource} onChange={(e) => setMergeSource(e.target.value)} placeholder="uuid of the ticket to fold in" /></Field>
              <Field label="reason"><input value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} /></Field>
            </div>
            <div className="adm-actions" style={{ marginTop: 10 }}>
              <button type="button" className="adm-btn" onClick={merge} disabled={busy || !mergeSource.trim()}>Merge into this ticket</button>
            </div>
          </div>

          {toArr(p.member_history).length ? (
            <div className="adm-panel">
              <div className="adm-panel-title">Other tickets from this requester</div>
              {toArr(p.member_history).map((h) => (
                <p className="adm-note" key={h.id}>{text(h.ticket_no)} · {text(h.subject)} · {text(h.status)} · {fmtDate(h.created_at)}</p>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

function TemplatesPanel({ notify, templates, reload }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const startNew = () => { setErr(null); setEditing({ name: '', category: '', body: '', is_active: true }); setOpen(true); };
  const startEdit = (t) => { setErr(null); setEditing({ id: t.id, name: t.name, category: t.category || '', body: t.body || '', is_active: !!t.is_active }); setOpen(true); };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await rpc('admin_save_support_template', { p_template: { ...editing, id: editing.id || undefined } });
      notify('Template saved', 'ok');
      setOpen(false);
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (t) => {
    setBusy(true); setErr(null);
    try {
      await rpc('admin_delete_support_template', { p_id: t.id });
      notify('Template deleted', 'ok');
      setConfirmId(null);
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="adm-panel">
      <div className="adm-head">
        <div><div className="adm-panel-title">Templates</div></div>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={startNew}>New template</button>
        </div>
      </div>
      {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
      {templates.length ? (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>name</th><th>category</th><th>active</th><th>updated</th><th /></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{text(t.name)}</td>
                  <td>{text(t.category)}</td>
                  <td><span className={t.is_active ? 'adm-pill adm-pill--ok' : 'adm-pill adm-pill--off'}>{text(t.is_active)}</span></td>
                  <td>{fmtDate(t.updated_at)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="adm-btn adm-btn--small" onClick={() => startEdit(t)}>Edit</button>
                      {confirmId === t.id ? (
                        <>
                          <button type="button" className="adm-btn adm-btn--small adm-btn--danger" disabled={busy} onClick={() => remove(t)}>Confirm delete</button>
                          <button type="button" className="adm-btn adm-btn--small" onClick={() => setConfirmId(null)}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" className="adm-btn adm-btn--small adm-btn--danger" onClick={() => setConfirmId(t.id)}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="adm-empty">No templates yet.</div>}

      {open && editing ? (
        <div className="adm-modal" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div>
            <div className="adm-head">
              <div><h2>{editing.id ? 'Edit template' : 'New template'}</h2></div>
              <div className="adm-actions">
                <button type="button" className="adm-btn" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="adm-btn adm-btn--primary" onClick={save} disabled={busy || !editing.name.trim() || !editing.body.trim()}>{busy ? 'Saving' : 'Save'}</button>
              </div>
            </div>
            {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
            <div className="adm-form">
              <Field label="name *"><input value={editing.name} onChange={(e) => setEditing((s) => ({ ...s, name: e.target.value }))} /></Field>
              <Field label="category"><input value={editing.category} onChange={(e) => setEditing((s) => ({ ...s, category: e.target.value }))} /></Field>
              <Field label="active"><input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing((s) => ({ ...s, is_active: e.target.checked }))} /></Field>
              <Field label="body *" wide><textarea value={editing.body} onChange={(e) => setEditing((s) => ({ ...s, body: e.target.value }))} /></Field>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── 4. Nectar ledger ───────────────────────────── */

export function NectarLedgerSection({ notify }) {
  const [memberId, setMemberId] = useState('');
  const [applied, setApplied] = useState('');
  const ledger = useApi(() => rpc('admin_get_nectar_ledger', { p_user_id: applied || null, p_limit: 100 }), [applied]);
  const payload = useMemo(() => raw(ledger.data), [ledger.data]);
  const list = useMemo(() => toArr(payload.rows), [payload]);

  const stats = useMemo(() => {
    let credits = 0; let debits = 0;
    for (const r of list) {
      const d = Number(r.delta || 0);
      if (d > 0) credits += d; else if (d < 0) debits += d;
    }
    return { credits, debits, net: credits + debits };
  }, [list]);

  const [adj, setAdj] = useState({ user_id: '', delta: '', reason: '', category: 'correction' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const set = (k, v) => setAdj((s) => ({ ...s, [k]: v }));

  const apply = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = raw(await rpc('admin_adjust_nectar', {
        p_user_id: adj.user_id, p_delta: Number(adj.delta || 0), p_reason: adj.reason, p_category: adj.category,
      }));
      setResult(res);
      notify(`Balance now ${res.balance_after ?? res.balance}`, 'ok');
      setAdj((s) => ({ ...s, delta: '', reason: '' }));
      ledger.reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SectionHead
        title="Nectar ledger"
        note="Every balance change with the number the member sees afterwards. Adjustments update profiles.nectar_points and the ledger row in one transaction."
        actions={<button type="button" className="adm-btn" onClick={ledger.reload}>Refresh</button>}
      />
      {ledger.error ? <div className="adm-error">{ledger.error}</div> : null}
      <CountsBar
        counts={{ total: payload.total ?? list.length, credits: stats.credits, debits: stats.debits, net: stats.net }}
        note="credits / debits / net are computed from the rows below."
      />

      <div className="adm-panel">
        <div className="adm-panel-title">Adjust a member balance</div>
        {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
        <div className="adm-form">
          <Field label="member uuid"><input value={adj.user_id} onChange={(e) => set('user_id', e.target.value)} placeholder="member uuid" /></Field>
          <Field label="delta (e.g. 25 or -10)"><input type="number" value={adj.delta} onChange={(e) => set('delta', e.target.value)} /></Field>
          <Field label="category"><select value={adj.category} onChange={(e) => set('category', e.target.value)}>{opts(NECTAR_CATEGORIES)}</select></Field>
          <Field label="reason (required)" wide><textarea value={adj.reason} onChange={(e) => set('reason', e.target.value)} /></Field>
        </div>
        {result ? (
          <p className="adm-note" style={{ marginTop: 8 }}>
            New balance: <strong>{text(result.balance_after ?? result.balance)}</strong>{' '}
            (was {text(result.balance_before ?? '—')}, change {text(result.delta ?? '—')})
          </p>
        ) : null}
        <div className="adm-actions" style={{ marginTop: 10 }}>
          <button type="button" className="adm-btn adm-btn--primary" onClick={apply}
                  disabled={busy || !adj.user_id.trim() || !adj.delta || !adj.reason.trim()}>{busy ? 'Applying' : 'Apply adjustment'}</button>
        </div>
      </div>

      <div className="adm-filters">
        <input value={memberId} placeholder="Filter by member uuid (blank = all)"
               onChange={(e) => setMemberId(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') setApplied(memberId.trim()); }} />
        <button type="button" className="adm-btn" onClick={() => setApplied(memberId.trim())}>Load</button>
        <button type="button" className="adm-btn" onClick={() => { setMemberId(''); setApplied(''); }}>Clear</button>
      </div>
      {ledger.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['created_at', 'member_email', 'delta', 'balance_after', 'reason', 'category', 'source', 'actor_email']}
          empty="No ledger entries."
        />
      )}
    </>
  );
}

/* ───────────────────────────── 5. Notifications ───────────────────────────── */

export function NotificationsSection({ notify }) {
  const [memberId, setMemberId] = useState('');
  const [applied, setApplied] = useState('');
  const notes = useApi(() => rpc('admin_get_notifications', { p_user_id: applied || null, p_limit: 100 }), [applied]);
  const payload = useMemo(() => raw(notes.data), [notes.data]);
  const list = useMemo(() => toArr(payload.rows), [payload]);
  const stats = useMemo(() => {
    let unread = 0; let undelivered = 0;
    for (const r of list) {
      if (!r.read_at) unread += 1;
      if (r.delivery_status && r.delivery_status !== 'sent') undelivered += 1;
    }
    return { total: list.length, unread, undelivered };
  }, [list]);

  const [form, setForm] = useState({ user_id: '', title: '', body: '', link: '', kind: 'admin.message' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  const send = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = raw(await rpc('admin_send_member_notification', {
        p_user_id: form.user_id, p_title: form.title, p_body: form.body || null, p_link: form.link || null, p_kind: form.kind || 'admin.message',
      }));
      setResult(res);
      notify('Notification queued', 'ok');
      setForm((s) => ({ ...s, title: '', body: '', link: '' }));
      notes.reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SectionHead
        title="Notifications"
        note="The member in-app outbox. Delivery status is reported as stored by the database and is not yet wired to a mail transport."
        actions={<button type="button" className="adm-btn" onClick={notes.reload}>Refresh</button>}
      />
      {notes.error ? <div className="adm-error">{notes.error}</div> : null}
      <CountsBar counts={stats} note="counts computed from the rows shown." />

      <div className="adm-panel">
        <div className="adm-panel-title">Send a notification</div>
        {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
        <div className="adm-form">
          <Field label="member uuid"><input value={form.user_id} onChange={(e) => set('user_id', e.target.value)} placeholder="member uuid" /></Field>
          <Field label="kind"><input value={form.kind} onChange={(e) => set('kind', e.target.value)} /></Field>
          <Field label="title (required)"><input value={form.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="link"><input value={form.link} onChange={(e) => set('link', e.target.value)} /></Field>
          <Field label="body" wide><textarea value={form.body} onChange={(e) => set('body', e.target.value)} /></Field>
        </div>
        {result ? (
          <p className="adm-note" style={{ marginTop: 8 }}>
            Delivery: <span className={deliveryKind(result.delivery_status)}>{deliveryLabel(result.delivery_status)}</span>
          </p>
        ) : null}
        <div className="adm-actions" style={{ marginTop: 10 }}>
          <button type="button" className="adm-btn adm-btn--primary" onClick={send}
                  disabled={busy || !form.user_id.trim() || !form.title.trim()}>{busy ? 'Sending' : 'Send notification'}</button>
        </div>
      </div>

      <div className="adm-filters">
        <input value={memberId} placeholder="Filter by member uuid (blank = all)"
               onChange={(e) => setMemberId(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') setApplied(memberId.trim()); }} />
        <button type="button" className="adm-btn" onClick={() => setApplied(memberId.trim())}>Load</button>
        <button type="button" className="adm-btn" onClick={() => { setMemberId(''); setApplied(''); }}>Clear</button>
      </div>
      {notes.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['created_at', 'member_email', 'kind', 'title', 'channel', 'delivery_status', 'read_at']}
          empty="No notifications."
        />
      )}
    </>
  );
}

/* ───────────────────────────── 6. Settings ───────────────────────────── */

export function SettingsSection({ notify }) {
  const st = useApi(() => rpc('admin_get_settings'), []);
  const payload = useMemo(() => raw(st.data), [st.data]);
  const list = useMemo(() => toArr(payload.rows), [payload]);
  const [edits, setEdits] = useState({});
  const [busyKey, setBusyKey] = useState('');
  const [err, setErr] = useState(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [confirmKey, setConfirmKey] = useState(null);

  const valueOf = (row) => (row.key in edits ? edits[row.key] : (row.value ?? ''));

  const saveRow = async (row) => {
    setBusyKey(row.key); setErr(null);
    try {
      await rpc('admin_save_setting', { p_key: row.key, p_value: valueOf(row) });
      notify(`Saved ${row.key}`, 'ok');
      setEdits((e) => { const n = { ...e }; delete n[row.key]; return n; });
      st.reload();
    } catch (e) { setErr(e.message); }
    finally { setBusyKey(''); }
  };

  const removeRow = async (row) => {
    setBusyKey(row.key); setErr(null);
    try {
      await rpc('admin_delete_setting', { p_key: row.key });
      notify(`Deleted ${row.key}`, 'ok');
      setConfirmKey(null);
      st.reload();
    } catch (e) { setErr(e.message); }
    finally { setBusyKey(''); }
  };

  const addKey = async () => {
    if (!newKey.trim()) { setErr('A setting key is required'); return; }
    setBusyKey('__new'); setErr(null);
    try {
      await rpc('admin_save_setting', { p_key: newKey.trim(), p_value: newValue });
      notify(`Saved ${newKey.trim()}`, 'ok');
      setNewKey(''); setNewValue('');
      st.reload();
    } catch (e) { setErr(e.message); }
    finally { setBusyKey(''); }
  };

  return (
    <>
      <SectionHead
        title="Settings"
        note="app_config key/value pairs read by the member pages. Changes take effect on the member side on the next page load."
        actions={<button type="button" className="adm-btn" onClick={st.reload}>Refresh</button>}
      />

      <IntegrationHealthSection />

      <div className="adm-panel">
        <div className="adm-panel-title">Add a setting</div>
        {err ? <div className="adm-error" style={{ marginBottom: 10 }}>{err}</div> : null}
        <div className="adm-form">
          <Field label="key (required)"><input value={newKey} onChange={(e) => setNewKey(e.target.value)} /></Field>
          <Field label="value"><input value={newValue} onChange={(e) => setNewValue(e.target.value)} /></Field>
        </div>
        <div className="adm-actions" style={{ marginTop: 10 }}>
          <button type="button" className="adm-btn adm-btn--primary" onClick={addKey} disabled={busyKey === '__new' || !newKey.trim()}>
            {busyKey === '__new' ? 'Saving' : 'Save setting'}
          </button>
        </div>
      </div>

      {st.error ? <div className="adm-error">{st.error}</div> : null}
      {st.loading ? <div className="adm-empty">Loading…</div> : (list.length ? (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead><tr><th>key</th><th>value</th><th /></tr></thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.key}>
                  <td>{text(row.key)}</td>
                  <td>
                    <input value={valueOf(row)} style={{ minWidth: 220 }}
                           onChange={(e) => setEdits((s) => ({ ...s, [row.key]: e.target.value }))} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="adm-btn adm-btn--small" disabled={busyKey === row.key || !(row.key in edits)} onClick={() => saveRow(row)}>
                        {busyKey === row.key ? 'Saving' : 'Save'}
                      </button>
                      {confirmKey === row.key ? (
                        <>
                          <button type="button" className="adm-btn adm-btn--small adm-btn--danger" disabled={busyKey === row.key} onClick={() => removeRow(row)}>Confirm delete</button>
                          <button type="button" className="adm-btn adm-btn--small" onClick={() => setConfirmKey(null)}>Cancel</button>
                        </>
                      ) : (
                        <button type="button" className="adm-btn adm-btn--small adm-btn--danger" onClick={() => setConfirmKey(row.key)}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="adm-empty">No settings yet.</div>)}
    </>
  );
}

/* ───────────────────────────── 7. Integration health ───────────────────────────── */

export function IntegrationHealthSection() {
  const h = useApi(() => rpc('admin_get_integration_health'), []);
  const health = useMemo(() => raw(h.data).health || {}, [h.data]);
  const email = health.email_transport || {};
  const checks = useMemo(() => {
    const out = [];
    for (const [name, val] of Object.entries(health)) {
      if (val && typeof val === 'object' && 'ready' in val) {
        out.push({ name, ready: val.ready === true, detail: val.detail });
      }
    }
    return out;
  }, [health]);
  const tables = useMemo(() => {
    const t = health.tables || {};
    return Object.entries(t).map(([name, count]) => ({ name, count }));
  }, [health]);

  return (
    <>
      <SectionHead
        title="Integration health"
        note="Whether each external dependency is actually wired, read from the database so nobody has to guess."
        actions={<button type="button" className="adm-btn" onClick={h.reload}>Refresh</button>}
      />
      {h.error ? <div className="adm-error">{h.error}</div> : null}

      {email.ready === false ? (
        <div className="adm-error" style={{ marginBottom: 14 }}>
          Email is NOT ready. {email.detail || 'No mail transport is configured.'} Replies and notifications are stored in-app only and are never marked as sent.
        </div>
      ) : null}

      {h.loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead><tr><th>dependency</th><th>ready</th><th>detail</th></tr></thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name.replace(/_/g, ' ')}</td>
                    <td><span className={c.ready ? 'adm-pill adm-pill--ok' : 'adm-pill adm-pill--off'}>{c.ready ? 'ready' : 'not ready'}</span></td>
                    <td className="wrap">{text(c.detail)}</td>
                  </tr>
                ))}
                {checks.length === 0 ? <tr><td colSpan={3}>No checks reported.</td></tr> : null}
              </tbody>
            </table>
          </div>

          {tables.length ? (
            <div className="adm-panel" style={{ marginTop: 14 }}>
              <div className="adm-panel-title">Row counts</div>
              <div className="adm-cards">
                {tables.map((t) => (
                  <div className="adm-card" key={t.name}><div className="k">{t.name.replace(/_/g, ' ')}</div><div className="v">{text(t.count)}</div></div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
