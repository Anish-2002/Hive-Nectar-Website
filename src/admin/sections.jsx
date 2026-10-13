import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { rpc, rows, obj, raw, rawList, fmtDate, fmtDay, text, cleanPayload, slugifyFile, uploadPublic } from './api.js';
// Loaded on demand: sections-phase-a.jsx imports SectionHead from this file, so a static
// import here (and again there) would close an import cycle.
const Member360Drawer = lazy(() => import('./sections-phase-a.jsx').then((m) => ({ default: m.Member360Drawer })));

/* ═══════════════════════════ shared pieces ═══════════════════════════ */

export function SectionHead({ title, note, actions }) {
  return (
    <div className="adm-head">
      <div>
        <h2>{title}</h2>
        {note ? <p>{note}</p> : null}
      </div>
      {actions ? <div className="adm-actions">{actions}</div> : null}
    </div>
  );
}

function useLoader(load, deps = [], enabled = true) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

export function RawTable({ list, columns, onDelete, deleteLabel = 'Delete', empty = 'Nothing here yet.', onRowClick }) {
  if (!list || !list.length) return <div className="adm-empty">{empty}</div>;
  const cols = columns || Object.keys(list[0]).slice(0, 9);
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <thead>
          <tr>
            {cols.map((c) => <th key={c}>{String(c).replace(/_/g, ' ')}</th>)}
            {onDelete ? <th>actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {list.map((row, i) => (
            <tr key={row.id ?? row.uuid ?? row.key ?? i}
                className={onRowClick ? 'is-clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {cols.map((c) => {
                const v = row[c];
                const isDate = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
                const long = typeof v === 'string' && v.length > 70;
                return <td key={c} className={long ? 'wrap' : undefined}>{isDate ? fmtDate(v) : text(v)}</td>;
              })}
              {onDelete ? (
                <td>
                  <button className="adm-btn adm-btn--small adm-btn--danger"
                          onClick={(e) => { e.stopPropagation(); onDelete(row); }}>
                    {deleteLabel}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldInput({ f, value, onChange, ctx }) {
  if (f.type === 'checkbox') {
    return (
      <div className="adm-field adm-check">
        <input type="checkbox" checked={!!value} id={`f-${f.k}`} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={`f-${f.k}`}>{f.label || f.k.replace(/_/g, ' ')}</label>
      </div>
    );
  }
  if (f.type === 'file') {
    const isFile = typeof File !== 'undefined' && value instanceof File;
    const preview = !isFile && typeof value === 'string' && value ? value : null;
    return (
      <div className="adm-field adm-field--wide">
        <label htmlFor={`f-${f.k}`}>{f.label || f.k.replace(/_/g, ' ')}{f.required ? ' *' : ''}</label>
        <div className="adm-file-row">
          {preview
            ? <img src={preview} alt="" className="adm-file-thumb" />
            : <div className="adm-file-thumb adm-file-thumb--empty">{isFile ? 'new' : 'none'}</div>}
          <div className="adm-file-controls">
            <input id={`f-${f.k}`}
                   type="file"
                   accept={f.accept || 'image/*'}
                   onChange={(e) => onChange(e.target.files && e.target.files[0] ? e.target.files[0] : null)} />
            <span className="adm-note">
              {isFile
                ? `${value.name} — uploaded to ${f.bucket} when you save.`
                : (f.help || `Uploads to the ${f.bucket} bucket and stores the public URL, the same shape the member site already reads.`)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  let options = null;
  if (f.type === 'select') {
    options = typeof f.options === 'function' ? f.options(ctx) : f.options;
  }
  const wide = f.type === 'textarea' || f.wide;
  return (
    <div className={`adm-field${wide ? ' adm-field--wide' : ''}`}>
      <label htmlFor={`f-${f.k}`}>{f.label || f.k.replace(/_/g, ' ')}{f.required ? ' *' : ''}</label>
      {f.type === 'select' ? (
        <select id={`f-${f.k}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(options || []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea id={`f-${f.k}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={`f-${f.k}`}
               type={f.type || 'text'}
               step={f.step}
               value={value ?? ''}
               onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function FormModal({ title, note, fields, values, onChange, onClose, onSave, saving, error, ctx }) {
  return (
    <div className="adm-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div>
        <div className="adm-head">
          <div>
            <h2>{title}</h2>
            {note ? <p>{note}</p> : null}
          </div>
          <div className="adm-actions">
            <button className="adm-btn" onClick={onClose}>Cancel</button>
            <button className="adm-btn adm-btn--primary" onClick={onSave} disabled={saving}>
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
        </div>
        {error ? <div className="adm-error" style={{ marginBottom: 12 }}>{error}</div> : null}
        <div className="adm-form">
          {fields.map((f) => (
            <FieldInput key={f.k} f={f} value={values[f.k]}
                        onChange={(v) => onChange(f.k, v)} ctx={ctx} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════ overview ═══════════════════════════ */

export function OverviewSection() {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_stats'));
  const stats = obj(data);
  return (
    <>
      <SectionHead
        title="Overview"
        note="Counts come from admin_get_stats(), computed in the database over live rows. Nothing here is cached or mirrored."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? <div className="adm-error">{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : (
        <div className="adm-cards">
          {Object.entries(stats).map(([k, v]) => (
            <div className="adm-card" key={k}>
              <div className="k">{k.replace(/_/g, ' ')}</div>
              <div className="v">{typeof v === 'number' ? v.toLocaleString() : text(v)}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════ generic CRUD ═══════════════════════════ */

const THEME_OPTIONS = ({ extras }) =>
  (extras.themes || []).map((t) => ({ value: t.theme_id, label: `${t.theme_id} — ${t.theme_name}` }));

const STAGE_OPTIONS = ({ list }) =>
  [...new Set(list.map((t) => t.stage).filter(Boolean))].map((s) => ({ value: s, label: s }));

/* ── storage paths ───────────────────────────────────────────────────────────
   The buckets already in use keep a folder per theme / category, so an upload
   is placed beside its siblings rather than in a flat pile:
     Token/<Theme name>/<Stage>/<file>      Badges/<Category>/<file>
   When the row already points at a file in that bucket, its folder is reused,
   which is what makes replacing an existing image behave. */
const bucketDir = (url, bucket) => {
  if (typeof url !== 'string') return null;
  const m = url.match(new RegExp(`/object/public/${bucket}/(.+)/[^/]+$`));
  return m ? decodeURIComponent(m[1]) : null;
};

const tokenDir = (values, row, ctx) => {
  const keep = bucketDir(row && row.icon_url, 'Token') || bucketDir(values.icon_url, 'Token');
  if (keep) return keep;
  const theme = ((ctx && ctx.themes) || []).find((t) => t.theme_id === values.theme_id);
  return `${(theme && theme.theme_name) || values.theme_id || 'Unassigned'}/${values.stage || 'Seed'}`;
};

const badgeDir = (values, row) => {
  const keep = bucketDir(row && row.icon_url, 'Badges') || bucketDir(values.icon_url, 'Badges');
  return keep || values.category || 'Uncategorised';
};

const ENTITIES = {
  tasks: {
    title: 'Tasks',
    note: 'Saved through admin_save_task(). Every field below maps to a column the RPC accepts; blank fields are omitted so existing values are left untouched.',
    list: 'admin_get_tasks',
    save: 'admin_save_task',
    remove: 'admin_delete_task',
    removeArg: 'p_task_id',
    primaryKey: 'id',
    label: (r) => r.task_title || r.task_id,
    columns: ['task_id', 'task_title', 'theme_id', 'stage', 'nectar_reward', 'task_order', 'active'],
    fields: [
      { k: 'task_title', label: 'task_title', required: true },
      { k: 'task_id', label: 'task_id (label, e.g. TA-151)' },
      { k: 'theme_id', type: 'select', options: THEME_OPTIONS },
      { k: 'stage', type: 'select', options: STAGE_OPTIONS },
      { k: 'core_theme' },
      { k: 'category' },
      { k: 'nectar_reward', type: 'number' },
      { k: 'task_order', type: 'number' },
      { k: 'required_level', type: 'number' },
      { k: 'audience' },
      { k: 'task_group' },
      { k: 'core_task' },
      { k: 'impact_type' },
      { k: 'impact_unit' },
      { k: 'impact_unit_value', type: 'number', step: 'any' },
      { k: 'impact_base_value', type: 'number', step: 'any' },
      { k: 'impact_value' },
      { k: 'source_url' },
      { k: 'event_tag' },
      { k: 'task_description', type: 'textarea' },
      { k: 'novice_description', type: 'textarea' },
      { k: 'experienced_description', type: 'textarea' },
      { k: 'examples', type: 'textarea' },
      { k: 'available_from', type: 'datetime-local' },
      { k: 'available_to', type: 'datetime-local' },
      { k: 'active', type: 'checkbox' },
    ],
  },
  themes: {
    title: 'Themes',
    note: 'Saved through admin_save_theme(). theme_id is the primary key — changing it on an existing theme creates a second theme instead of renaming.',
    list: 'admin_get_themes',
    save: 'admin_save_theme',
    remove: 'admin_delete_theme',
    removeArg: 'p_theme_id',
    primaryKey: 'theme_id',
    label: (r) => r.theme_name || r.theme_id,
    columns: ['theme_id', 'theme_name', 'min_tier', 'bucket_folder', 'token_series_family'],
    fields: [
      { k: 'theme_id', label: 'theme_id', required: true },
      { k: 'theme_name', label: 'theme_name' },
      { k: 'min_tier', label: 'min_tier', type: 'number' },
      { k: 'primary_color', label: 'primary_color (#RRGGBB)' },
      { k: 'secondary_color', label: 'secondary_color (#RRGGBB)' },
      { k: 'token_series_family', label: 'token_series_family' },
      { k: 'bucket_folder', label: 'bucket_folder' },
      { k: 'purpose', label: 'purpose', type: 'textarea' },
      { k: 'visual_symbol_icon_idea', label: 'visual_symbol_icon_idea', type: 'textarea' },
    ],
  },
  tokens: {
    title: 'Tokens',
    note: 'Saved through admin_save_token(). Tokens are never deleted from a member here — that is on the member detail panel, and it removes the award, not the token.',
    list: 'admin_get_tokens',
    save: 'admin_save_token',
    remove: 'admin_delete_token',
    removeArg: 'p_token_id',
    primaryKey: 'id',
    label: (r) => r.name,
    columns: ['name', 'theme_id', 'stage', 'tasks_required', 'active'],
    fields: [
      { k: 'name', required: true },
      { k: 'theme_id', type: 'select', options: THEME_OPTIONS },
      { k: 'stage', type: 'select', options: STAGE_OPTIONS },
      { k: 'tasks_required', type: 'number' },
      {
        k: 'icon_url',
        type: 'file',
        label: 'artwork',
        bucket: 'Token',
        help: 'Uploads to the Token bucket; the public URL is written into icon_url. Replacing keeps the file in the same theme/stage folder.',
        path: ({ file, values, row, ctx }) => `${tokenDir(values, row, ctx)}/${slugifyFile(file.name)}`,
      },
      { k: 'description', type: 'textarea' },
      { k: 'active', type: 'checkbox' },
    ],
  },
  milestones: {
    title: 'Milestones',
    note: 'Saved through admin_save_milestone(). category and reward_type are free text — the value sets already in use are shown as suggestions.',
    list: 'admin_get_milestones',
    save: 'admin_save_milestone',
    remove: 'admin_delete_milestone',
    removeArg: 'p_milestone_id',
    primaryKey: 'id',
    label: (r) => r.name,
    columns: ['id', 'name', 'category', 'requirement_value', 'reward_type', 'reward_value', 'active'],
    fields: [
      { k: 'name', required: true },
      { k: 'category', type: 'select', options: ({ list }) => [...new Set(list.map((m) => m.category).filter(Boolean))].map((s) => ({ value: s, label: s })) },
      { k: 'requirement_value', type: 'number' },
      { k: 'reward_type', type: 'select', options: ({ list }) => [...new Set(list.map((m) => m.reward_type).filter(Boolean))].map((s) => ({ value: s, label: s })) },
      { k: 'reward_value' },
      {
        k: 'icon_url',
        type: 'file',
        label: 'badge artwork',
        bucket: 'Badges',
        help: 'Uploads to the Badges bucket; the public URL is written into icon_url. Replacing keeps the file in the same category folder.',
        path: ({ file, values, row }) => `${badgeDir(values, row)}/${slugifyFile(file.name)}`,
      },
      { k: 'description', type: 'textarea' },
      { k: 'active', type: 'checkbox' },
    ],
  },

  /* ── website content ─────────────────────────────────────────────────
     The five member-visible content tables (hub_content, navigation_menu,
     social_links, policy_briefs, founders). They share one RPC pair, so the
     kind travels in p_kind and the database picks the table; the field names
     below are the live column names for each kind. There was no admin path
     for any of this before, so a wrong nav label used to mean editing
     production data by hand. */
  hub: {
    title: 'Hub items',
    note: 'Media on the public hub (hub_content). Saved through admin_save_site_item(); title, category_slug and source_url are required. Lower order_index sorts first.',
    list: 'admin_get_site_content',
    listArgs: { p_kind: 'hub' },
    save: 'admin_save_site_item',
    saveArgs: { p_kind: 'hub' },
    remove: 'admin_delete_site_item',
    removeArgs: (row) => ({ p_kind: 'hub', p_id: row.id }),
    primaryKey: 'id',
    label: (r) => r.title,
    columns: ['title', 'category_slug', 'media_type', 'order_index', 'source_url'],
    fields: [
      { k: 'title', required: true },
      { k: 'category_slug', required: true },
      { k: 'source_url', required: true },
      { k: 'media_type' },
      { k: 'thumbnail_url' },
      { k: 'description', type: 'textarea' },
      { k: 'order_index', type: 'number' },
    ],
  },
  nav: {
    title: 'Navigation menu',
    note: 'The site navigation (navigation_menu). label and path are required. Unticking is_active hides the entry from every visitor.',
    list: 'admin_get_site_content',
    listArgs: { p_kind: 'nav' },
    save: 'admin_save_site_item',
    saveArgs: { p_kind: 'nav' },
    remove: 'admin_delete_site_item',
    removeArgs: (row) => ({ p_kind: 'nav', p_id: row.id }),
    primaryKey: 'id',
    label: (r) => r.label,
    columns: ['label', 'path', 'icon', 'order_index', 'is_active'],
    fields: [
      { k: 'label', required: true },
      { k: 'path', required: true },
      { k: 'icon' },
      { k: 'order_index', type: 'number' },
      { k: 'is_active', type: 'checkbox' },
    ],
  },
  social: {
    title: 'Social links',
    note: 'Footer and contact links (social_links). name and url are required.',
    list: 'admin_get_site_content',
    listArgs: { p_kind: 'social' },
    save: 'admin_save_site_item',
    saveArgs: { p_kind: 'social' },
    remove: 'admin_delete_site_item',
    removeArgs: (row) => ({ p_kind: 'social', p_id: row.id }),
    primaryKey: 'id',
    label: (r) => r.name,
    columns: ['name', 'url', 'icon', 'order_index', 'is_active'],
    fields: [
      { k: 'name', required: true },
      { k: 'url', required: true },
      { k: 'icon' },
      { k: 'description' },
      { k: 'order_index', type: 'number' },
      { k: 'is_active', type: 'checkbox' },
    ],
  },
  policy: {
    title: 'Policy briefs',
    note: 'Published documents (policy_briefs). name is required; status defaults to published on a new entry.',
    list: 'admin_get_site_content',
    listArgs: { p_kind: 'policy' },
    save: 'admin_save_site_item',
    saveArgs: { p_kind: 'policy' },
    remove: 'admin_delete_site_item',
    removeArgs: (row) => ({ p_kind: 'policy', p_id: row.id }),
    primaryKey: 'id',
    label: (r) => r.name,
    columns: ['doc_id', 'name', 'status', 'short_description'],
    fields: [
      { k: 'name', required: true },
      { k: 'doc_id' },
      { k: 'status' },
      { k: 'short_description', type: 'textarea' },
      { k: 'file_url' },
      { k: 'source_url' },
    ],
  },
  founder: {
    title: 'Founders',
    note: 'Founder profiles (founders). name, position and bio are required.',
    list: 'admin_get_site_content',
    listArgs: { p_kind: 'founder' },
    save: 'admin_save_site_item',
    saveArgs: { p_kind: 'founder' },
    remove: 'admin_delete_site_item',
    removeArgs: (row) => ({ p_kind: 'founder', p_id: row.id }),
    primaryKey: 'id',
    label: (r) => r.name,
    columns: ['name', 'position', 'order_index'],
    fields: [
      { k: 'name', required: true },
      { k: 'position', required: true },
      { k: 'bio', type: 'textarea', required: true },
      { k: 'avatar_url' },
      { k: 'order_index', type: 'number' },
    ],
  },
};

export function CrudSection({ entity, notify }) {
  const cfg = ENTITIES[entity];
  const { loading, data, error, reload } = useLoader(() => rpc(cfg.list, cfg.listArgs || {}));
  const list = useMemo(() => rows(data), [data]);
  // Themes feed two things: the task form's theme picker and the folder an
  // uploaded token image lands in (Token/<theme name>/<stage>/), so they are
  // loaded for tokens as well.
  const { data: themeData } = useLoader(() => rpc('admin_get_themes'), [], ['tasks', 'tokens'].includes(entity));
  const extras = { themes: rows(themeData) };
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const filtered = useMemo(() => {
    if (!q.trim()) return list;
    const needle = q.trim().toLowerCase();
    return list.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }, [list, q]);

  const openNew = () => { setFormError(null); setEditing({ values: {} }); };
  const openEdit = (row) => {
    setFormError(null);
    const values = {};
    for (const f of cfg.fields) {
      const v = row[f.k];
      if (v === null || v === undefined) continue;
      values[f.k] = f.type === 'datetime-local' && typeof v === 'string' ? v.slice(0, 16) : v;
    }
    setEditing({ values, row });
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const values = { ...editing.values };
      // File fields upload BEFORE the save RPC runs, so a storage failure is
      // reported here instead of writing a row that points at nothing. The put
      // is authorised by the bucket's admin policy, and the resulting public URL
      // goes into the same column the member site already reads.
      for (const f of cfg.fields) {
        if (f.type !== 'file') continue;
        const chosen = values[f.k];
        if (!(typeof File !== 'undefined' && chosen instanceof File)) continue;
        const path = typeof f.path === 'function'
          ? f.path({ file: chosen, row: editing.row, values, ctx: extras })
          : slugifyFile(chosen.name);
        values[f.k] = await uploadPublic(f.bucket, path, chosen);
      }
      const payload = cleanPayload(values);
      // The save RPCs decide update-versus-insert on the primary key carried
      // inside p_data, and that key is deliberately not a form field (nobody
      // should retype a uuid). It has to be carried over from the row that was
      // clicked: without it, saving an edit inserts a duplicate instead.
      if (cfg.primaryKey && editing.row) {
        const v = editing.row[cfg.primaryKey];
        if (v !== null && v !== undefined && v !== '') payload[cfg.primaryKey] = v;
      }
      const res = await rpc(cfg.save, { ...(cfg.saveArgs || {}), p_data: payload });
      notify(`${cfg.title}: saved`, 'ok');
      setEditing(null);
      reload();
      return res;
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
    return null;
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete ${cfg.label(row)}? This cannot be undone.`)) return;
    try {
      const args = typeof cfg.removeArgs === 'function'
        ? cfg.removeArgs(row)
        : { [cfg.removeArg]: row[cfg.primary || 'id'] ?? row.id };
      await rpc(cfg.remove, args);
      notify(`${cfg.title}: deleted`, 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  return (
    <>
      <SectionHead
        title={cfg.title}
        note={cfg.note}
        actions={
          <>
            <button className="adm-btn" onClick={reload}>Refresh</button>
            <button className="adm-btn adm-btn--primary" onClick={openNew}>New</button>
          </>
        }
      />
      {error ? <div className="adm-error">{error}</div> : null}
      <div className="adm-filters">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${cfg.title.toLowerCase()}…`} />
        <span className="adm-note">{filtered.length} of {list.length}</span>
      </div>
      {loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable list={filtered} columns={cfg.columns} onDelete={remove} onRowClick={openEdit} />
      )}
      {editing ? (
        <FormModal
          title={editing.row
            ? `Edit ${cfg.title.replace(/s$/, '')}`
            : `New ${cfg.title.replace(/s$/, '')}`}
          note={cfg.note}
          fields={cfg.fields}
          values={editing.values}
          ctx={{ list, extras }}
          onChange={(k, v) => setEditing((s) => ({ values: { ...s.values, [k]: v } }))}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
          error={formError}
        />
      ) : null}
    </>
  );
}

/* ═══════════════════════════ members ═══════════════════════════ */

const TIERS = ['free', 'plus', 'steward', 'collective'];

function MemberDrawer({ userId, onClose, notify, onChanged }) {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_user', { p_user_id: userId }), [userId]);
  const detail = obj(data);
  const profile = detail.profile || {};
  const [edit, setEdit] = useState(null);
  const [points, setPoints] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [open360, setOpen360] = useState(false);

  const memberFields = [
    { k: 'first_name' }, { k: 'last_name' }, { k: 'username' },
    { k: 'email' },
    { k: 'tier', type: 'select', options: TIERS.map((t) => ({ value: t, label: t })) },
    { k: 'member_tier', type: 'number' },
    { k: 'member_status' },
    { k: 'user_level' },
    { k: 'engagement_level' },
    { k: 'subscription_status' },
    { k: 'subscription_tier' },
    { k: 'phone_number' },
    { k: 'address' },
    { k: 'prefers_experienced', type: 'checkbox' },
  ];

  const openEdit = () => {
    const values = {};
    for (const f of memberFields) {
      const v = profile[f.k];
      if (v === null || v === undefined) continue;
      values[f.k] = v;
    }
    setFormError(null);
    setEdit({ values });
  };

  const saveEdit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      await rpc('admin_update_user', { p_user_id: userId, p_data: cleanPayload(edit.values) });
      notify('Member updated', 'ok');
      setEdit(null);
      reload();
      onChanged?.();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const savePoints = async () => {
    setSaving(true);
    try {
      const args = { p_user_id: userId };
      if (points.nectar !== '' && points.nectar !== undefined) args.p_nectar = Number(points.nectar);
      if (points.co2e !== '' && points.co2e !== undefined) args.p_co2e = Number(points.co2e);
      await rpc('admin_set_points', args);
      notify('Points set — this writes the absolute value, not a delta', 'ok');
      setPoints(null);
      reload();
      onChanged?.();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async () => {
    const confirmText = window.prompt(`Type the member's email to confirm deletion:`, '');
    if (confirmText === null) return;
    if (confirmText.trim().toLowerCase() !== String(profile.email || '').toLowerCase()) {
      notify('Email did not match — nothing deleted', 'error');
      return;
    }
    try {
      await rpc('admin_delete_user', { p_user_id: userId });
      notify('Member deleted', 'ok');
      onChanged?.();
      onClose();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const drop = async (fn, args, label) => {
    if (!window.confirm(`${label}?`)) return;
    try {
      await rpc(fn, args);
      notify('Removed', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const tasks = detail.tasks || [];
  const tokens = detail.tokens || [];
  const milestones = detail.milestones || [];
  const progress = detail.theme_progress || [];
  const sigmas = detail.sigma_logs || [];
  const decorations = detail.jar_decorations || [];
  const collabs = detail.collaborations || [];

  return (
    <div className="adm-drawer">
      <div className="adm-head">
        <div>
          <h2>{profile.first_name || profile.username || profile.email || 'Member'}</h2>
          <p>{profile.email} · joined {fmtDay(profile.join_date)} · id <code>{userId}</code></p>
        </div>
        <div className="adm-actions">
          <button className="adm-btn" onClick={() => setOpen360(true)}>360 profile</button>
          <button className="adm-btn" onClick={onClose}>Close</button>
        </div>
      </div>

      {error ? <div className="adm-error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : null}

      {!loading && (
        <>
          <div className="adm-cards">
            <div className="adm-card"><div className="k">tier</div><div className="v" style={{ fontSize: '1.05rem' }}>{text(profile.tier)}</div></div>
            <div className="adm-card"><div className="k">member_tier</div><div className="v">{text(profile.member_tier)}</div></div>
            <div className="adm-card"><div className="k">nectar_points</div><div className="v">{text(profile.nectar_points)}</div></div>
            <div className="adm-card"><div className="k">tasks completed</div><div className="v">{text(profile.total_tasks_completed)}</div></div>
            <div className="adm-card"><div className="k">co2e saved</div><div className="v" style={{ fontSize: '1.05rem' }}>{text(profile.total_co2e_saved)}</div></div>
            <div className="adm-card"><div className="k">subscription</div><div className="v" style={{ fontSize: '1.05rem' }}>{text(profile.subscription_status)}</div></div>
          </div>

          <div className="adm-panel">
            <div className="adm-head" style={{ marginBottom: 8 }}>
              <div><h2 style={{ fontSize: '1rem' }}>Actions</h2></div>
              <div className="adm-actions">
                <button className="adm-btn adm-btn--small" onClick={openEdit}>Edit details</button>
                <button className="adm-btn adm-btn--small" onClick={() => setPoints({ nectar: profile.nectar_points ?? '', co2e: '' })}>Set points</button>
                <button className="adm-btn adm-btn--small adm-btn--danger" onClick={removeUser}>Delete member</button>
              </div>
            </div>
            <p className="adm-note">
              Set points uses admin_set_points(), which writes the absolute nectar and CO2e values.
              Delete removes the profile row and is not reversible.
            </p>
            {points ? (
              <div className="adm-form" style={{ marginTop: 10 }}>
                <div className="adm-field">
                  <label htmlFor="pt-nectar">nectar points (absolute)</label>
                  <input id="pt-nectar" type="number" value={points.nectar}
                         onChange={(e) => setPoints((s) => ({ ...s, nectar: e.target.value }))} />
                </div>
                <div className="adm-field">
                  <label htmlFor="pt-co2e">total co2e saved (optional)</label>
                  <input id="pt-co2e" type="number" step="any" value={points.co2e}
                         onChange={(e) => setPoints((s) => ({ ...s, co2e: e.target.value }))} />
                </div>
                <div className="adm-field" style={{ justifyContent: 'flex-end' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="adm-btn" onClick={() => setPoints(null)}>Cancel</button>
                    <button className="adm-btn adm-btn--primary" onClick={savePoints} disabled={saving}>Apply</button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="adm-panel">
            <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Completed tasks ({tasks.length})</h2>
            <RawTable
              list={tasks.slice(0, 40)}
              columns={['task_id', 'version', 'completed_at']}
              empty="No completed tasks."
              deleteLabel="Revoke"
              onDelete={(r) => drop('admin_delete_user_task', { p_user_id: userId, p_task_id: r.task_id }, 'Revoke this task completion')}
            />
          </div>

          <div className="adm-split">
            <div className="adm-panel">
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Tokens ({tokens.length})</h2>
              <RawTable
                list={tokens.slice(0, 30)}
                columns={['token_id', 'earned_at']}
                empty="No tokens."
                deleteLabel="Revoke"
                onDelete={(r) => drop('admin_delete_user_token', { p_user_id: userId, p_token_id: r.token_id }, 'Revoke this token')}
              />
            </div>
            <div className="adm-panel">
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Milestones ({milestones.length})</h2>
              <RawTable
                list={milestones.slice(0, 30)}
                columns={['milestone_id', 'earned_at']}
                empty="No milestones."
                deleteLabel="Revoke"
                onDelete={(r) => drop('admin_delete_user_milestone', { p_user_id: userId, p_milestone_id: r.milestone_id }, 'Revoke this milestone')}
              />
            </div>
          </div>

          <div className="adm-panel">
            <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Theme progress ({progress.length})</h2>
            <RawTable
              list={progress}
              empty="No theme progress rows."
              deleteLabel="Remove"
              onDelete={(r) => drop('admin_delete_theme_progress', { p_user_id: userId, p_theme_id: r.theme_id, p_stage: r.stage }, 'Remove this progress row')}
            />
          </div>

          <div className="adm-panel">
            <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Sigma logs ({sigmas.length})</h2>
            <RawTable list={sigmas} columns={['created_at', 'define', 'measure', 'analysis', 'improve', 'control']} empty="No sigma logs."
                      deleteLabel="Delete"
                      onDelete={(r) => drop('admin_delete_sigma', { p_sigma_id: r.id }, 'Delete this log')} />
          </div>

          <div className="adm-split">
            <div className="adm-panel">
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Jar decorations ({decorations.length})</h2>
              <RawTable list={decorations} empty="No decorations." />
            </div>
            <div className="adm-panel">
              <h2 style={{ fontSize: '1rem', margin: '0 0 8px' }}>Collaborations ({collabs.length})</h2>
              <RawTable list={collabs} empty="No collaborations." />
            </div>
          </div>
        </>
      )}

      {edit ? (
        <FormModal
          title="Edit member"
          note="Blank fields are left unchanged. Put nothing in a box you do not want to touch."
          fields={memberFields}
          values={edit.values}
          ctx={{}}
          onChange={(k, v) => setEdit((s) => ({ values: { ...s.values, [k]: v } }))}
          onClose={() => setEdit(null)}
          onSave={saveEdit}
          saving={saving}
          error={formError}
        />
      ) : null}

      {open360 ? (
        <Suspense fallback={<div className="adm-empty">Loading 360 profile...</div>}>
          <Member360Drawer userId={userId} onClose={() => setOpen360(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

export function MembersSection({ notify }) {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_users'));
  const list = useMemo(() => rows(data), [data]);
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('');
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((u) => {
      if (tier && String(u.tier || '') !== tier) return false;
      if (!needle) return true;
      return [u.first_name, u.last_name, u.username, u.email].some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [list, q, tier]);

  const columns = ['first_name', 'last_name', 'username', 'email', 'tier', 'member_tier',
                   'nectar_points', 'total_tasks_completed', 'subscription_status', 'join_date'];

  return (
    <>
      <SectionHead
        title="Members"
        note="Read through admin_get_users(). Open a row for the full member record: tasks, tokens, milestones, theme progress, sigma logs, decorations and collaborations, with the admin actions that exist for each."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? <div className="adm-error">{error}</div> : null}
      <div className="adm-filters">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, username or email…" />
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">All tiers</option>
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="adm-note">{filtered.length} of {list.length} members</span>
      </div>
      {loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable list={filtered} columns={columns} empty="No members match." onRowClick={(u) => setOpenId(u.id)} />
      )}
      {openId ? (
        <MemberDrawer userId={openId} notify={notify} onClose={() => setOpenId(null)} onChanged={reload} />
      ) : null}
    </>
  );
}

/* ═══════════════════════════ communications ═══════════════════════════ */

export function CommunicationsSection({ notify }) {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_communications', { p_limit: 100, p_offset: 0 }));
  const list = useMemo(() => rows(data), [data]);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const fields = [
    { k: 'title', label: 'title (headline)' },
    { k: 'post_type', label: 'post_type (category shown on the board)' },
    { k: 'icon', label: 'icon (leave empty; the board falls back to post_type)' },
    { k: 'message', label: 'message — the body members read', type: 'textarea', required: true },
  ];

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      await rpc('admin_save_communication', { p_data: cleanPayload(editing.values) });
      notify('Posted to the member board', 'ok');
      setEditing(null);
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!window.confirm('Delete this post? Members lose it immediately.')) return;
    try {
      await rpc('admin_delete_communication', { p_id: row.id });
      notify('Post deleted', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  return (
    <>
      <SectionHead
        title="Communications"
        note="Posts here are the announcements members see on the board and in the messenger. Writing goes through admin_save_communication(), which fills the message column the member pages actually render. The previous admin wrote a different column and could never have succeeded."
        actions={
          <>
            <button className="adm-btn" onClick={reload}>Refresh</button>
            <button className="adm-btn adm-btn--primary" onClick={() => { setFormError(null); setEditing({ values: {} }); }}>
              New post
            </button>
          </>
        }
      />
      {error ? <div className="adm-error">{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['created_at', 'title', 'post_type', 'message', 'author_name']}
          empty="No posts yet."
          onDelete={remove}
          onRowClick={(r) => { setFormError(null); setEditing({ values: { id: r.id, title: r.title, post_type: r.post_type, icon: r.icon, message: r.message } }); }}
        />
      )}
      {editing ? (
        <FormModal
          title={editing.values.id ? 'Edit post' : 'New post'}
          note="Hits every member with a board notification. The message body is required."
          fields={fields}
          values={editing.values}
          ctx={{}}
          onChange={(k, v) => setEditing((s) => ({ values: { ...s.values, [k]: v } }))}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
          error={formError}
        />
      ) : null}
    </>
  );
}

/* ═══════════════════════════ logs ═══════════════════════════ */

export function LogsSection({ notify }) {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_sigma_logs'));
  const list = useMemo(() => rows(data), [data]);
  const remove = async (row) => {
    if (!window.confirm('Delete this sigma log?')) return;
    try {
      await rpc('admin_delete_sigma', { p_sigma_id: row.id });
      notify('Log deleted', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };
  return (
    <>
      <SectionHead
        title="Sigma logs"
        note="Member written define / measure / analyse / improve / control entries."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? <div className="adm-error">{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable
          list={list}
          columns={['created_at', 'user_name', 'user_email', 'define', 'measure', 'analysis', 'improve', 'control']}
          empty="No sigma logs."
          onDelete={remove}
        />
      )}
    </>
  );
}

/* ═══════════════════════════ collaborations ═══════════════════════════ */

export function CollaborationsSection({ notify }) {
  const collabs = useLoader(() => rpc('admin_get_collaborations'));
  const invites = useLoader(() => rpc('admin_get_collab_invites'));
  const collabList = useMemo(() => rows(collabs.data), [collabs.data]);
  const inviteList = useMemo(() => rows(invites.data), [invites.data]);

  const drop = async (fn, args, label) => {
    if (!window.confirm(`${label}?`)) return;
    try {
      await rpc(fn, args);
      notify('Removed', 'ok');
      collabs.reload();
      invites.reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  return (
    <>
      <SectionHead
        title="Collaborations"
        note="Partner pairings and the invitations that produced them. Read only apart from removal — new collaborations are created by members on the collective tier, not by an admin."
        actions={<button className="adm-btn" onClick={() => { collabs.reload(); invites.reload(); }}>Refresh</button>}
      />
      {(collabs.error || invites.error) ? <div className="adm-error">{collabs.error || invites.error}</div> : null}
      <h3 style={{ fontSize: '0.95rem' }}>Collaborations ({collabList.length})</h3>
      {collabs.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable list={collabList} empty="No collaborations."
                  deleteLabel="Remove"
                  onDelete={(r) => drop('admin_delete_collaboration', { p_collab_id: r.id }, 'Remove this collaboration')} />
      )}
      <h3 style={{ fontSize: '0.95rem', marginTop: 18 }}>Invitations ({inviteList.length})</h3>
      {invites.loading ? <div className="adm-empty">Loading…</div> : (
        <RawTable list={inviteList} empty="No invitations."
                  deleteLabel="Remove"
                  onDelete={(r) => drop('admin_delete_collab_invite', { p_invite_id: r.id }, 'Remove this invitation')} />
      )}
    </>
  );
}

/* ═══════════════════════════ progress ═══════════════════════════ */

export function ProgressSection({ notify }) {
  const themeProgress = useLoader(() => rpc('admin_list_theme_progress'));
  const userTasks = useLoader(() => rpc('admin_list_user_tasks'));
  const userTokens = useLoader(() => rpc('admin_list_user_tokens'));
  const userMilestones = useLoader(() => rpc('admin_list_user_milestones'));
  const decorations = useLoader(() => rpc('admin_list_jar_decorations'));

  const drop = async (fn, args, label, reload) => {
    if (!window.confirm(`${label}?`)) return;
    try {
      await rpc(fn, args);
      notify('Removed', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  return (
    <>
      <SectionHead
        title="Progress records"
        note="The rows behind every member's totals. These are the audit trail for points, tokens and milestones — a bad row here is what makes a member's numbers wrong."
        actions={<button className="adm-btn" onClick={() => { themeProgress.reload(); userTasks.reload(); userTokens.reload(); userMilestones.reload(); decorations.reload(); }}>Refresh all</button>}
      />

      <h3 style={{ fontSize: '0.95rem' }}>Task completions ({rows(userTasks.data).length})</h3>
      <RawTable list={rows(userTasks.data)} columns={['completed_at', 'user_email', 'task_title', 'task_id', 'version']}
                empty="No completions." deleteLabel="Revoke"
                onDelete={(r) => drop('admin_delete_user_task', { p_user_id: r.user_id, p_task_id: r.task_id }, 'Revoke this completion', userTasks.reload)} />

      <h3 style={{ fontSize: '0.95rem', marginTop: 18 }}>Theme progress ({rows(themeProgress.data).length})</h3>
      <RawTable list={rows(themeProgress.data)} empty="No theme progress rows." deleteLabel="Remove"
                onDelete={(r) => drop('admin_delete_theme_progress', { p_user_id: r.user_id, p_theme_id: r.theme_id, p_stage: r.stage }, 'Remove this progress row', themeProgress.reload)} />

      <h3 style={{ fontSize: '0.95rem', marginTop: 18 }}>Token awards ({rows(userTokens.data).length})</h3>
      <RawTable list={rows(userTokens.data)} empty="No token awards." deleteLabel="Revoke"
                onDelete={(r) => drop('admin_delete_user_token', { p_user_id: r.user_id, p_token_id: r.token_id }, 'Revoke this token', userTokens.reload)} />

      <h3 style={{ fontSize: '0.95rem', marginTop: 18 }}>Milestone awards ({rows(userMilestones.data).length})</h3>
      <RawTable list={rows(userMilestones.data)} empty="No milestone awards." deleteLabel="Revoke"
                onDelete={(r) => drop('admin_delete_user_milestone', { p_user_id: r.user_id, p_milestone_id: r.milestone_id }, 'Revoke this milestone', userMilestones.reload)} />

      <h3 style={{ fontSize: '0.95rem', marginTop: 18 }}>Jar decorations ({rows(decorations.data).length})</h3>
      <RawTable list={rows(decorations.data)} empty="No decorations." />
    </>
  );
}

/* ═══════════════════════════ team ═══════════════════════════ */

/**
 * Team & Roles.
 *
 * The role model lives in the database: admin_roles holds the permission sets and
 * two planted guards stop anyone from removing the last Super Admin. Nothing here
 * is the control — every button calls an RPC that re-checks the caller's own role,
 * so a read-only analyst who forges a request is refused by Postgres, not by React.
 */
export function TeamSection({ notify }) {
  const { loading, data, error, reload } = useLoader(() => rpc('admin_get_team_overview'));
  const ov = raw(data);
  const me = ov.me || {};
  const roles = ov.roles || [];
  const members = ov.members || [];
  const invites = ov.invitations || [];
  const canManage = me.can_manage === true;

  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);

  const roleLabel = (key) => (roles.find((r) => r.role_key === key) || {}).label || key || '-';

  // Until the administrator picks one, offer the least privileged role: granting
  // by accident is worse than under-granting by default.
  const chosenRole = roleKey || (roles.length ? roles[roles.length - 1].role_key : '');

  const setRole = async (row, next) => {
    if (next === row.role_key) return;
    try {
      await rpc('admin_set_team_role', { p_user_id: row.user_id, p_role_key: next, p_reason: null });
      notify(`${row.email || row.username || 'Member'} is now ${roleLabel(next)}`, 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const setStatus = async (row, next) => {
    if (!window.confirm(`${next === 'suspended' ? 'Suspend' : 'Reinstate'} ${row.email}?`)) return;
    try {
      await rpc('admin_set_team_status', { p_user_id: row.user_id, p_status: next, p_reason: null });
      notify(next === 'suspended' ? 'Access suspended' : 'Access reinstated', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const invite = async () => {
    const value = email.trim().toLowerCase();
    if (!value || !chosenRole) return;
    setBusy(true);
    try {
      const res = raw(await rpc('admin_invite_admin', {
        p_email: value, p_role_key: chosenRole, p_note: note.trim() || null,
      }));
      setIssued(res);
      setEmail('');
      setNote('');
      notify(`Invitation ready for ${res.email}`, 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row) => {
    if (!window.confirm(`Revoke the invitation for ${row.email}?`)) return;
    try {
      await rpc('admin_revoke_invitation', { p_id: row.id, p_reason: null });
      notify('Invitation revoked', 'ok');
      reload();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const copyLink = async (url) => {
    const full = `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(full);
      notify('Invitation link copied', 'ok');
    } catch {
      window.prompt('Copy this invitation link', full);
    }
  };

  const name = (m) => [m.first_name, m.last_name].filter(Boolean).join(' ') || m.username || '-';

  return (
    <>
      <SectionHead
        title="Administrators"
        note="Who may open this area, and what each of them is allowed to do. Two rules are enforced in the database rather than here: only a Super Admin can change roles, and the last active Super Admin can never be demoted or suspended."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? <div className="adm-error">{error}</div> : null}

      <div className="adm-panel">
        <div className="adm-panel-title">Your access</div>
        <p className="adm-note">
          {me.email || '-'} — <strong>{me.label || 'not on the team'}</strong>
          {me.permissions ? ` (${me.permissions.length} permissions)` : ''}
        </p>
        {loading ? <div className="adm-empty">Loading…</div> : (
          <div className="adm-actions" style={{ flexWrap: 'wrap' }}>
            {roles.map((r) => (
              <span key={r.role_key} className={r.role_key === me.role_key ? 'adm-pill adm-pill--ok' : 'adm-pill adm-pill--off'}>
                {r.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {canManage ? (
        <div className="adm-panel">
          <div className="adm-panel-title">Invite an administrator</div>
          <div className="adm-filters">
            <input value={email} type="email" placeholder="name@example.com"
                   onChange={(e) => setEmail(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') invite(); }} />
            <select value={chosenRole} onChange={(e) => setRoleKey(e.target.value)}>
              {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
            </select>
            <input value={note} placeholder="Why (optional)" onChange={(e) => setNote(e.target.value)} />
            <button className="adm-btn adm-btn--primary" onClick={invite} disabled={busy || !email.trim()}>
              {busy ? 'Creating' : 'Create invitation'}
            </button>
          </div>
          <p className="adm-note">
            The invitation works for that email address only, expires in seven days, and is stored as a
            SHA-256 hash. Mail delivery is not connected yet, so copy the link below and send it yourself.
          </p>
          {issued ? (
            <div className="adm-card">
              <div className="adm-panel-title">Link for {issued.email} — {roleLabel(issued.role_key)}</div>
              <div className="adm-filters" style={{ marginBottom: 0 }}>
                <input readOnly value={`${window.location.origin}${issued.accept_url || ''}`} onFocus={(e) => e.target.select()} />
                <button className="adm-btn" onClick={() => copyLink(issued.accept_url || '')}>Copy</button>
                <button className="adm-btn adm-btn--small" onClick={() => setIssued(null)}>Dismiss</button>
              </div>
              <p className="adm-note">
                Expires {fmtDate(issued.expires_at)}. Whoever holds it can only activate it while signed in as {issued.email}.
                {issued.email_note ? ` ${issued.email_note}` : ''}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="adm-note" style={{ marginBottom: 16 }}>
          Your role can see the team but not change it. Asking a Super Admin to grant you the team.manage permission
          is the intended path.
        </div>
      )}

      {loading ? <div className="adm-empty">Loading…</div> : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Administrator</th><th>Email</th><th>Role</th><th>Status</th>
                <th>Nectar</th><th>Joined</th><th />
              </tr>
            </thead>
            <tbody>
              {members.length ? members.map((m) => (
                <tr key={m.user_id}>
                  <td>{name(m)}</td>
                  <td>{m.email}</td>
                  <td>
                    {canManage ? (
                      <select value={m.role_key} onChange={(e) => setRole(m, e.target.value)}>
                        {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label}</option>)}
                      </select>
                    ) : roleLabel(m.role_key)}
                  </td>
                  <td>
                    <span className={m.status === 'active' ? 'adm-pill adm-pill--ok' : 'adm-pill adm-pill--off'}>
                      {m.status === 'active' ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td>{text(m.nectar_points)}</td>
                  <td>{fmtDate(m.joined_at)}</td>
                  <td>
                    {canManage && m.user_id !== me.user_id ? (
                      m.status === 'active'
                        ? <button className="adm-btn adm-btn--small adm-btn--danger" onClick={() => setStatus(m, 'suspended')}>Suspend</button>
                        : <button className="adm-btn adm-btn--small" onClick={() => setStatus(m, 'active')}>Reinstate</button>
                    ) : null}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={7}>No administrators yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {invites.length ? (
        <>
          <SectionHead title="Invitations" note="Pending and historic invitations. An invitation can only be revoked before it is accepted." />
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr><th>Email</th><th>Role</th><th>Status</th><th>Invited</th><th>Expires</th><th>By</th><th /></tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{i.role_label || roleLabel(i.role_key)}</td>
                    <td>
                      <span className={i.status === 'pending' ? 'adm-pill adm-pill--ok' : 'adm-pill adm-pill--off'}>{i.status}</span>
                    </td>
                    <td>{fmtDate(i.created_at)}</td>
                    <td>{fmtDate(i.expires_at)}</td>
                    <td>{i.invited_by_email || '-'}</td>
                    <td>
                      {canManage && i.status === 'pending' ? (
                        <button className="adm-btn adm-btn--small adm-btn--danger" onClick={() => revoke(i)}>Revoke</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="adm-panel">
        <div className="adm-panel-title">What each role may do</div>
        {roles.map((r) => (
          <p className="adm-note" key={r.role_key}>
            <strong>{r.label}</strong> — {(r.permissions || []).join(', ') || 'no permissions'}
            {r.description ? `. ${r.description}` : ''}
          </p>
        ))}
      </div>
    </>
  );
}

/**
 * Audit log.
 *
 * Reads admin_action_logs through an RPC that requires the audit.read permission;
 * the table itself has row level security on and no direct policy, so even a
 * signed-in administrator cannot page through it in the browser console.
 */
export function AuditSection() {
  const [limit, setLimit] = useState(100);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);

  const { loading, data, error, reload } = useLoader(
    () => rpc('admin_get_action_logs', {
      p_limit: limit, p_action: action || null, p_search: query || null,
    }),
    [limit, action, query],
  );
  const payload = raw(data);
  const log = payload.rows || [];
  const actions = useLoader(() => rpc('admin_get_audit_actions'));
  const denied = error && /permission|audit\.read|Forbidden/i.test(error);

  return (
    <>
      <SectionHead
        title="Audit log"
        note="Every privileged change, written by the database itself. Team, role and invitation changes are captured by triggers, so a change made outside this interface is recorded too."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? (
        <div className={denied ? 'adm-note' : 'adm-error'}>
          {denied ? 'Your role does not include the audit.read permission. Ask a Super Admin if you need it.' : error}
        </div>
      ) : null}

      {!denied ? (
        <>
          <div className="adm-panel">
            <div className="adm-filters" style={{ marginBottom: 0 }}>
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">All actions</option>
                {rawList(actions.data).map((a) => (
                  <option key={a.action} value={a.action}>{a.action} ({a.count})</option>
                ))}
              </select>
              <input value={search} placeholder="Search actor, target or reason"
                     onChange={(e) => setSearch(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') setQuery(search); }} />
              <button className="adm-btn" onClick={() => setQuery(search)}>Search</button>
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                {[50, 100, 250, 500].map((n) => <option key={n} value={n}>Last {n}</option>)}
              </select>
              <span className="adm-note">{loading ? 'Loading…' : `${payload.count ?? log.length} entries`}</span>
            </div>
          </div>

          {loading ? <div className="adm-empty">Loading…</div> : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th><th /></tr>
                </thead>
                <tbody>
                  {log.length ? log.map((l) => (
                    <tr key={l.id} onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: 'pointer' }}>
                      <td>{fmtDate(l.created_at)}</td>
                      <td>{l.actor_email || '-'}{l.actor_name ? ` (${l.actor_name})` : ''}</td>
                      <td>{l.action}</td>
                      <td>{l.target_type ? `${l.target_type}${l.target_id ? ` #${l.target_id}` : ''}` : '-'}</td>
                      <td>{l.reason || '-'}</td>
                      <td><span className="adm-pill adm-pill--off">{open === l.id ? 'Hide' : 'Details'}</span></td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6}>Nothing recorded yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {open ? null : null}
          {log.filter((l) => l.id === open).map((l) => (
            <div className="adm-panel" key={`${l.id}-detail`}>
              <div className="adm-panel-title">{l.action} — {fmtDate(l.created_at)}</div>
              <div className="adm-split">
                <div>
                  <div className="adm-note">Before</div>
                  <pre>{JSON.stringify(l.before_data, null, 2) || 'null'}</pre>
                </div>
                <div>
                  <div className="adm-note">After</div>
                  <pre>{JSON.stringify(l.after_data, null, 2) || 'null'}</pre>
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

/**
 * The accept-an-invitation card. Shown to a signed-in person who has been invited
 * (or arrives with ?invite=<token>): the invitation is worthless until the
 * database sees a session whose verified email matches the invitation.
 */
export function InviteAcceptPanel({ token, onAccepted }) {
  const { loading, data, error } = useLoader(() => rpc('admin_get_my_pending_invitations'));
  const pending = rawList(data);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const accept = async (tok) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = raw(await rpc('admin_accept_invitation', { p_token: tok }));
      setMessage({ kind: 'ok', text: `You are now an administrator (${res.label || res.role_key}).` });
      if (onAccepted) onAccepted();
    } catch (e) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-panel">
      <div className="adm-panel-title">Invitation</div>
      {error ? <div className="adm-error">{error}</div> : null}
      {message ? <div className={message.kind === 'ok' ? 'adm-ok' : 'adm-error'}>{message.text}</div> : null}
      {loading ? <div className="adm-empty">Checking your invitations…</div> : null}

      {pending.map((p) => (
        <div key={p.id} className="adm-card">
          <p className="adm-note">
            You have been invited to join the administration team as <strong>{p.role_label || p.role_key}</strong>
            {p.invited_by_email ? ` by ${p.invited_by_email}` : ''}. Expires {fmtDate(p.expires_at)}.
          </p>
          <button className="adm-btn adm-btn--primary" disabled={busy} onClick={() => accept(token || '')}>
            {busy ? 'Accepting' : 'Accept invitation'}
          </button>
        </div>
      ))}

      {!loading && !pending.length && token ? (
        <div className="adm-card">
          <p className="adm-note">This link has not been recognised for the email address you are signed in with. It may have been used, revoked, expired, or issued to a different address.</p>
          <button className="adm-btn" disabled={busy} onClick={() => accept(token)}>
            {busy ? 'Trying' : 'Try this link again'}
          </button>
        </div>
      ) : null}

      {!loading && !pending.length && !token ? (
        <div className="adm-note">No invitation is waiting for this email address.</div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════ shared read-only pieces ═══════════════════════════ */

/** Numeric tiles from a flat object. Nested objects are skipped on purpose: a
 *  distribution has to be read against its own maximum, so it gets a meter. */
function StatCards({ data }) {
  const entries = Object.entries(data || {}).filter(([, v]) => v === null || typeof v !== 'object');
  if (!entries.length) return null;
  return (
    <div className="adm-cards">
      {entries.map(([k, v]) => (
        <div className="adm-card" key={k}>
          <div className="k">{k.replace(/_/g, ' ')}</div>
          <div className="v">
            {/_at$/.test(k) ? fmtDate(v) : (typeof v === 'number' ? v.toLocaleString() : text(v))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Bars scaled against the largest value in the set. No charting dependency. */
function Meters({ data, label }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return <div className="adm-empty">Nothing recorded in this window.</div>;
  const max = Math.max(1, ...entries.map(([, v]) => Number(v) || 0));
  return (
    <div className="adm-meters">
      {entries.map(([k, v]) => {
        const n = Number(v) || 0;
        return (
          <div className="adm-meter" key={k}>
            <span className="adm-meter-label" title={k}>{label ? label(k) : k}</span>
            <span className="adm-meter-track">
              <i style={{ width: `${Math.round((n / max) * 100)}%` }} />
            </span>
            <span className="adm-meter-value">{n.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════ memberships ═══════════════════════════ */

const TIER_NAMES = { 0: 'Free', 1: 'Hive+', 2: 'Steward', 3: 'Collective' };

// profiles.tier is a display mirror, not the access switch: the member app gates on
// member_tier (partner invites require member_tier >= 3). The admin Members drawer and
// the member pages share this spelling, so the mirror is written in it explicitly
// instead of relying on the function's own default wording.
const TIER_MIRROR = { 0: 'free', 1: 'plus', 2: 'steward', 3: 'collective' };

export function SubscriptionsSection({ notify }) {
  const { loading, data, error, reload } = useLoader(
    () => rpc('admin_get_subscriptions', { p_limit: 50, p_offset: 0 }),
  );
  const payload = obj(data);

  const [target, setTarget] = useState('');
  const [member, setMember] = useState(null);
  const [memberError, setMemberError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState('');
  const [savingTier, setSavingTier] = useState(false);
  const [subId, setSubId] = useState('');
  const [subForm, setSubForm] = useState({});
  const [subError, setSubError] = useState(null);
  const [savingSub, setSavingSub] = useState(false);

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const lookup = async () => {
    const value = target.trim();
    if (!value) {
      setMemberError('Enter the member id, or the email address on their Hive Nectar account.');
      return;
    }
    setBusy(true);
    setMemberError(null);
    setMember(null);
    try {
      let id = UUID.test(value) ? value : null;
      if (!id) {
        // The membership RPC takes the profile id, so an email has to be
        // resolved first. admin_get_users lists members without touching a table.
        const users = rows(await rpc('admin_get_users'));
        const hit = users.find((u) => (u.email || '').toLowerCase() === value.toLowerCase());
        if (!hit) throw new Error(`No member account uses the email ${value}.`);
        id = hit.id;
      }
      const found = obj(await rpc('admin_get_member_subscription', { p_user_id: id }));
      if (!found.profile) throw new Error('That id is not a member profile.');
      setMember(found);
      setTier('');
    } catch (e) {
      setMemberError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const applyTier = async () => {
    if (!member || !member.profile) return;
    const n = Number(tier);
    if (!Number.isInteger(n) || n < 0 || n > 3) {
      setMemberError('Choose a tier between 0 and 3.');
      return;
    }
    const who = member.profile.email || member.profile.id;
    const agreed = window.confirm(
      `Set ${who} to tier ${n} (${TIER_NAMES[n]})?\n\n`
      + `This changes their access level immediately and records "${TIER_MIRROR[n]}" `
      + 'as their tier label. It does not touch their Stripe subscription, their '
      + 'billing history, or the amount they were charged.',
    );
    if (!agreed) return;
    setSavingTier(true);
    setMemberError(null);
    try {
      await rpc('admin_set_member_tier', {
        p_user_id: member.profile.id,
        p_member_tier: n,
        p_tier: TIER_MIRROR[n],
      });
      notify(`${who} is now tier ${n} (${TIER_NAMES[n]})`, 'ok');
      await lookup();
      reload();
    } catch (e) {
      setMemberError(e.message);
    } finally {
      setSavingTier(false);
    }
  };

  const profile = member?.profile;

  // Repair path for the subscriptions table itself. The row is normally written
  // by the Stripe webhook, so this exists for the cases the webhook cannot fix:
  // a backfill that never ran, or a subscription that drifted. It deliberately
  // does not touch a member's access level -- that is the tier control below.
  const pickSub = (id) => {
    setSubError(null);
    setSubId(id);
    const row = (payload.rows || []).find((r) => String(r.id) === String(id));
    setSubForm(row ? {
      status: row.status || '',
      tier: row.tier || '',
      price_id: row.price_id || '',
      cancel_at_period_end: row.cancel_at_period_end === true,
      current_period_end: (row.current_period_end || '').slice(0, 16),
      trial_end: (row.trial_end || '').slice(0, 16),
    } : {});
  };

  const saveSub = async () => {
    if (!subId) return;
    setSavingSub(true);
    setSubError(null);
    try {
      // The RPC overwrites only the keys it is given and reads a blank string as
      // "leave this alone" (NULLIF(btrim(...))), so a partially filled form is safe.
      // The checkbox is the exception: it is always sent, so it can clear the flag.
      const data = {
        status: subForm.status || '',
        tier: subForm.tier || '',
        price_id: subForm.price_id || '',
        cancel_at_period_end: subForm.cancel_at_period_end ? 'true' : 'false',
        current_period_end: subForm.current_period_end || '',
        trial_end: subForm.trial_end || '',
      };
      await rpc('admin_update_subscription', { p_id: subId, p_data: data });
      notify('Subscription record updated', 'ok');
      reload();
    } catch (e) {
      setSubError(e.message);
    } finally {
      setSavingSub(false);
    }
  };

  return (
    <>
      <SectionHead
        title="Memberships"
        note="Read from admin_get_subscriptions(), which joins the Stripe customer map to Hive profiles. The subscriptions table itself is only filled by the Stripe backfill, so until that runs the paying-member list below is the real picture."
        actions={<button className="adm-btn" onClick={reload}>Refresh</button>}
      />
      {error ? <div className="adm-error">{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <StatCards data={payload.summary} />

          <div className="adm-panel">
            <h3 className="adm-panel-title">Paying members</h3>
            <RawTable
              list={payload.customers}
              columns={['email', 'username', 'member_tier', 'stripe_customer_id', 'created_at']}
              empty="No Stripe customers are linked to a member yet."
            />
          </div>

          <div className="adm-panel">
            <h3 className="adm-panel-title">Subscription records</h3>
            <RawTable
              list={payload.rows}
              empty="The subscriptions table is empty. It is populated by the Stripe webhook, which has not backfilled historical rows."
            />
          </div>

          <div className="adm-panel">
            <h3 className="adm-panel-title">Stripe event tail</h3>
            <p className="adm-note">
              Event type and time only. The raw payload is deliberately not returned —
              it can contain full billing details.
            </p>
            <RawTable
              list={payload.events}
              columns={['created_at', 'type', 'id']}
              empty="No Stripe events recorded."
            />
          </div>

          <div className="adm-panel">
            <h3 className="adm-panel-title">Edit a subscription record</h3>
            <p className="adm-note">
              Repairs the subscriptions row through admin_update_subscription(). A later
              Stripe event will overwrite these fields, so use it for rows the webhook
              never wrote, not as a routine edit. Blank fields are left untouched.
            </p>
            <div className="adm-filters">
              <select value={subId} onChange={(e) => pickSub(e.target.value)}>
                <option value="">choose a subscription row…</option>
                {(payload.rows || []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} — {r.status || 'no status'}
                  </option>
                ))}
              </select>
            </div>
            {subId ? (
              <>
                <div className="adm-filters">
                  <input
                    value={subForm.status || ''}
                    placeholder="status (e.g. active, canceled)"
                    onChange={(e) => setSubForm({ ...subForm, status: e.target.value })}
                  />
                  <select
                    value={subForm.tier || ''}
                    onChange={(e) => setSubForm({ ...subForm, tier: e.target.value })}
                  >
                    <option value="">tier…</option>
                    {['free', 'plus', 'steward', 'collective'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <label className="adm-note">
                    <input
                      type="checkbox"
                      checked={subForm.cancel_at_period_end === true}
                      onChange={(e) => setSubForm({ ...subForm, cancel_at_period_end: e.target.checked })}
                    />
                    {' '}cancel at period end
                  </label>
                </div>
                <div className="adm-filters">
                  <input
                    value={subForm.current_period_end || ''}
                    placeholder="current_period_end"
                    onChange={(e) => setSubForm({ ...subForm, current_period_end: e.target.value })}
                  />
                  <input
                    value={subForm.trial_end || ''}
                    placeholder="trial_end"
                    onChange={(e) => setSubForm({ ...subForm, trial_end: e.target.value })}
                  />
                  <input
                    value={subForm.price_id || ''}
                    placeholder="price_id"
                    onChange={(e) => setSubForm({ ...subForm, price_id: e.target.value })}
                  />
                </div>
                <div className="adm-filters">
                  <button
                    className="adm-btn adm-btn--primary"
                    onClick={saveSub}
                    disabled={savingSub}
                  >
                    {savingSub ? 'Saving' : 'Save subscription'}
                  </button>
                </div>
              </>
            ) : null}
            {subError ? <div className="adm-error">{subError}</div> : null}
          </div>
        </>
      )}

      <div className="adm-panel">
        <h3 className="adm-panel-title">Member membership</h3>
        <p className="adm-note">
          Load one member to see their subscription state and to change their tier.
          Changing a tier here records the access level only; billing stays with Stripe.
        </p>
        <div className="adm-filters">
          <input
            value={target}
            placeholder="member id or email address"
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
          />
          <button className="adm-btn adm-btn--primary" onClick={lookup} disabled={busy}>
            {busy ? 'Looking up' : 'Load member'}
          </button>
        </div>
        {memberError ? <div className="adm-error" style={{ marginBottom: 12 }}>{memberError}</div> : null}

        {profile ? (
          <>
            <StatCards data={profile} />
            <div className="adm-filters">
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">set tier to…</option>
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>{n} — {TIER_NAMES[n]}</option>
                ))}
              </select>
              <button className="adm-btn adm-btn--primary" onClick={applyTier} disabled={savingTier || tier === ''}>
                {savingTier ? 'Saving' : 'Set tier'}
              </button>
              <span className="adm-note">
                Writes member_tier and the matching tier name. Skip it if the change was
                meant to come from a payment.
              </span>
            </div>
            <h4 className="adm-panel-title">Subscription rows for this member</h4>
            <RawTable list={member.subscriptions} empty="No subscription rows for this member." />
          </>
        ) : null}
      </div>
    </>
  );
}

/* ═══════════════════════════ analytics ═══════════════════════════ */

export function AnalyticsSection() {
  const [days, setDays] = useState(30);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customWindow, setCustomWindow] = useState('');
  const { loading, data, error } = useLoader(() => rpc('admin_get_analytics', { p_days: days }), [days]);
  const payload = obj(data);

  // admin_get_analytics() takes a whole number of days (clamped 1..365 inside
  // the function), not a from/to pair, so a custom range is applied as the day
  // count it covers. The presets and the custom range share the same `days`
  // state, so either one really re-queries.
  const applyCustomRange = () => {
    if (!customFrom || !customTo) return;
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    if (!(from.getTime() < to.getTime())) return;
    setDays(Math.min(365, Math.max(1, Math.ceil((to - from) / 86400000))));
    setCustomWindow(`${customFrom} to ${customTo}`);
  };

  const byDay = (list) => Object.fromEntries((list || []).map((r) => [String(r.day).slice(5), r.count]));

  return (
    <>
      <SectionHead
        title="Analytics"
        note="Counted live by admin_get_analytics() over the selected window. The window only affects the two day-by-day series; the totals are all-time."
        actions={
          <>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                className={`adm-btn${d === days && !customWindow ? ' adm-btn--primary' : ''}`}
                onClick={() => {
                  setDays(d);
                  setCustomWindow('');
                }}
              >
                {d} days
              </button>
            ))}
            <input
              type="date"
              className="adm-input-date"
              aria-label="Custom range from"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <input
              type="date"
              className="adm-input-date"
              aria-label="Custom range to"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
            />
            <button
              className={`adm-btn${customWindow ? ' adm-btn--primary' : ''}`}
              onClick={applyCustomRange}
            >
              Apply
            </button>
          </>
        }
      />
      {customWindow ? (
        <p className="adm-note">Custom range {customWindow}, applied as the last {days} days.</p>
      ) : null}
      {error ? <div className="adm-error">{error}</div> : null}
      {loading ? <div className="adm-empty">Loading…</div> : (
        <>
          <StatCards data={payload.totals} />

          <div className="adm-panel">
            <h3 className="adm-panel-title">Members per tier</h3>
            <Meters
              data={payload.totals?.tier_distribution}
              label={(k) => `${k} — ${TIER_NAMES[k] || 'unknown'}`}
            />
          </div>

          <div className="adm-panel">
            <h3 className="adm-panel-title">Themes</h3>
            {payload.themes?.length ? (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>theme</th>
                      <th>learners</th>
                      <th>nectar earned</th>
                      <th>stage spread</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.themes.map((t) => (
                      <tr key={t.theme_id}>
                        <td>{t.theme_id} — {t.theme_name}</td>
                        <td>{(Number(t.learners) || 0).toLocaleString()}</td>
                        <td>{(Number(t.nectar_earned) || 0).toLocaleString()}</td>
                        <td>
                          {Object.entries(t.stages || {})
                            .map(([stage, n]) => `${stage} ${n}`)
                            .join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="adm-empty">No theme progress recorded.</div>}
          </div>

          <div className="adm-split">
            <div className="adm-panel">
              <h3 className="adm-panel-title">Sign-ups per day</h3>
              <Meters data={byDay(payload.signups_by_day)} />
            </div>
            <div className="adm-panel">
              <h3 className="adm-panel-title">Tasks completed per day</h3>
              <Meters data={byDay(payload.completions_by_day)} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
