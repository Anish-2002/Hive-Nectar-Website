import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { rpc, raw, fmtDate } from './api.js';
import { SectionHead } from './sections.jsx';
import './dashboard.css';

/*
 * Dashboard for the Hive Nectar admin surface.
 *
 * Every figure on this screen is produced by admin_get_dashboard_metrics() and
 * computed inside the database over the window the operator picks. There is no
 * invented figure and no silent zero:
 *
 *  - if the RPC fails, the server's own message is shown verbatim behind a
 *    Retry control;
 *  - the support / billing / system blocks are only returned to roles holding
 *    the matching permission, so when one is missing it renders as
 *    "not available for your role", never as 0;
 *  - the date control genuinely re-queries (the from/to are passed to the RPC
 *    as p_from / p_to and are part of the request's dependency key).
 */

const DAY_MS = 86400000;

const isoNow = () => new Date().toISOString();
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/**
 * Local copy of the loader used by the other section modules (same contract):
 * re-runs when the (stable) dependency key changes, keeps the previous result
 * out of the way while loading, and surfaces the thrown message on failure.
 */
function useApi(load, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  const depKey = JSON.stringify(deps);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: null });
    loadRef.current()
      .then((data) => {
        if (alive) setState({ loading: false, data, error: null });
      })
      .catch((e) => {
        if (alive) setState({ loading: false, data: null, error: (e && e.message) || String(e) });
      });
    return () => {
      alive = false;
    };
  }, [depKey, nonce]);
  const reload = () => setNonce((n) => n + 1);
  return { ...state, reload };
}

const ACRONYMS = { co2e: 'CO2e', sla: 'SLA', id: 'ID' };

/** 'impact_co2e_kg' -> 'Impact CO2e Kg'. Label only; values are untouched. */
function humanize(key) {
  return String(key)
    .split('_')
    .map((word) => ACRONYMS[word] || (word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function fmtValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

// Grouped exactly as the RPC returns them. `metric` is the key into the
// payload's `links` object, which names the section the group belongs to.
const BLOCKS = [
  { key: 'members', title: 'Members', metric: 'members' },
  { key: 'engagement', title: 'Engagement & Impact', metric: 'tasks' },
  { key: 'awards', title: 'Awards', metric: null },
  { key: 'reviews', title: 'Member Reviews', metric: 'reviews' },
  { key: 'recognition', title: 'Recognition & Gift Fulfilment', metric: 'recognition' },
];

const GATED_BLOCKS = [
  { key: 'support', title: 'Support', metric: 'support' },
  { key: 'billing', title: 'Billing & Subscriptions', metric: 'billing' },
  { key: 'system', title: 'System & Notifications', metric: null },
];

const LINE_SERIES = [
  { key: 'signups', label: 'Sign-ups' },
  { key: 'tasks', label: 'Tasks completed' },
];

const linkFor = (metric, payload) =>
  metric && payload.links && typeof payload.links === 'object' ? payload.links[metric] || null : null;

function MetricCard({ label, value, onClick }) {
  if (onClick) {
    return (
      <button type="button" className="admd-card admd-card--link" onClick={onClick}>
        <span className="admd-card-v">{value}</span>
        <span className="admd-card-k">{label}</span>
      </button>
    );
  }
  return (
    <div className="admd-card">
      <span className="admd-card-v">{value}</span>
      <span className="admd-card-k">{label}</span>
    </div>
  );
}

function BlockPanel({ title, block, link, onNavigate, navigableIds }) {
  const entries = Object.entries(block || {});
  const cards = entries.filter(([, v]) => typeof v !== 'string');
  const notes = entries.filter(([, v]) => typeof v === 'string');
  const clickable = Boolean(onNavigate && link && (!navigableIds || navigableIds.has(link)));
  const go = clickable ? () => onNavigate(link) : undefined;
  return (
    <section className="admd-block">
      <div className="admd-block-head">
        <h3 className="admd-block-title">{title}</h3>
        {clickable ? (
          <button type="button" className="admd-block-link" onClick={go}>
            Open {title.toLowerCase()}
          </button>
        ) : null}
      </div>
      <div className="admd-cards">
        {cards.map(([key, value]) => (
          <MetricCard key={key} label={humanize(key)} value={fmtValue(value)} onClick={go} />
        ))}
      </div>
      {notes.map(([key, value]) => (
        <p className="admd-block-note" key={key}>
          {value}
        </p>
      ))}
    </section>
  );
}

function GatedAbsent({ title }) {
  return (
    <section className="admd-block admd-block--gated">
      <h3 className="admd-block-title">{title}</h3>
      <p className="admd-block-note">
        Not available for your role. This block is only returned to administrators holding the
        matching permission, so it is omitted rather than shown as zero.
      </p>
    </section>
  );
}

function Legend({ items }) {
  return (
    <div className="admd-legend">
      {items.map((item) => (
        <span className="admd-legend-item" key={item.key}>
          <span className={`admd-swatch admd-swatch--${item.key}`} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** Inline SVG line chart — no charting library. Each dot carries a <title>. */
function LineChart({ rows, series }) {
  const W = 820;
  const H = 240;
  const padL = 46;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const n = rows.length;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxY = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
  const xAt = (i) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const yAt = (v) => padT + (1 - (Number(v) || 0) / maxY) * plotH;
  const ticks = [0, Math.round(maxY / 2), maxY];
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <svg className="admd-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily sign-ups and completed tasks">
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line className="admd-grid" x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} />
          <text className="admd-tick" x={padL - 8} y={yAt(t) + 4} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      {rows.map((r, i) =>
        i % every === 0 ? (
          <text key={`x-${r.d}`} className="admd-tick" x={xAt(i)} y={H - 9} textAnchor="middle">
            {String(r.d).slice(5)}
          </text>
        ) : null,
      )}
      {series.map((s) => (
        <polyline
          key={s.key}
          className={`admd-line admd-line--${s.key}`}
          fill="none"
          points={rows.map((r, i) => `${xAt(i)},${yAt(r[s.key])}`).join(' ')}
        />
      ))}
      {series.map((s) =>
        rows.map((r, i) => (
          <circle key={`${s.key}-${r.d}`} className={`admd-dot admd-dot--${s.key}`} cx={xAt(i)} cy={yAt(r[s.key])} r="3">
            <title>{`${r.d} - ${s.label}: ${Number(r[s.key]) || 0}`}</title>
          </circle>
        )),
      )}
    </svg>
  );
}

/** Inline SVG bar chart — one bar per day, each with a <title>. */
function BarChart({ rows, valueKey, label }) {
  const W = 820;
  const H = 220;
  const padL = 46;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const n = rows.length || 1;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const step = plotW / n;
  const barW = Math.max(2, step * 0.6);
  const maxY = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  const yAt = (v) => padT + (1 - (Number(v) || 0) / maxY) * plotH;
  const ticks = [0, Math.round(maxY / 2), maxY];
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <svg className="admd-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily ${label}`}>
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line className="admd-grid" x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} />
          <text className="admd-tick" x={padL - 8} y={yAt(t) + 4} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      {rows.map((r, i) =>
        i % every === 0 ? (
          <text key={`x-${r.d}`} className="admd-tick" x={padL + i * step + step / 2} y={H - 9} textAnchor="middle">
            {String(r.d).slice(5)}
          </text>
        ) : null,
      )}
      {rows.map((r, i) => {
        const value = Number(r[valueKey]) || 0;
        const y = yAt(value);
        return (
          <rect
            key={`bar-${r.d}`}
            className="admd-bar"
            x={padL + i * step + (step - barW) / 2}
            y={y}
            width={barW}
            height={Math.max(0, padT + plotH - y)}
          >
            <title>{`${r.d} - ${label}: ${value}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function DashboardSkeleton() {
  return (
    <div className="admd-skeleton" aria-busy="true" aria-live="polite">
      <span className="admd-sr">Loading dashboard metrics.</span>
      {[0, 1].map((b) => (
        <div className="admd-skel-block" key={b}>
          <div className="admd-skel-title" />
          <div className="admd-skel-cards">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="admd-skel-card" key={i} />
            ))}
          </div>
        </div>
      ))}
      <div className="admd-skel-chart" />
    </div>
  );
}

export function DashboardSection({ onNavigate, navigableIds }) {
  const [range, setRange] = useState(() => ({ preset: '30', from: isoDaysAgo(30), to: isoNow() }));
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [customError, setCustomError] = useState('');

  const { loading, data, error, reload } = useApi(
    () => rpc('admin_get_dashboard_metrics', { p_from: range.from, p_to: range.to }),
    [range.from, range.to],
  );

  const payload = useMemo(() => raw(data), [data]);
  const rows = useMemo(() => (Array.isArray(payload.series) ? payload.series : []), [payload]);
  const window_ = payload.range || {};
  const hasBlocks = BLOCKS.concat(GATED_BLOCKS).some((b) => payload[b.key]);

  const applyPreset = (days) => {
    setCustomError('');
    setRange({ preset: String(days), from: isoDaysAgo(days), to: isoNow() });
  };

  const applyCustom = () => {
    if (!custom.from || !custom.to) {
      setCustomError('Pick both a start and an end date.');
      return;
    }
    const from = new Date(`${custom.from}T00:00:00`);
    const to = new Date(`${custom.to}T23:59:59`);
    if (!(from.getTime() < to.getTime())) {
      setCustomError('The start date must be before the end date.');
      return;
    }
    setCustomError('');
    setRange({ preset: 'custom', from: from.toISOString(), to: to.toISOString() });
  };

  return (
    <div className="admd">
      <SectionHead
        title="Dashboard"
        note="Every figure below is computed in the database by admin_get_dashboard_metrics() over the window you pick. Nothing is estimated, cached, or filled in on the client."
        actions={
          <div className="admd-controls">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className={`adm-btn${range.preset === String(d) ? ' adm-btn--primary' : ''}`}
                onClick={() => applyPreset(d)}
              >
                Last {d} days
              </button>
            ))}
            <label className="admd-date">
              <span>From</span>
              <input
                type="date"
                value={custom.from}
                max={custom.to || undefined}
                onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              />
            </label>
            <label className="admd-date">
              <span>To</span>
              <input
                type="date"
                value={custom.to}
                min={custom.from || undefined}
                onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              />
            </label>
            <button
              type="button"
              className={`adm-btn${range.preset === 'custom' ? ' adm-btn--primary' : ''}`}
              onClick={applyCustom}
            >
              Apply
            </button>
            <button type="button" className="adm-btn" onClick={reload}>
              Refresh
            </button>
          </div>
        }
      />

      {customError ? <p className="admd-custom-error">{customError}</p> : null}

      {loading ? <DashboardSkeleton /> : null}

      {!loading && error ? (
        <div className="admd-error-card" role="alert">
          <h3 className="admd-error-title">The metrics could not be loaded</h3>
          <pre className="admd-error-msg">{error}</pre>
          <button type="button" className="adm-btn adm-btn--primary" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}

      {!loading && !error ? (
        <>
          <p className="admd-window">
            {window_.from && window_.to
              ? `Window: ${fmtDate(window_.from)} to ${fmtDate(window_.to)} (${window_.days} day${
                  window_.days === 1 ? '' : 's'
                })`
              : `Window: ${fmtDate(range.from)} to ${fmtDate(range.to)}`}
          </p>

          {!hasBlocks && !rows.length ? (
            <div className="admd-empty">No metrics were returned for this window. Widen the range and try again.</div>
          ) : null}

          {BLOCKS.map((b) =>
            payload[b.key] ? (
              <BlockPanel
                key={b.key}
                title={b.title}
                block={payload[b.key]}
                link={linkFor(b.metric, payload)}
                onNavigate={onNavigate}
                navigableIds={navigableIds}
              />
            ) : null,
          )}

          <section className="admd-block">
            <div className="admd-block-head">
              <h3 className="admd-block-title">Daily activity</h3>
              <Legend items={LINE_SERIES} />
            </div>
            {rows.length ? (
              <LineChart rows={rows} series={LINE_SERIES} />
            ) : (
              <p className="admd-block-note">No daily series was returned for this window.</p>
            )}
            <div className="admd-block-head admd-block-head--sub">
              <h4 className="admd-block-subtitle">Nectar awarded per day</h4>
            </div>
            {rows.length ? <BarChart rows={rows} valueKey="nectar" label="Nectar awarded" /> : null}
          </section>

          {GATED_BLOCKS.map((b) =>
            payload[b.key] ? (
              <BlockPanel
                key={b.key}
                title={b.title}
                block={payload[b.key]}
                link={linkFor(b.metric, payload)}
                onNavigate={onNavigate}
                navigableIds={navigableIds}
              />
            ) : (
              <GatedAbsent key={b.key} title={b.title} />
            ),
          )}
        </>
      ) : null}
    </div>
  );
}
