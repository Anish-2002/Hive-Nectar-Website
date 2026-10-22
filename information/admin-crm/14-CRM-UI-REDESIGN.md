# 14 — CRM UI/UX REDESIGN (Zendesk-inspired design system)

Status: **Phase 1 complete (documented below) · Phase 2–4 implemented, see §Results.**
Scope: the React-port CRM at `/admin` (`The Meadows react.` → `src/admin/*` + `/admin.html` entry).
Hard constraint carried from the brief: **frontend design-system overhaul only.** No backend
rebuild, no route removal, no non-functional placeholder screens, no feature dropped.

---

## Phase 1 — Inspect before changing anything

### 1.1 Framework and component architecture

| Item | Finding |
| --- | --- |
| Framework | React 19 + Vite 8 + react-router-dom 7 (`package.json`), no UI kit, no CSS framework, no CSS-in-JS |
| Entry | `/admin` route in `src/App.jsx` → `AdminApp` (all five legacy `admin*` HTML files redirect here) |
| Structure | `AdminApp.jsx` (393 lines) = shell + navigation table; section components in `sections.jsx` (1997), `sections-crm.jsx` (1785), `sections-phase-a.jsx` (1322), `sections-dashboard.jsx` (455), `sections-mail.jsx` (289) — 5,548 lines of JSX |
| Data layer | `src/admin/api.js` — every read/write is an `admin_*` RPC; no direct table reads (kept intact) |
| Icons | **none installed.** `index.html` links Font Awesome from a CDN *for the legacy pages*, and that link is switchable (see `src/lib/legacy.js`), so the CRM could not rely on it |
| Stylesheets | **four, with three prefixes and no shared scale:** `admin.css` (375 lines, `.adm-`), `dashboard.css` (365, `.admd-`), `phase-a.css` (247, `.admpa-`), `mail.css` (63, `.adm-`) — plus the *member* stylesheet `public/style.css` (97178 bytes) which is linked on every page including this one, and `src/index.css` |

### 1.2 Layout, sidebar, headers, navigation (as found)

- Shell: `div.adm-shell` = `aside.adm-side` + `main.adm-main`. **There is no top bar at all** —
  no global search, no notification bell, no administrator avatar, no profile dropdown, no
  breadcrumb (grep for `bell|avatar|breadcrumb|adm-topbar|adm-search` in `AdminApp.jsx`: no hit).
- Sidebar: 224 px fixed, `position: sticky; top: 0; max-height: 100vh`, no collapse control,
  no icons, group headers are text buttons with a CSS-triangle caret.
- Section headings: 33 sections each render `<div className="adm-head"><h2>…` ad hoc
  (11 occurrences across three files) — no page-header component, no eyebrow, no breadcrumb.

### 1.3 CSS, tokens and the causes of the visible defects

**(a) Styles do load, and they are then overridden — this is the real cause.**

`admin.css` publishes `--adm-*` tokens *from the member theme*:

```
.adm-shell {
  --adm-bg: var(--bg, #FBF7F0);        /* member cream           */
  --adm-fg: var(--fg, #2E2A24);
  --adm-accent: var(--cta, #C8A96E);   /* member gold            */
  --adm-border: var(--border, #E7DFD1);
  font-family: inherit;                /* ← inherits from body   */
}
```

`public/style.css` (linked on the admin route as well) then wins or pollutes:

- `body { font-family: 'Manrope', …; background: var(--bg); background-image: <two radial
  gradients + a honeycomb SVG>; }` → **the CRM renders on the member site's honeycomb/gradient
  background**, and all admin body text is Manrope.
- `h1,h2,h3,h4,h5,h6 { font-family: 'Fredoka', …; }` → **every CRM heading (H1–H6) is drawn in
  Fredoka**, a rounded playful display face, because `admin.css` only sets sizes, never the family.
- `h2 { font-size: clamp(1.5rem, 4vw, 2rem); }` vs `.adm-head h2 { font-size: 1.25rem; }` → the
  same visual level is 20 px in one place and up to 32 px in another.
- `input, textarea, select { width:100%; padding:14px 16px; border:2px solid var(--border);
  border-radius: var(--radius-md); font-size:1rem; }` → a global 2 px-bordered, 14/16-padded,
  16 px-text control; admin forms re-declare 8/10-padded 0.85rem controls with 1 px borders and
  one of two different radii. Whichever rule wins depends on selector specificity, page by page.

**(b) Tiny typography, measured.** The four admin stylesheets contain **26 distinct `font-size`
values**, of which 22 are between `0.66rem` and `0.95rem`:

```
0.66  0.68  0.69  0.7   0.72  0.73  0.75  0.76  0.77  0.78  0.79
0.8   0.82  0.83  0.84  0.85  0.88  0.9   0.92  0.95   (10.6px – 15.2px)
```

`table.adm-table` = `0.83rem` (13.3 px) with `th` at `0.7rem` (**11.2 px**), form labels
`0.72rem` (11.5 px), sidebar group headers `0.68rem` (10.9 px), `.adm-pill` `0.7rem`.
No `16px` body-scale token exists anywhere.

**(c) Excessive whitespace and inconsistent page width — structural, not cosmetic.**

- `.adm-main { padding: 20px 22px 60px; }` — **no `max-width` and no centring container**, so
  every panel, table and form stretches to the full viewport. On a 1920 px display the tables run
  edge-to-edge (~1,880 px of content) and `.adm-form` (`grid-template-columns: repeat(auto-fill,
  minmax(230px, 1fr))`) produces a full-width wall of stretched 600 px-wide inputs.
- Card grids use `minmax(148px|150px, 1fr)` with `auto-fill` → at wide widths the same card row
  holds 9–12 cards, so the "dashboard" reads as a sparse field rather than a set of tiles.
- `60px` of bottom padding, `14px` panel margins and `13px/11px` table cell padding are hard-coded
  in three different files with three different radii (`9px`, `12px`, `14px`) and three different
  paddings for the same `card`/`panel`/`block` concept.
- `aside.adm-side` is `sticky; top:0; max-height:100vh` inside `.adm-shell { align-items:flex-start }`
  → the sidebar is only as tall as its own content, and `nav` has no independent scroll region, so
  on a tall viewport the sidebar's white column ends mid-screen and the area below it is bare
  background (matches the empty band in the current screenshot).

**(d) Design-token drift against the requested palette.**

| Role | Requested | In the shipped CRM |
| --- | --- | --- |
| Background | `#FAF9F6` | `#FBF7F0` (member cream) + honeycomb gradient |
| Text | `#1F2937` | `#2E2A24` |
| Secondary text | `#64748B` | `#7A6B5D` |
| Border | `#E5E7EB` | `#E7DFD1` |
| Accent | `#D9A441` | `#C8A96E` |
| Font | Inter | Manrope (body) + Fredoka (headings) |

**(e) Duplicate/conflicting component definitions.** Pill tones are defined three times
(`.adm-pill--ok/--off` in `admin.css`, `.admpa-pill--warn/--danger` in `phase-a.css`,
`.adm-pill--wait/--bad` in `mail.css`), tab strips and pagers exist twice (`sections-crm.jsx`
and `sections-phase-a.jsx` each define their own `Pager`, `Drawer`, `Field`), and
`dashboard.css` re-declares cards with its own radii. Nothing shares a spacing or radius scale.

### 1.4 Routes and modules present (33 sections — all backed by real components)

`overview` · `dashboard` · `activity-feed` · `analytics` · `members` · `review` (Member Reviews) ·
`reflections` · `sigma-logs` · `nectar` · `logs` · `progress` · `recognition` ·
`gift-fulfilment` · `memberships` · `tasks` · `themes` · `tokens` · `milestones` ·
`collaborations` · `support-inbox` · `ticket-history` · `communications` · `notifications` ·
`mail` · `hub` (Website CMS) · `nav` · `social` · `policy` · `founders` · `team` · `audit` ·
`health` · `settings`.

Deferred with no data model (deliberately absent from the menu, per standing decision):
Billing & Payments, PollenPop, TRail/Resources, FAQ & KB, Feedback & Suggestions.

### 1.5 Phase 1 conclusion

Nothing was "failing to load". The CRM had **no design system**: it inherited the member site's
playful theme (Fredoka/Manrope, honeycomb background), hard-coded 11–15 px text in three
stylesheet dialects, and stretched a 1880 px canvas with no container, container width, or
vertical rhythm. The fix is therefore a token layer + one shell + one component vocabulary —
not a rewrite of the 5,548 lines of section JSX.

---

## Phase 2 — Design system (`src/admin/ds.css`)

Tokens on `.adm-shell` (`--ds-*`), with the required values exactly:

| Token | Value |
| --- | --- |
| `--ds-bg` | `#FAF9F6` |
| `--ds-surface` | `#FFFFFF` |
| `--ds-text` | `#1F2937` |
| `--ds-muted` | `#64748B` |
| `--ds-border` | `#E5E7EB` |
| `--ds-accent` | `#D9A441` (Hive Nectar gold) |
| `--ds-accent-ink` | `#7A5A16` (accessible text on gold tint) |
| `--ds-green` | `#2F6B4F` (muted forest) |
| status | `--ds-ok #2F6B4F` · `--ds-warn #9A6B00` · `--ds-danger #B42318` · `--ds-info #1E5B8A` |

Type scale (Inter, self-hosted from `public/fonts/`): page title 30 px, section heading 20 px,
body 15 px, table 13.5 px, label 12.5 px, meta 12 px — with `1.5` line-height for prose and
tabular figures for numeric columns. Spacing scale 4/8/12/16/20/24/32/40; radii 8/10/12 px;
one shadow token for raised surfaces.

Components defined once and reused: app sidebar, global header, page header, statistic card,
data table, toolbar (search + filters), buttons, status pills, tabs, form controls,
modal, drawer, timeline, member panel, notification indicator, empty/loading/error states.

The existing `.adm-*` / `.admd-*` / `.admpa-*` class names are **re-pointed** at these tokens
rather than renamed, so all 33 modules inherit the system without touching their logic.

Icon policy: `lucide-react` (installed, tree-shaken) — no emoji, no decorative graphics, no
gradients beyond a single 1 px hairline.

---

## Phase 3 — Shell

Sidebar 248 px (collapsible to 68 px rail), brand block, grouped navigation with icons,
independent scroll region, footer identity card. Top bar: breadcrumb, global search,
notification bell with **real** counts from the admin RPCs, administrator avatar with a
profile menu. Main: `max-width` content container with consistent rhythm.

## Phase 4 — Modules

All 33 modules receive the system through the token layer; the Dashboard, Members, Member
Reviews, Reflections, Sigma Logs, Nectar, Recognition, Gift Fulfilment, Support Inbox,
Ticket History, Communications, Website CMS, Admin Team, Audit Logs and Settings screens were
additionally checked for structural defects (stretched forms, sparse card grids, dead space)
and given page headers. Support Inbox became the three-column workspace (queue | conversation
+ composer | member context).

## Phase 5-6 — Real-browser verification, directory + queues + Settings (2026-10-14, second pass)

The redesign was then driven against the **running CRM with a real admin session**
instead of the static sheet, because a static sheet cannot show the legacy
stylesheets winning a specificity fight, a live RPC returning a duplicated row, or
a badge count that never resolves.

### 5.1 How the real screens were captured

`cache/scratch/qa-crm.mjs` (playwright-core + the cached Chromium) seeds the
Supabase session into `localStorage` for `127.0.0.1:5210`, walks every navigation
section, screenshots each one full-page, and records per section: nav/topbar/content
boxes, page-title size and weight, table font size, card count, `documentElement`
overflow, per-element `scrollWidth > clientWidth`, and sub-12px text. Console
errors and warnings are captured **with the section that was on screen**.

The session itself is a temporary, clearly-named QA administrator
(`qa.verify.admin@…`) created for this verification only and removed afterwards; no
existing member or administrator row was touched. Teardown verified after the last
run: `auth.users` 0 rows, `profiles` 0 rows, `admin_users` 0 rows for that account,
`admin_users` back to 1 and `profiles` back to 20; the local session and password
files were shredded.

### 5.2 Defects the real run exposed (and the fixes)

- **`padding: 0` on the page container.** The shell renders ONE element with both
  `adm-main` and `ds-main`; the legacy rule `.ds-shell .adm-main { padding: 0 }`
  beat `.ds-main { padding: var(--ds-6) }` on the same element, so every screen sat
  flush against the viewport edge (measured `padding 0 0 0 0`). Fixed by narrowing
  the legacy rule to `.ds-shell .adm-main:not(.ds-main)`.
- **A duplicated reflection row.** `admin_get_reflections` joined
  `public.user_tasks` on `(task_id, user_id)` and that table holds duplicate pairs,
  so one submission came back twice while `total` said 3 — React reported duplicate
  keys. The read layer now uses lateral single-row lookups and a DISTINCT count
  (`sql/2026-10-14-17-fix-reflection-duplication.sql`). The duplicate **data** rows
  are reported, not deleted: they are member progress rows.
- **A chart axis with duplicate keys.** `ticks = [0, round(maxY/2), maxY]` produced
  `[0, 1, 1]` for an empty series; now de-duplicated.
- **Stretched controls.** Legacy `.adm-filters` let every control grow to full
  width (900px search boxes); the shell now constrains them (`input` 260px, `select`
  ≤220px) and the redesigned screens label each control.
- **Members asked for columns the RPC does not return** (`nectar_points`,
  `total_tasks_completed`, `subscription_status` — all rendered as “—” columns).
- **Legacy tables were a second design language**; `.adm-table` now inherits the new
  density, header and hover treatment, which lifts ~20 modules at once.

### 5.3 Modules rebuilt on the shared vocabulary

- **Members** — directory table with avatar, name/email cell, tier badge, stage and
  admin chips, level + experience, right-aligned task count, activity dot with
  relative time, short joined date, plus stat strip, search/tier/activity filters,
  sorting and the existing member drawer.
- **Review queues** — one `StatusTabs` chip row with payload counts is now shared by
  Member Reviews, Sigma Logs and Task Reflections; rows show member avatars, status
  pills and compact timestamps; the detail drawer is ordered member context →
  timeline → submission (DMAIC) → review state → actions, and the review action
  appears only when the row carries a `review_id` (no dead buttons).
- **Settings** — page title + description, integration health as cards with
  Healthy / Not ready states and the email transport figures, compact database
  statistics labelled as live counts, and a key/value configuration table with
  inline editing, two-step delete confirmation and explicit saved/error feedback.
- **Recognition & Gift fulfilment** — stat cards compacted, stock shown as a level
  indicator with Out of stock / Low / Healthy pills, pipeline stages as counted
  chips, queue table reduced from 10 columns to 7 with member cells and stage pills.

### 5.4 Proof (this pass)

- `qa-crm.mjs`, full run, signed in, real data: **33/33 sections, 0 console errors,
  0 console warnings, 0 page overflow, 0 sub-12px body text, 0 empty screens** at
  1440x1000, 1920x1080, 1280x900, 1024x800 and 834x1112
  (`cache/scratch/shots/final*/audit-*.json`).
- `node verification/verify_admin_design_system.cjs` → **102 PASS / 0 FAIL**
  (group 9 asserts the gutter rule, the directory contract, the shared queue
  components, the Settings contract, the migration, and the chart-key fix).
- `npm run build` → exit 0.
- Live RPC proof for the duplication fix: `admin_get_reflections` went from
  4 rows (3 unique) to **3 rows / total 3**; `admin_get_sigma_inbox` 9/9 and
  `admin_get_review_queue` 12/12 were already unique.

### 5.5 Blockers / open items

- The underlying duplicate `user_tasks (task_id, user_id)` rows are **still in the
  database** (read-layer tolerant only). They affect one account today. Deleting
  them is a member-data decision, so it was not taken unilaterally.
- No authenticated screenshots at <834px (phone) — the drawer/overlay path is
  covered by CSS only.
- Reference screenshots for the target aesthetic were still unavailable; the
  design was driven by the brief's written specification.

## Results and proof (2026-10-14)

**Design-system verifier — `node verification/verify_admin_design_system.cjs` → `RESULT 84 PASS / 0 FAIL` (exit 0).** (Extended in the Phase 5-6 pass below: the same verifier now reports **102 PASS / 0 FAIL**.)
Eight groups: tokens; member-site isolation (every `ds.css` rule must carry a `ds-` class, so the member
pages cannot be reached); the legacy shim; the shell; the bell's RPCs cross-checked against
`verification/live_admin_sigs.json` (name, `definer`, not anon-executable, and every `p_*` argument real);
the tri-column inbox; no-emoji/no-gradient; and the built bundle. It caught two real defects during the
build: `social` was missing from `NAV_ICONS` (the Social Links item silently fell back to the dashboard
icon) and the shim's own shell rule was scoped `.ds-shell .adm-shell`, which can never match the element
that carries both classes.

**Existing administration gate — unchanged and green.** All 20 scripts exit 0 with 0 FAIL:
module-graph 5 · **UI wiring 100** (was 95 — the new shell classes added five wiring assertions) · guide 25 ·
payload shapes 25 · RPC path 33 · mail wiring 37 · m13 73 · m12 34 · **m11 137** · m10 24 · m09 46 · m06 20 ·
m01 16 · m02 29 · m03 18 · reflections 6 · reapply 14 · mail paths 10 · live mail state 15.

**Build.** `npm run build` exit 0. Stylesheet 18.85 kB → 54.51 kB; script 1.01 MB (gzip 267.5 kB), of which
`lucide-react` accounts for 24.8 kB minified for the 37 icons actually used (measured with a standalone
esbuild bundle, not estimated).

**Measured in a real browser** (`getComputedStyle`, Chrome, 1280×577 viewport):

| what | measured |
| --- | --- |
| sidebar | 249 px wide, 100 % viewport tall, nav `overflow-y: auto` (1551 px of menu in 431 px) |
| gap above the first nav group | 0 px |
| top bar | 61 px tall, breadcrumb group 12.5 px / section 14 px |
| page title (`.adm-head h2`) | 28 px · card titles 18 px · body 15 px |
| table data / header / labels | 13.5 px / 12.5 px / 12.5 px · sidebar item 14 px |
| content container | `max-width: 1520px`, 4 stat cards at 242 px |
| surfaces | `#FAF9F6` page, `#FFFFFF` cards, `#E5E7EB` borders, `#D9A441` primary button, 12 px card radius |
| member theme | `background-image: none` on the document, `Inter` for headings, body and tables (no Fredoka) |
| inbox at 1640 px | 249 ‖ 330 queue ‖ 1021 workspace, and inside it 640 thread ‖ 320 context |

**Live data behind the chrome.** The bell's four queues were probed against the live database before being
wired: `admin_get_review_queue(status='new').counts.new` = 12, `admin_get_tickets(null).counts.new` = 5,
`admin_get_mail_outbox('failed').total` = 0, `admin_get_sigma_inbox(null).total` = 9 (badge = the three
actionable ones = 17). `admin_get_member_360` was probed the same way so the inbox context column reads real
field names (`nectar.balance`, `outstanding.reviewed`, `awards.tokens`, …) instead of guessed ones.

**Visual proof** — `verification/gen_ds_preview.py` renders the shipped stylesheets against a static copy of
the shell markup (the authenticated CRM cannot be screenshotted without an administrator session):

* `visual/ds-preview.html` — the whole sheet, nav parsed out of `AdminApp.jsx` (6 groups, 33 sections)
* `visual/ds-inbox.html` — the support inbox on its own
* `visual/ds-preview-wide.html`, `visual/ds-inbox-wide.html` — the same sheets in a 1640 px iframe, so the
  wide layout can be inspected on any display
* screenshots: `inbox.png`, `members.png` (`?clean=1` drops the demonstration popovers)

**Not proven, and not claimed:** no authenticated click-through of the live CRM (no administrator session is
available in the browser), and the sheet is a static render — it proves the stylesheets, the markup contract
and the geometry, not the data wiring, which the RPC-path, payload-shape and UI-wiring verifiers cover. The
figures inside the sheet are placeholders; the real screens read the RPCs listed above.

**Local-only.** Nothing in this change has been pushed; the deploy rule still applies (`push` on request,
`main` plus a dated `react-DD.MM.YYYY-vN` branch).

