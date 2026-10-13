/* ---------------------------------------------------------------------------
   Phase A admin screens (read-only).

   Six components. No writes: no rpc() call in this file mutates anything, and
   every screen is backed by the ops read-layer. Data comes straight from these
   Postgres JSONB functions via the shared api.js rpc() helper:

     admin_get_activity_feed(p_limit, p_from, p_to, p_kind)
     admin_get_reflections(p_status, p_limit, p_offset)
     admin_get_sigma_inbox(p_status, p_limit, p_offset)
     admin_get_ticket_history(p_status, p_priority, p_limit, p_offset, p_overdue)
     admin_get_fulfilment_queue(p_status, p_limit)
     admin_get_member_360(p_user_id)

   Every screen renders real RPC output or an honest empty / error state; the
   server's own message is surfaced verbatim when a read fails. No invented
   values are substituted for data the caller cannot see.
   --------------------------------------------------------------------------- */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rpc, raw, fmtDate, text } from './api.js';
import { SectionHead } from './sections.jsx';
import './phase-a.css';

/* ── tiny helpers ────────────────────────────────────────────────────────── */

function toArr(v) {
  return Array.isArray(v) ? v : [];
}

function whoName(o) {
  if (!o) return '—';
  return o.name || [o.first_name, o.last_name].filter(Boolean).join(' ') || o.username || o.email || '—';
}

function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return text(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function list(v) {
  return Array.isArray(v) && v.length ? v.join(', ') : '—';
}

/* The house data hook (identical to the one in sections.jsx / sections-crm.jsx):
   loads on mount and whenever the serialised dependency list changes; loadRef
   keeps the freshest loader closure so the effect does not need the function in
   its dependency list. */
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

/* Support SLA figures. Every number comes from admin_get_sla_stats(); when the call fails the
   server's own message is shown instead of a zero, and nothing is recomputed in the browser. */
function SlaStrip({ q }) {
  const p = useMemo(() => raw(q.data), [q.data]);
  const open = p.open || {};
  const fr = p.first_response || {};
  const targets = p.targets_hours || {};
  if (q.loading) return <div className="adm-empty">Loading SLA figures...</div>;
  if (q.error) return <div className="adm-note">SLA figures unavailable: {q.error}</div>;
  if (!Object.keys(open).length) return null;
  const cards = [
    ['open tickets', open.total],
    ['overdue', open.overdue],
    ['unanswered', open.unanswered],
    ['no SLA target', open.no_target],
    ['avg open age (h)', open.avg_age_hours],
    ['avg first response (min)', fr.avg_minutes],
    ['first-response breaches', fr.breached],
  ];
  return (
    <div className="adm-cards">
      {cards.map(([k, v]) => (
        <div className="adm-card" key={k}>
          <div className="k">{k}</div>
          <div className="v">{text(v)}</div>
        </div>
      ))}
      <div className="adm-card">
        <div className="k">targets (hours)</div>
        <div className="v" style={{ fontSize: '0.95rem' }}>
          urgent {text(targets.urgent)} / high {text(targets.high)} / normal {text(targets.normal)} / low {text(targets.low)}
        </div>
      </div>
    </div>
  );
}

/* ── presentation primitives (chrome from admin.css, tones from phase-a.css) ─ */

function Pill({ tone, title, children }) {
  const cls = tone === 'ok' ? 'adm-pill adm-pill--ok'
    : tone === 'off' ? 'adm-pill adm-pill--off'
      : tone === 'danger' ? 'adm-pill admpa-pill--danger'
        : tone === 'warn' ? 'adm-pill admpa-pill--warn'
          : 'adm-pill';
  return <span className={cls} title={title}>{children}</span>;
}

function Kv({ k, children }) {
  return (
    <div>
      <div className="admpa-kv-k">{k}</div>
      <div className="admpa-kv-v">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="admpa-field">
      <span>{label}</span>
      {children}
    </div>
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

function Pager({ total, offset, pageSize, onPage }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);
  return (
    <div className="adm-filters">
      <button type="button" className="adm-btn adm-btn--small"
        disabled={offset <= 0} onClick={() => onPage(Math.max(0, offset - pageSize))}>Previous</button>
      <span className="adm-note">Showing {from}–{to} of {total}</span>
      <button type="button" className="adm-btn adm-btn--small"
        disabled={offset + pageSize >= total} onClick={() => onPage(offset + pageSize)}>Next</button>
    </div>
  );
}

function DataTable({ rows, columns, onRowClick, empty }) {
  if (!rows.length) return <div className="adm-empty">{empty}</div>;
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id !== undefined && row.id !== null ? String(row.id) : (row.ticket_no || i)}
              className={onRowClick ? 'is-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => {
                const v = c.render ? c.render(row) : row[c.key];
                const isNode = typeof v === 'object' && v !== null;
                const isDate = !c.render && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
                const long = typeof v === 'string' && v.length > 70;
                return (
                  <td key={c.key} className={long ? 'wrap' : undefined}>
                    {isNode ? v : isDate ? fmtDate(v) : text(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. ACTIVITY FEED
   ═══════════════════════════════════════════════════════════════════════════ */

const FEED_LIMIT = 200;

/* The legend keys are not all usable as prefixes (e.g. the "sigma_log" legend
   key covers "sigma.submitted" rows), so the filter options are the real kind
   prefixes; the label falls back to the static text where the legend key
   differs. */
const FEED_KINDS = [
  { value: 'member', label: 'Registration', legend: ['member'] },
  { value: 'task', label: 'Task completion', legend: ['task'] },
  { value: 'reflection', label: 'Task reflection', legend: ['reflection'] },
  { value: 'sigma', label: 'Sigma log', legend: ['sigma_log', 'sigma'] },
  { value: 'nectar', label: 'Nectar movement', legend: ['nectar'] },
  { value: 'token', label: 'Token awarded', legend: ['token'] },
  { value: 'milestone', label: 'Milestone reached', legend: ['milestone'] },
  { value: 'review', label: 'Review activity', legend: ['review'] },
  { value: 'recognition', label: 'Recognition activity', legend: ['recognition'] },
  { value: 'support', label: 'Support traffic', legend: ['support'] },
  { value: 'board', label: 'Board post', legend: ['communication', 'board'] },
  { value: 'admin', label: 'Administrator action', legend: ['admin'] },
];

function feedLabel(kind, legend) {
  const entry = FEED_KINDS.find((e) => kind === e.value || kind.startsWith(e.value + '.'));
  if (!entry) return kind;
  for (const lk of entry.legend) {
    if (legend && legend[lk]) return legend[lk];
  }
  return entry.label;
}

export function ActivityFeedSection({ onNavigate }) {
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [memberId, setMemberId] = useState(null);

  const feed = useApi(() => rpc('admin_get_activity_feed', {
    p_limit: FEED_LIMIT,
    p_from: from || null,
    p_to: to || null,
    p_kind: kind || null,
  }), [kind, from, to]);

  const payload = useMemo(() => raw(feed.data), [feed.data]);
  const rows = useMemo(() => toArr(payload.rows), [payload]);
  const legend = useMemo(() => (payload.legend && typeof payload.legend === 'object' ? payload.legend : {}), [payload]);
  const range = payload.range || {};
  const selectSection = typeof onNavigate === 'function' ? onNavigate : null;

  return (
    <>
      <SectionHead
        title="Activity feed"
        note="Everything that happened across the platform, newest first. Rows link to the section that owns them."
        actions={<button type="button" className="adm-btn" onClick={feed.reload}>Refresh</button>}
      />

      <div className="adm-filters">
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All activity</option>
            {FEED_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {(k.legend.map((lk) => legend[lk]).find(Boolean)) || k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {(kind || from || to) ? (
          <button type="button" className="adm-btn adm-btn--small"
            onClick={() => { setKind(''); setFrom(''); setTo(''); }}>Clear</button>
        ) : null}
      </div>

      {feed.error ? <div className="adm-error">Could not load: {feed.error}</div> : null}
      {feed.loading ? <div className="adm-empty">Loading activity…</div> : null}

      {!feed.loading && !feed.error ? (
        <>
          <p className="adm-note">
            {text(payload.count)} row(s)
            {range.from || range.to ? ` · range ${range.from ? fmtDate(range.from) : 'start'} to ${range.to ? fmtDate(range.to) : 'now'}` : ''}
            {Number(payload.count) > FEED_LIMIT ? ` (showing first ${FEED_LIMIT})` : ''}
          </p>
          <DataTable
            rows={rows}
            empty="No activity in this range."
            columns={[
              { key: 'at', label: 'When', render: (r) => <span title={text(r.at_raw)}>{fmtDate(r.at)}</span> },
              { key: 'kind', label: 'Kind', render: (r) => <span>{feedLabel(r.kind, legend)}</span> },
              { key: 'actor', label: 'Actor', render: (r) => (r.actor ? `${r.actor}${r.actor_email ? ` · ${r.actor_email}` : ''}` : '—') },
              { key: 'subject', label: 'Subject' },
              { key: 'detail', label: 'Detail' },
              {
                key: 'section',
                label: 'Open',
                render: (r) => {
                  if (r.entity === 'member' && r.entity_id) {
                    return (
                      <button type="button" className="adm-btn adm-btn--small"
                        onClick={(e) => { e.stopPropagation(); setMemberId(r.entity_id); }}>Member 360</button>
                    );
                  }
                  if (r.section && selectSection) {
                    return (
                      <button type="button" className="adm-btn adm-btn--small"
                        onClick={(e) => { e.stopPropagation(); selectSection(r.section); }}>Open</button>
                    );
                  }
                  return <span className="adm-note">{text(r.section)}</span>;
                },
              },
            ]}
          />
        </>
      ) : null}

      {memberId ? <Member360Drawer userId={memberId} onClose={() => setMemberId(null)} /> : null}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 + 3. REVIEW QUEUES (reflections, sigma inbox) — shared shell
   ═══════════════════════════════════════════════════════════════════════════ */

const REVIEW_STATUSES = ['unreviewed', 'new', 'in_review', 'needs_clarification', 'reviewed', 'flagged'];

function statusPill(status) {
  if (!status) return <Pill tone="off">No status</Pill>;
  const tone = status === 'reviewed' ? 'ok'
    : status === 'flagged' ? 'danger'
      : status === 'needs_clarification' ? 'warn'
        : 'off';
  return <Pill tone={tone}>{text(status)}</Pill>;
}

function DmaicBlocks({ row }) {
  const fields = [['define', 'Define'], ['measure', 'Measure'], ['analysis', 'Analyse'], ['improve', 'Improve'], ['control', 'Control']];
  return (
    <div className="admpa-dmaic">
      {fields.map(([k, label]) => (
        <div className="admpa-dmaic-item" key={k}>
          <div className="admpa-dmaic-label">{label}</div>
          <p className="admpa-dmaic-body">{text(row[k])}</p>
        </div>
      ))}
    </div>
  );
}

function QueueDetailDrawer({ row, kind, onClose, onOpenMember }) {
  const label = kind === 'sigma' ? 'Sigma log' : 'Reflection';
  const note = kind === 'reflection'
    ? `${row.task_title ? `${row.task_title} · ` : ''}${row.task_stage ? `${row.task_stage} · ` : ''}submitted ${fmtDate(row.created_at)}`
    : `submitted ${fmtDate(row.created_at)}`;
  return (
    <Drawer title={`${label} — ${whoName({ name: row.user_name, email: row.user_email })}`} note={note} onClose={onClose}>
      {row.user_id ? (
        <div className="adm-filters">
          <button type="button" className="adm-btn adm-btn--small" onClick={() => onOpenMember(row.user_id)}>Member 360</button>
        </div>
      ) : null}
      <div className="admpa-stack">
        <div className="admpa-kv">
          <Kv k="Member">{text(row.user_name)}</Kv>
          <Kv k="Email">{text(row.user_email)}</Kv>
          <Kv k="Kind">{text(row.kind)}</Kv>
          <Kv k="Created">{fmtDate(row.created_at)}</Kv>
          {row.task_id ? <Kv k="Task">{text(row.task_title)}</Kv> : null}
          {row.task_id ? <Kv k="Task stage">{text(row.task_stage)}</Kv> : null}
          {row.completed_at ? <Kv k="Completed">{fmtDate(row.completed_at)}</Kv> : null}
          <Kv k="Review status">{statusPill(row.review_status)}</Kv>
          <Kv k="Reviewer">{text(row.reviewer_id)}</Kv>
          <Kv k="Assignee">{text(row.assignee_id)}</Kv>
          <Kv k="Reviewed at">{row.reviewed_at ? fmtDate(row.reviewed_at) : '—'}</Kv>
          {kind === 'reflection' ? <Kv k="Clarification requested">{row.clarification_requested_at ? fmtDate(row.clarification_requested_at) : '—'}</Kv> : null}
          <Kv k="Flag reason">{text(row.flagged_reason)}</Kv>
          <Kv k="Member response">{text(row.member_response)}</Kv>
          <Kv k="Internal notes">{text(row.internal_notes)}</Kv>
          {row.nominated_recognition_id ? <Kv k="Recognition nomination">{text(row.nominated_recognition_id)}</Kv> : null}
        </div>
        <DmaicBlocks row={row} />
      </div>
    </Drawer>
  );
}

function QueueSection({ title, note, kind, statuses, initialStatus, emptyAwaiting, emptyFiltered, fetchPage, columns }) {
  const PAGE = 50;
  const [status, setStatus] = useState(initialStatus || '');
  const [offset, setOffset] = useState(0);
  const [openRow, setOpenRow] = useState(null);
  const [memberId, setMemberId] = useState(null);

  const q = useApi(() => fetchPage(status, offset, PAGE), [status, offset]);
  const payload = useMemo(() => raw(q.data), [q.data]);
  const rows = useMemo(() => toArr(payload.rows), [payload]);
  const total = Number(payload.total || 0);

  const changeStatus = (v) => { setStatus(v); setOffset(0); };

  return (
    <>
      <SectionHead
        title={title}
        note={note}
        actions={<button type="button" className="adm-btn" onClick={q.reload}>Refresh</button>}
      />

      <div className="adm-filters">
        <Field label="Status">
          <select value={status} onChange={(e) => changeStatus(e.target.value)}>
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        {payload.note ? <span className="adm-note">{text(payload.note)}</span> : null}
      </div>

      {q.error ? <div className="adm-error">Could not load: {q.error}</div> : null}
      {q.loading ? <div className="adm-empty">Loading…</div> : null}

      {!q.loading && !q.error ? (
        <>
          <DataTable
            rows={rows}
            onRowClick={setOpenRow}
            empty={status === 'unreviewed' ? emptyAwaiting : emptyFiltered}
            columns={columns}
          />
          <Pager total={total} offset={offset} pageSize={PAGE} onPage={setOffset} />
        </>
      ) : null}

      {openRow ? (
        <QueueDetailDrawer
          row={openRow}
          kind={kind}
          onClose={() => setOpenRow(null)}
          onOpenMember={(id) => { setOpenRow(null); setMemberId(id); }}
        />
      ) : null}
      {memberId ? <Member360Drawer userId={memberId} onClose={() => setMemberId(null)} /> : null}
    </>
  );
}

export function ReflectionsSection() {
  return (
    <QueueSection
      title="Task reflections"
      note="Define / Measure / Analyse / Improve / Control write-ups submitted against tasks. Open a row for the full text."
      kind="reflection"
      statuses={REVIEW_STATUSES}
      initialStatus="unreviewed"
      emptyAwaiting="Nothing awaiting review."
      emptyFiltered="No reflections match this filter."
      fetchPage={(status, offset, limit) => rpc('admin_get_reflections', {
        p_status: status || null,
        p_limit: limit,
        p_offset: offset,
      })}
      columns={[
        { key: 'created_at', label: 'Submitted' },
        { key: 'user_name', label: 'Member' },
        { key: 'user_email', label: 'Email' },
        { key: 'task_title', label: 'Task' },
        { key: 'task_stage', label: 'Stage' },
        { key: 'review_status', label: 'Review', render: (r) => statusPill(r.review_status) },
        { key: 'completed_at', label: 'Completed' },
      ]}
    />
  );
}

export function SigmaInboxSection() {
  return (
    <QueueSection
      title="Sigma inbox"
      note="General sigma logs (not tied to a task) plus task reflections routed here for review. Open a row for the full text."
      kind="sigma"
      statuses={REVIEW_STATUSES}
      initialStatus="unreviewed"
      emptyAwaiting="Nothing awaiting review."
      emptyFiltered="No sigma logs match this filter."
      fetchPage={(status, offset, limit) => rpc('admin_get_sigma_inbox', {
        p_status: status || null,
        p_limit: limit,
        p_offset: offset,
      })}
      columns={[
        { key: 'created_at', label: 'Submitted' },
        { key: 'user_name', label: 'Member' },
        { key: 'user_email', label: 'Email' },
        { key: 'kind', label: 'Kind' },
        { key: 'review_status', label: 'Review', render: (r) => statusPill(r.review_status) },
        { key: 'reviewed_at', label: 'Reviewed' },
      ]}
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. TICKET HISTORY
   ═══════════════════════════════════════════════════════════════════════════ */

const TICKET_PAGE = 100;
const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'];

/* Exact sla_state vocabulary emitted by the read-layer SQL
   (admin_get_ticket_history, S7): closed | unset | overdue | due_soon | within. */
const SLA_LABELS = {
  closed: 'Closed',
  unset: 'No target set',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  within: 'On track',
};
const SLA_TONES = {
  closed: 'off',
  unset: 'off',
  overdue: 'danger',
  due_soon: 'warn',
  within: 'ok',
};

function SlaPill({ state }) {
  if (!state) return <Pill tone="off">No target set</Pill>;
  return <Pill tone={SLA_TONES[state] || 'off'}>{SLA_LABELS[state] || state}</Pill>;
}

function priorityTone(p) {
  return p === 'urgent' ? 'danger' : p === 'high' ? 'warn' : 'off';
}

export function TicketHistorySection() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [overdue, setOverdue] = useState('');
  const [offset, setOffset] = useState(0);
  const [openRow, setOpenRow] = useState(null);
  const [memberId, setMemberId] = useState(null);

  const q = useApi(() => rpc('admin_get_ticket_history', {
    p_status: status || null,
    p_priority: priority || null,
    p_limit: TICKET_PAGE,
    p_offset: offset,
    p_overdue: overdue === '' ? null : overdue === 'yes',
  }), [status, priority, overdue, offset]);

  const payload = useMemo(() => raw(q.data), [q.data]);
  const rows = useMemo(() => toArr(payload.rows), [payload]);
  const total = Number(payload.total || 0);
  const statuses = toArr(payload.statuses);
  const sla = useApi(() => rpc('admin_get_sla_stats', { p_from: null, p_to: null }), []);


  const reset = (fn) => (e) => { fn(e.target.value); setOffset(0); };
  const openTicket = openRow;

  return (
    <>
      <SectionHead
        title="Ticket history"
        note="Full support ticket log. Open a row for SLA detail, first-response time and merge history."
        actions={<button type="button" className="adm-btn" onClick={q.reload}>Refresh</button>}
      />

      <SlaStrip q={sla} />

      <div className="adm-filters">
        <Field label="Status">
          <select value={status} onChange={reset(setStatus)}>
            <option value="">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={reset(setPriority)}>
            <option value="">All priorities</option>
            {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="SLA">
          <select value={overdue} onChange={reset(setOverdue)}>
            <option value="">All</option>
            <option value="yes">Overdue only</option>
            <option value="no">On track</option>
          </select>
        </Field>
      </div>

      {q.error ? <div className="adm-error">Could not load: {q.error}</div> : null}
      {q.loading ? <div className="adm-empty">Loading tickets…</div> : null}

      {!q.loading && !q.error ? (
        <>
          <DataTable
            rows={rows}
            onRowClick={setOpenRow}
            empty="No tickets match this filter."
            columns={[
              { key: 'ticket_no', label: 'Ticket' },
              { key: 'subject', label: 'Subject' },
              { key: 'requester_name', label: 'Requester', render: (r) => (r.requester_name ? `${r.requester_name}${r.requester_email ? ` · ${r.requester_email}` : ''}` : '—') },
              { key: 'status', label: 'Status' },
              { key: 'priority', label: 'Priority', render: (r) => <Pill tone={priorityTone(r.priority)}>{text(r.priority)}</Pill> },
              { key: 'age_hours', label: 'Age (h)' },
              { key: 'sla_state', label: 'SLA', render: (r) => <SlaPill state={r.sla_state} /> },
              { key: 'message_count', label: 'Msgs' },
              { key: 'last_message_at', label: 'Last message' },
            ]}
          />
          <Pager total={total} offset={offset} pageSize={TICKET_PAGE} onPage={setOffset} />
        </>
      ) : null}

      {openTicket ? (
        <Drawer
          title={`Ticket ${text(openTicket.ticket_no)}`}
          note={`${text(openTicket.status)} · ${text(openTicket.priority)} priority · ${text(openTicket.category)}`}
          onClose={() => setOpenRow(null)}
        >
          {openTicket.requester_id ? (
            <div className="adm-filters">
              <button type="button" className="adm-btn adm-btn--small"
                onClick={() => { const id = openTicket.requester_id; setOpenRow(null); setMemberId(id); }}>Member 360</button>
            </div>
          ) : null}
          <div className="admpa-stack">
            <h3>{text(openTicket.subject)}</h3>
            <div className="admpa-kv">
              <Kv k="Status">{text(openTicket.status)}</Kv>
              <Kv k="Priority"><Pill tone={priorityTone(openTicket.priority)}>{text(openTicket.priority)}</Pill></Kv>
              <Kv k="SLA"><SlaPill state={openTicket.sla_state} /></Kv>
              <Kv k="SLA due">{openTicket.sla_due_at ? fmtDate(openTicket.sla_due_at) : '—'}</Kv>
              <Kv k="Category">{text(openTicket.category)}</Kv>
              <Kv k="Source">{text(openTicket.source)}</Kv>
              <Kv k="Age (h)">{text(openTicket.age_hours)}</Kv>
              <Kv k="Messages">{text(openTicket.message_count)}</Kv>
              <Kv k="Requester">{text(openTicket.requester_name)}</Kv>
              <Kv k="Requester email">{text(openTicket.requester_email)}</Kv>
              <Kv k="Assignee">{text(openTicket.assignee_email)}</Kv>
              <Kv k="First response">{openTicket.first_response_at ? `${fmtDate(openTicket.first_response_at)}${openTicket.first_response_minutes != null ? ` (${openTicket.first_response_minutes} min)` : ''}` : '—'}</Kv>
              <Kv k="Created">{fmtDate(openTicket.created_at)}</Kv>
              <Kv k="Updated">{fmtDate(openTicket.updated_at)}</Kv>
              <Kv k="Last message">{openTicket.last_message_at ? fmtDate(openTicket.last_message_at) : '—'}</Kv>
              <Kv k="Resolved">{openTicket.resolved_at ? fmtDate(openTicket.resolved_at) : '—'}</Kv>
              <Kv k="Closed">{openTicket.closed_at ? fmtDate(openTicket.closed_at) : '—'}</Kv>
              <Kv k="Reopened">{openTicket.reopened_at ? fmtDate(openTicket.reopened_at) : '—'}</Kv>
              <Kv k="Merged into">{text(openTicket.merged_into)}</Kv>
            </div>
          </div>
        </Drawer>
      ) : null}
      {memberId ? <Member360Drawer userId={memberId} onClose={() => setMemberId(null)} /> : null}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. GIFT FULFILMENT
   ═══════════════════════════════════════════════════════════════════════════ */

const FULFILMENT_LIMIT = 200;

function stageLabel(s) {
  return String(s || '').replace(/_/g, ' ');
}

export function GiftFulfilmentSection() {
  const [status, setStatus] = useState('');
  const [openRow, setOpenRow] = useState(null);
  const [memberId, setMemberId] = useState(null);

  const q = useApi(() => rpc('admin_get_fulfilment_queue', {
    p_status: status || null,
    p_limit: FULFILMENT_LIMIT,
  }), [status]);

  const payload = useMemo(() => raw(q.data), [q.data]);
  const flow = useMemo(() => toArr(payload.flow), [payload]);
  const terminal = useMemo(() => toArr(payload.terminal), [payload]);
  const counts = useMemo(() => (payload.counts && typeof payload.counts === 'object' ? payload.counts : {}), [payload]);
  const stock = useMemo(() => toArr(payload.stock), [payload]);
  const rows = useMemo(() => toArr(payload.rows), [payload]);
  const piiVisible = payload.pii_visible === true;
  const allCount = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);

  return (
    <>
      <SectionHead
        title="Gift fulfilment"
        note="Recognition gift pipeline, stock levels and the queue. Click a stage to filter the queue."
        actions={<button type="button" className="adm-btn" onClick={q.reload}>Refresh</button>}
      />

      {q.error ? <div className="adm-error">Could not load: {q.error}</div> : null}
      {q.loading ? <div className="adm-empty">Loading fulfilment queue…</div> : null}

      {!q.loading && !q.error ? (
        <>
          <div className="admpa-pipeline">
            <button type="button" className={`admpa-stage${status === '' ? ' is-active' : ''}`} onClick={() => setStatus('')}>
              All stages <span className="admpa-stage-count">{allCount}</span>
            </button>
            {flow.length ? <span className="admpa-pipeline-label">Pipeline</span> : null}
            {flow.map((s) => (
              <button key={s} type="button"
                className={`admpa-stage${status === s ? ' is-active' : ''}`}
                onClick={() => setStatus(status === s ? '' : s)}>
                {stageLabel(s)} <span className="admpa-stage-count">{Number(counts[s]) || 0}</span>
              </button>
            ))}
            {terminal.length ? <span className="admpa-pipeline-sep" aria-hidden="true" /> : null}
            {terminal.map((s) => (
              <button key={s} type="button"
                className={`admpa-stage admpa-stage--terminal${status === s ? ' is-active' : ''}`}
                onClick={() => setStatus(status === s ? '' : s)}>
                {stageLabel(s)} <span className="admpa-stage-count">{Number(counts[s]) || 0}</span>
              </button>
            ))}
          </div>

          {!piiVisible ? (
            <p className="adm-note">Delivery addresses are hidden for your role; each row shows whether an address is on file.</p>
          ) : null}

          <h3>Low stock</h3>
          <DataTable
            rows={stock}
            empty="No gift stock records."
            columns={[
              { key: 'name', label: 'Gift' },
              { key: 'sku', label: 'SKU' },
              { key: 'stock_quantity', label: 'On hand' },
              { key: 'unit_cost', label: 'Unit cost', render: (r) => money(r.unit_cost) },
              { key: 'is_active', label: 'Active', render: (r) => (r.is_active ? <Pill tone="ok">Active</Pill> : <Pill tone="off">Inactive</Pill>) },
              { key: 'low', label: 'Stock', render: (r) => (r.low ? <Pill tone="danger">Low</Pill> : <Pill tone="ok">OK</Pill>) },
            ]}
          />

          <h3>Queue</h3>
          <DataTable
            rows={rows}
            onRowClick={setOpenRow}
            empty={status ? 'No recognition gifts in this stage.' : 'Nothing in the fulfilment queue.'}
            columns={[
              { key: 'created_at', label: 'Queued' },
              { key: 'member_name', label: 'Member' },
              { key: 'member_email', label: 'Email' },
              { key: 'gift_name', label: 'Gift' },
              { key: 'gift_sku', label: 'SKU' },
              { key: 'status', label: 'Stage' },
              { key: 'address_on_file', label: 'Address', render: (r) => (r.address_on_file ? 'On file' : 'Missing') },
              { key: 'carrier', label: 'Carrier' },
              { key: 'tracking_number', label: 'Tracking' },
              { key: 'updated_at', label: 'Updated' },
            ]}
          />
        </>
      ) : null}

      {openRow ? (
        <FulfilmentDrawer
          row={openRow}
          piiVisible={piiVisible}
          onClose={() => setOpenRow(null)}
          onOpenMember={(id) => { setOpenRow(null); setMemberId(id); }}
        />
      ) : null}
      {memberId ? <Member360Drawer userId={memberId} onClose={() => setMemberId(null)} /> : null}
    </>
  );
}

function FulfilmentDrawer({ row, piiVisible, onClose, onOpenMember }) {
  const delivery = row.delivery && typeof row.delivery === 'object' ? row.delivery : null;
  return (
    <Drawer
      title={`Gift — ${text(row.member_name)}`}
      note={`${text(row.gift_name)} · ${text(row.status)}`}
      onClose={onClose}
    >
      {row.user_id ? (
        <div className="adm-filters">
          <button type="button" className="adm-btn adm-btn--small" onClick={() => onOpenMember(row.user_id)}>Member 360</button>
        </div>
      ) : null}
      <div className="admpa-stack">
        <div className="admpa-kv">
          <Kv k="Member">{text(row.member_name)}</Kv>
          <Kv k="Email">{text(row.member_email)}</Kv>
          <Kv k="Tier">{text(row.member_tier)}</Kv>
          <Kv k="Gift">{text(row.gift_name)}</Kv>
          <Kv k="SKU">{text(row.gift_sku)}</Kv>
          <Kv k="Unit cost">{money(row.unit_cost)}</Kv>
          <Kv k="Stage">{text(row.status)}</Kv>
          <Kv k="Reason">{text(row.reason)}</Kv>
          <Kv k="Nominated">{row.nominated_at ? fmtDate(row.nominated_at) : '—'}</Kv>
          <Kv k="Decided">{row.decided_at ? fmtDate(row.decided_at) : '—'}</Kv>
          <Kv k="Decision note">{text(row.decision_note)}</Kv>
          <Kv k="Notified">{row.notified_at ? fmtDate(row.notified_at) : '—'}</Kv>
          <Kv k="Accepted">{row.accepted_at ? fmtDate(row.accepted_at) : '—'}</Kv>
          <Kv k="Declined">{row.declined_at ? fmtDate(row.declined_at) : '—'}</Kv>
          <Kv k="Consent">{row.consent_at ? fmtDate(row.consent_at) : '—'}</Kv>
          <Kv k="Packed">{row.packed_at ? fmtDate(row.packed_at) : '—'}</Kv>
          <Kv k="Packing note">{text(row.packing_note)}</Kv>
          <Kv k="Shipped">{row.shipped_at ? fmtDate(row.shipped_at) : '—'}</Kv>
          <Kv k="Delivered">{row.delivered_at ? fmtDate(row.delivered_at) : '—'}</Kv>
          <Kv k="Completed">{row.completed_at ? fmtDate(row.completed_at) : '—'}</Kv>
          <Kv k="Failure reason">{text(row.failure_reason)}</Kv>
          <Kv k="Created">{fmtDate(row.created_at)}</Kv>
          <Kv k="Updated">{fmtDate(row.updated_at)}</Kv>
          <Kv k="Previous gifts">{text(row.previous_gifts_for_member)}</Kv>
        </div>

        <h3>Delivery</h3>
        {piiVisible && delivery ? (
          <div className="admpa-kv">
            <Kv k="Recipient">{text(delivery.recipient_name)}</Kv>
            <Kv k="Line 1">{text(delivery.address_line1)}</Kv>
            <Kv k="Line 2">{text(delivery.address_line2)}</Kv>
            <Kv k="City">{text(delivery.city)}</Kv>
            <Kv k="Region">{text(delivery.region)}</Kv>
            <Kv k="Postcode">{text(delivery.postcode)}</Kv>
            <Kv k="Country">{text(delivery.country)}</Kv>
            <Kv k="Phone">{text(delivery.phone)}</Kv>
          </div>
        ) : piiVisible ? (
          <p className="adm-note">No delivery address recorded for this gift.</p>
        ) : (
          <p className="adm-note">Address hidden for your role{row.address_masked ? ` (${text(row.address_masked)})` : ''}.</p>
        )}

        <div className="admpa-kv">
          <Kv k="Carrier">{text(row.carrier)}</Kv>
          <Kv k="Tracking number">{text(row.tracking_number)}</Kv>
          <Kv k="Tracking link">{row.tracking_url ? <a href={row.tracking_url} target="_blank" rel="noreferrer">open</a> : '—'}</Kv>
        </div>
      </div>
    </Drawer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. MEMBER 360 DRAWER
   ═══════════════════════════════════════════════════════════════════════════ */

const MEMBER_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'personal', label: 'Personal & Membership Details' },
  { key: 'tasks', label: 'Tasks & Progress' },
  { key: 'reflections', label: 'Reflections' },
  { key: 'sigma', label: 'Sigma Logs' },
  { key: 'nectar', label: 'Nectar & Impact' },
  { key: 'awards', label: 'Tokens/Badges/Milestones' },
  { key: 'jar', label: 'Honey Jar' },
  { key: 'collaborations', label: 'Collaborations' },
  { key: 'recognition', label: 'Recognition & Physical Gifts' },
  { key: 'support', label: 'Support History' },
  { key: 'audit', label: 'Internal Notes & Audit History' },
];

function OutstandingChips({ outstanding }) {
  const items = [
    ['Total', outstanding.total],
    ['Reviews', outstanding.reviews],
    ['Unreviewed reflections', outstanding.unreviewed_reflections],
    ['Unreviewed sigma', outstanding.unreviewed_sigma],
    ['Badges pending', outstanding.badges_pending],
    ['Open tickets', outstanding.open_tickets],
    ['Recognition awaiting member', outstanding.recognition_awaiting_member],
  ];
  return (
    <div className="admpa-chips">
      {items.map(([label, v]) => (
        <Pill key={label} tone={Number(v) > 0 ? 'warn' : 'ok'} title={label}>{label}: {Number(v) || 0}</Pill>
      ))}
    </div>
  );
}

function TabOverview({ p }) {
  const m = p.member || {};
  return (
    <div className="admpa-stack">
      <OutstandingChips outstanding={p.outstanding || {}} />
      <div className="admpa-kv">
        <Kv k="Nectar points">{text(m.nectar_points)}</Kv>
        <Kv k="Member tier">{text(m.member_tier)}</Kv>
        <Kv k="Tier">{text(m.tier)}</Kv>
        <Kv k="Status">{text(m.member_status)}</Kv>
        <Kv k="Current stage">{text(m.current_stage)}</Kv>
        <Kv k="User level">{text(m.user_level)}</Kv>
        <Kv k="Engagement">{text(m.engagement_level)}</Kv>
        <Kv k="Experience">{text(m.experience)}</Kv>
        <Kv k="CO2e saved">{text(m.total_co2e_saved)}</Kv>
        <Kv k="Tasks completed">{text(m.total_tasks_completed)}</Kv>
        <Kv k="Joined">{m.join_date ? fmtDate(m.join_date) : '—'}</Kv>
        <Kv k="Referrals">{text(m.referral_count)}</Kv>
        <Kv k="Public profile">{m.is_public ? 'Yes' : 'No'}</Kv>
      </div>
    </div>
  );
}

function TabPersonal({ p }) {
  const m = p.member || {};
  const masked = m.pii_masked === true;
  const pii = (v) => (masked ? 'Hidden for your role' : text(v));
  return (
    <div className="admpa-stack">
      {masked ? <p className="adm-note">Personally identifiable fields are masked for your role.</p> : null}
      <div className="admpa-kv">
        <Kv k="Member id"><span className="admpa-mono">{text(m.id)}</span></Kv>
        <Kv k="First name">{text(m.first_name)}</Kv>
        <Kv k="Last name">{text(m.last_name)}</Kv>
        <Kv k="Alias">{text(m.alias)}</Kv>
        <Kv k="Username">{text(m.username)}</Kv>
        <Kv k="Email">{text(m.email)}</Kv>
        <Kv k="Phone">{pii(m.phone_number)}</Kv>
        <Kv k="Address">{pii(m.address)}</Kv>
        <Kv k="Joined">{m.join_date ? fmtDate(m.join_date) : '—'}</Kv>
        <Kv k="Member tier">{text(m.member_tier)}</Kv>
        <Kv k="Tier">{text(m.tier)}</Kv>
        <Kv k="Status">{text(m.member_status)}</Kv>
        <Kv k="Current stage">{text(m.current_stage)}</Kv>
        <Kv k="Experience">{text(m.experience)}</Kv>
        <Kv k="User level">{text(m.user_level)}</Kv>
        <Kv k="Engagement">{text(m.engagement_level)}</Kv>
        <Kv k="Selected themes">{list(m.selected_themes)}</Kv>
        <Kv k="Public profile">{m.is_public ? 'Yes' : 'No'}</Kv>
        <Kv k="Referral code">{text(m.referral_code)}</Kv>
        <Kv k="Referral count">{text(m.referral_count)}</Kv>
      </div>
    </div>
  );
}

function TabTasks({ p }) {
  const t = p.tasks || {};
  return (
    <div className="admpa-stack">
      <div className="admpa-kv">
        <Kv k="Completed">{text(t.completed)}</Kv>
        <Kv k="In progress">{text(t.in_progress)}</Kv>
      </div>
      <h3>Recent tasks</h3>
      <DataTable
        rows={toArr(t.recent)}
        empty="No tasks recorded."
        columns={[
          { key: 'task_title', label: 'Task' },
          { key: 'stage', label: 'Stage' },
          { key: 'theme_id', label: 'Theme' },
          { key: 'status', label: 'Status' },
          { key: 'nectar_reward', label: 'Nectar' },
          { key: 'co2e_saved', label: 'CO2e' },
          { key: 'experience_level', label: 'Level' },
          { key: 'completed_at', label: 'Completed' },
          { key: 'evidence_url', label: 'Evidence', render: (r) => (r.evidence_url ? <a href={r.evidence_url} target="_blank" rel="noreferrer">open</a> : '—') },
        ]}
      />
      <h3>Themes</h3>
      <DataTable
        rows={toArr(t.themes)}
        empty="No theme activity."
        columns={[
          { key: 'theme_id', label: 'Theme' },
          { key: 'tasks_completed', label: 'Completed' },
          { key: 'last_activity_at', label: 'Last activity' },
        ]}
      />
    </div>
  );
}

function TabDmaicList({ rows, empty, showTask }) {
  if (!rows.length) return <div className="adm-empty">{empty}</div>;
  return (
    <div className="admpa-stack">
      {rows.map((r, i) => (
        <div className="adm-panel" key={String(r.id || i)}>
          <div className="admpa-kv">
            <Kv k="Submitted">{fmtDate(r.created_at || r.completed_at)}</Kv>
            {showTask ? <Kv k="Task">{text(r.task_title)}</Kv> : null}
            {showTask ? <Kv k="Stage">{text(r.task_stage)}</Kv> : null}
            <Kv k="Review status">{statusPill(r.review_status)}</Kv>
            {r.kind ? <Kv k="Kind">{text(r.kind)}</Kv> : null}
          </div>
          <DmaicBlocks row={r} />
        </div>
      ))}
    </div>
  );
}

function TabReflections({ p }) {
  return (
    <div className="admpa-stack">
      <p className="adm-note">Unreviewed reflections: {Number((p.outstanding || {}).unreviewed_reflections) || 0}</p>
      <TabDmaicList rows={toArr(p.reflections)} empty="No reflections recorded." showTask />
    </div>
  );
}

function TabSigma({ p }) {
  return (
    <div className="admpa-stack">
      <p className="adm-note">Unreviewed sigma logs: {Number((p.outstanding || {}).unreviewed_sigma) || 0}</p>
      <TabDmaicList rows={toArr(p.sigma_logs)} empty="No sigma logs recorded." showTask={false} />
    </div>
  );
}

function TabNectar({ p }) {
  const m = p.member || {};
  const n = p.nectar || {};
  return (
    <div className="admpa-stack">
      <div className="admpa-kv">
        <Kv k="Balance">{text(n.balance)}</Kv>
        <Kv k="Earned (total)">{text(n.earned_total)}</Kv>
        <Kv k="Reversed (total)">{text(n.reversed_total)}</Kv>
        <Kv k="CO2e saved">{text(m.total_co2e_saved)}</Kv>
      </div>
      <h3>Recent ledger</h3>
      <DataTable
        rows={toArr(n.recent)}
        empty="No nectar movements."
        columns={[
          { key: 'created_at', label: 'When' },
          { key: 'delta', label: 'Delta' },
          { key: 'balance_after', label: 'Balance after' },
          { key: 'reason', label: 'Reason' },
          { key: 'category', label: 'Category' },
          { key: 'source', label: 'Source' },
          { key: 'actor_email', label: 'Actor' },
        ]}
      />
    </div>
  );
}

function TabAwards({ p }) {
  const a = p.awards || {};
  return (
    <div className="admpa-stack">
      <p className="adm-note">Badges pending review: {Number((p.outstanding || {}).badges_pending) || 0}</p>
      <h3>Tokens</h3>
      <DataTable
        rows={toArr(a.tokens)}
        empty="No tokens."
        columns={[
          { key: 'name', label: 'Token' },
          { key: 'theme_id', label: 'Theme' },
          { key: 'stage', label: 'Stage' },
          { key: 'awarded_at', label: 'Awarded' },
          { key: 'viewed', label: 'Viewed', render: (r) => (r.viewed ? 'Yes' : 'No') },
        ]}
      />
      <h3>Milestones</h3>
      <DataTable
        rows={toArr(a.milestones)}
        empty="No milestones."
        columns={[
          { key: 'name', label: 'Milestone' },
          { key: 'achieved_at', label: 'Achieved' },
          { key: 'viewed', label: 'Viewed', render: (r) => (r.viewed ? 'Yes' : 'No') },
        ]}
      />
      <h3>Badges</h3>
      <DataTable
        rows={toArr(a.badges)}
        empty="No badges."
        columns={[
          { key: 'name', label: 'Badge' },
          { key: 'current_stage', label: 'Stage' },
          { key: 'total_stages', label: 'Of stages' },
          { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
          { key: 'submitted_at', label: 'Submitted' },
          { key: 'approved_at', label: 'Approved' },
        ]}
      />
    </div>
  );
}

function TabJar({ p }) {
  return (
    <DataTable
      rows={toArr(p.jar)}
      empty="No honey jar deposits."
      columns={[
        { key: 'created_at', label: 'Deposited' },
        { key: 'x_pos', label: 'X' },
        { key: 'y_pos', label: 'Y' },
        { key: 'scale', label: 'Scale' },
        { key: 'rotation', label: 'Rotation' },
        { key: 'token_id', label: 'Token' },
        { key: 'milestone_id', label: 'Milestone' },
      ]}
    />
  );
}

function TabCollaborations({ p }) {
  const c = p.collaborations || {};
  return (
    <div className="admpa-stack">
      <div className="admpa-kv">
        <Kv k="Partners">{text(c.partners)}</Kv>
        <Kv k="Invites sent">{text(toArr(c.invites_sent).length)}</Kv>
        <Kv k="Invites received">{text(toArr(c.invites_received).length)}</Kv>
      </div>
      <h3>Invites sent</h3>
      <DataTable
        rows={toArr(c.invites_sent)}
        empty="No invites sent."
        columns={[
          { key: 'invitee_email', label: 'Invitee' },
          { key: 'status', label: 'Status' },
          { key: 'created_at', label: 'Sent' },
          { key: 'expires_at', label: 'Expires' },
        ]}
      />
      <h3>Invites received</h3>
      <DataTable
        rows={toArr(c.invites_received)}
        empty="No invites received."
        columns={[
          { key: 'inviter_id', label: 'Inviter' },
          { key: 'status', label: 'Status' },
          { key: 'created_at', label: 'Received' },
          { key: 'expires_at', label: 'Expires' },
        ]}
      />
    </div>
  );
}

function TabRecognition({ p }) {
  const o = p.outstanding || {};
  return (
    <div className="admpa-stack">
      <div className="admpa-kv">
        <Kv k="Recognition awaiting member">{text(o.recognition_awaiting_member)}</Kv>
      </div>
      <div className="adm-empty">
        This member view does not include recognition or physical-gift rows; the member 360 payload returns none.
        Use the Gift fulfilment screen for the delivery pipeline and queue.
      </div>
    </div>
  );
}

function TabSupport({ p }) {
  const s = p.support || {};
  return (
    <div className="admpa-stack">
      <p className="adm-note">Open tickets: {Number((p.outstanding || {}).open_tickets) || 0}</p>
      <DataTable
        rows={toArr(s.tickets)}
        empty="No support tickets."
        columns={[
          { key: 'ticket_no', label: 'Ticket' },
          { key: 'subject', label: 'Subject' },
          { key: 'status', label: 'Status' },
          { key: 'priority', label: 'Priority', render: (r) => <Pill tone={priorityTone(r.priority)}>{text(r.priority)}</Pill> },
          { key: 'category', label: 'Category' },
          { key: 'message_count', label: 'Msgs' },
          { key: 'created_at', label: 'Created' },
          { key: 'resolved_at', label: 'Resolved' },
          { key: 'sla_due_at', label: 'SLA due' },
        ]}
      />
    </div>
  );
}

function TabAudit({ p }) {
  const a = p.audit || {};
  return (
    <div className="admpa-stack">
      <h3>Internal notes</h3>
      <DataTable
        rows={toArr(a.notes)}
        empty="No internal notes."
        columns={[
          { key: 'created_at', label: 'When' },
          { key: 'kind', label: 'Kind' },
          { key: 'from_status', label: 'From' },
          { key: 'to_status', label: 'To' },
          { key: 'body', label: 'Note' },
          { key: 'actor_email', label: 'Actor' },
        ]}
      />
      <h3>Admin actions</h3>
      <DataTable
        rows={toArr(a.admin_actions)}
        empty="No admin actions."
        columns={[
          { key: 'created_at', label: 'When' },
          { key: 'action', label: 'Action' },
          { key: 'target_type', label: 'Target' },
          { key: 'target_id', label: 'Target id' },
          { key: 'reason', label: 'Reason' },
          { key: 'actor_email', label: 'Actor' },
        ]}
      />
    </div>
  );
}

function renderMemberTab(tab, p) {
  switch (tab) {
    case 'overview': return <TabOverview p={p} />;
    case 'personal': return <TabPersonal p={p} />;
    case 'tasks': return <TabTasks p={p} />;
    case 'reflections': return <TabReflections p={p} />;
    case 'sigma': return <TabSigma p={p} />;
    case 'nectar': return <TabNectar p={p} />;
    case 'awards': return <TabAwards p={p} />;
    case 'jar': return <TabJar p={p} />;
    case 'collaborations': return <TabCollaborations p={p} />;
    case 'recognition': return <TabRecognition p={p} />;
    case 'support': return <TabSupport p={p} />;
    case 'audit': return <TabAudit p={p} />;
    default: return null;
  }
}

function memberTabCounts(p) {
  const o = p.outstanding || {};
  const a = p.awards || {};
  const c = p.collaborations || {};
  return {
    overview: Number(o.total) || 0,
    tasks: toArr((p.tasks || {}).recent).length,
    reflections: toArr(p.reflections).length,
    sigma: toArr(p.sigma_logs).length,
    nectar: toArr((p.nectar || {}).recent).length,
    awards: toArr(a.tokens).length + toArr(a.milestones).length + toArr(a.badges).length,
    jar: toArr(p.jar).length,
    collaborations: (Number(c.partners) || 0) + toArr(c.invites_sent).length + toArr(c.invites_received).length,
    recognition: Number(o.recognition_awaiting_member) || 0,
    support: toArr((p.support || {}).tickets).length,
    audit: toArr((p.audit || {}).notes).length + toArr((p.audit || {}).admin_actions).length,
  };
}

export function Member360Drawer({ userId, onClose }) {
  const [tab, setTab] = useState('overview');
  const q = useApi(() => rpc('admin_get_member_360', { p_user_id: userId }), [userId], !!userId);
  const p = useMemo(() => raw(q.data), [q.data]);
  const member = p.member || {};
  const outstanding = p.outstanding || {};
  const counts = useMemo(() => memberTabCounts(p), [p]);
  const outstandingTotal = Number(outstanding.total) || 0;

  return (
    <Drawer title="Member 360" note="Read only." onClose={onClose}>
      {q.error ? <div className="adm-error">Could not load: {q.error}</div> : null}
      {q.loading ? <div className="adm-empty">Loading member…</div> : null}

      {!q.loading && !q.error ? (
        <>
          <div className="admpa-identity">
            {member.avatar_url ? (
              <img className="admpa-avatar" src={member.avatar_url} alt="" />
            ) : (
              <div className="admpa-avatar admpa-avatar--empty">no photo</div>
            )}
            <div>
              <h2>
                {whoName(member)}
                {' '}
                <span className={`admpa-outstanding${outstandingTotal === 0 ? ' admpa-outstanding--zero' : ''}`}>
                  {outstandingTotal} outstanding
                </span>
              </h2>
              <p>{text(member.email)}{member.username ? ` · @${member.username}` : ''}{member.alias ? ` · ${member.alias}` : ''}</p>
              <div className="admpa-identity-chips">
                {member.member_status ? <Pill tone="off">{text(member.member_status)}</Pill> : null}
                {member.member_tier ? <Pill tone="ok">{text(member.member_tier)}</Pill> : null}
                {member.tier ? <Pill tone="off">{text(member.tier)}</Pill> : null}
                {member.current_stage ? <Pill tone="off">{text(member.current_stage)}</Pill> : null}
              </div>
            </div>
          </div>

          <nav className="admpa-tabs">
            {MEMBER_TABS.map((t) => (
              <button key={t.key} type="button"
                className={`admpa-tab${tab === t.key ? ' is-active' : ''}`}
                onClick={() => setTab(t.key)}>
                {t.label}
                {counts[t.key] !== undefined ? (
                  <span className={`admpa-tab-count${counts[t.key] > 0 ? ' admpa-tab-count--alert' : ''}`}>{counts[t.key]}</span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="admpa-tab-body">{renderMemberTab(tab, p)}</div>
        </>
      ) : null}
    </Drawer>
  );
}
