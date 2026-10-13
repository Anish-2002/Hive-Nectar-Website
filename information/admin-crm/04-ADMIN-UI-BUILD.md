# Admin CRM — build record (React port)

Status: **built, wired, and verified.** The administration surface now lives in the
React app at `/admin`, on top of the existing gated `admin_*` RPCs. Nothing in the
member experience was touched.

## What replaced what

| before | after |
|---|---|
| `CRM.html`, `admin-crm.html`, `admin_comms.html`, `admin_inbox.html`, `admin-achievements.html` — vanilla pages that wrote tables directly and were silently blocked by RLS | `/admin` — one React app that calls only gated RPCs |
| the old dashboard did call `get_admin_stats()` (which **exists** and is admin-gated, so it loaded for an administrator); its real defect was that its buttons wrote tables directly and were refused by RLS | `/admin` — one React app that calls only gated RPCs |
| `js/admin-crm.js:372` inserted `{title, content, …}` into `communications`; the table's `message` column is `NOT NULL` and every member reader renders `post.message`, so "Broadcast sent!" could never succeed | migration 01 adds `admin_save_communication`, which writes `message` and mirrors `content` |
| `get_admin_stats` has no subscriptions/analytics view; the subscriptions table existed but had no administrative read path at all | migration 02 adds the subscription and analytics reads behind Memberships / Analytics |

Old URLs redirect to `/admin`, so existing in-page links keep working.

## Files

| file | lines | role |
|---|---|---|
| `src/admin/AdminApp.jsx` | 199 | shell: gate, navigation, toast, sign-out |
| `src/admin/sections.jsx` | 1670 | 20 sections + the `SectionHead` / `RawTable` helpers |
| `src/admin/api.js` | 71 | RPC wrapper + formatters |
| `src/admin/admin.css` | 277 | `.adm-*` styles — cannot leak into member pages |
| `src/App.jsx` | 43 | `/admin` route + admin redirects |
| `information/admin-crm/sql/2026-10-13-01-communications.sql` | 169 | communications RPCs (applied) |
| `information/admin-crm/sql/2026-10-13-02-subscriptions-analytics.sql` | 336 | subscription + analytics RPCs (applied) |
| `information/admin-crm/sql/2026-10-13-03-site-content.sql` | 269 | website-content RPCs for the five content tables (applied) |

## The gate

`admin_ok()` is evaluated **as the caller** by the database. The browser never
decides who is an administrator, so hiding or unhiding a control is not the
security boundary. Anonymous callers get `false` (verified live); the app then
shows a sign-in prompt rather than a broken panel.

## Sections and the RPCs behind them

- **Overview** — `admin_get_stats` (18 metrics)
- **Members** — `admin_get_users`, `admin_get_user` (360 view), `admin_update_user`, `admin_set_points`, `admin_delete_user`
  - `admin_set_points(p_user_id, p_nectar, p_co2e)` is an **absolute set**, not a delta — the form says so and pre-fills the current value.
  - `admin_update_user` uses `COALESCE`, so the form sends only fields the administrator actually changed; it cannot silently blank a field.
- **Tasks / Themes / Tokens / Milestones** — `admin_get_*` + `admin_save_*(p_data)` + `admin_delete_*(…)`, forms generated from the live key lists
- **Communications** — `admin_get_communications`, `admin_save_communication`, `admin_delete_communication`
- **Support** — `admin_get_inquiries`, `admin_update_inquiry`, `admin_delete_inquiry`
- **Member progress** — `admin_list_user_tasks`, `admin_list_user_tokens`, `admin_list_user_milestones`, `admin_list_theme_progress`, `admin_list_jar_decorations` + their delete RPCs
- **Collaborations** — `admin_get_collaborations`, `admin_get_collab_invites` + deletes
- **Impact logs** — `admin_get_sigma_logs`, `admin_delete_sigma`
- **Configuration** — `admin_get_config`, `admin_save_config`, `admin_delete_config`
- **Administrators** — `admin_get_admins`, `add_admin`, `remove_admin`
- **Website content** (migration 03) — Hub items, Navigation, Social links, Policy briefs and
  Founders all ride one gated trio, `admin_get_site_content(p_kind)`,
  `admin_save_site_item(p_kind, p_data)`, `admin_delete_site_item(p_kind, p_id)`, where
  `p_kind` is one of `hub / nav / social / policy / founder`. The sections are the same
  config-driven CRUD component as Tasks and Themes, so each one lists, edits and deletes its
  own table without new bespoke UI.
- **Memberships** (migration 02) — `admin_get_subscriptions` (summary + Stripe-linked
  customers + subscription rows + recent events), `admin_get_member_subscription`
  (one member's billing state, looked up by profile id or email), `admin_set_member_tier`
- **Analytics** (migration 02) — `admin_get_analytics(window_days)`: all-time totals
  (17 counters incl. the tier distribution), per-theme progress, and two day-by-day
  series for the selected window

Coverage: **54/54** live admin RPCs.
`admin_update_subscription(p_id, p_data)` is wired to a repair panel under Memberships: it
edits a subscriptions row the Stripe webhook failed to write. The panel says as much, because
a later webhook event overwrites those fields — it is a repair tool, not a routine edit.

## Four real defects found and fixed while wiring the new sections

1. **`p_tier` looked missing.** The wiring verifier called `admin_set_member_tier`'s
   `p_tier` an unsupplied argument, which PostgREST would answer with a 404. A live
   probe returned `42501 permission denied` instead — the signature has `p_tier
   DEFAULT NULL`, so the call resolves. Fixed on both sides: the verifier is now
   **defaults-aware** (it reads `n_defaults` from the catalog), and the Memberships form
   now passes `p_tier` explicitly in the vocabulary the site already uses
   (`free / plus / steward / collective`) rather than relying on the default.
2. **The sidebar rendered unstyled.** `admin.css` defined `.adm-root/.adm-bar/.adm-nav/
   .adm-body`, but `AdminApp.jsx` renders `.adm-shell/.adm-side/.adm-brand/
   .adm-side-foot`. The two never met; the CSS was written against classes the app does
   not use. Fixed by rewriting the chrome block against the rendered classes, which is
   confirmed in the built stylesheet.

3. **Editing anything inserted a duplicate.** Every save RPC decides insert-versus-update by
   looking for `p_data->>'id'` (or `theme_id`). The forms never sent that key, so a save always
   took the insert branch — editing a task, token, milestone or theme quietly created a second
   row. Confirmed against the real function bodies for `admin_save_site_item` and
   `admin_save_task`, then fixed once, centrally: the shared CRUD component now carries a
   `primaryKey` per entity and includes it in the save payload. Same change added `listArgs`
   (for the content kinds) and `removeArgs(row)` (for the shared delete). One fix covers every
   entity, present and future.
4. **A verifier was reading a stale cache.** `dump_live_admin_sigs.py` wrote its JSON to a
   hardcoded scratch path while the packaged copy in `verification/` read a file beside itself,
   so the packaged verifier reported 51 functions after three more had gone live. The dump's
   output path is now derived from its own location, so the packaged verifier cannot read a
   stale catalog again.

Also fixed: the wiring verifier's ground truth was a hand-maintained markdown table
(pinned at 44 signatures), so adding migration 02 made it report four live functions as
missing. It now reads the **live `pg_proc` catalog** (`verification/dump_live_admin_sigs.py`),
with an offline fallback, so a later migration cannot make it lie.

## Verification performed

| check | result |
|---|---|
| `vite build` | clean |
| `oxlint src/admin` | 0 errors |
| RPC wiring vs the **live** catalog (`verification/verify_admin_ui_wiring.py`) | **32 PASS / 0 FAIL** over 54 live signatures — 54/54 wired |
| every read RPC called **as the administrator** through the real JWT path (`verification/verify_admin_rpc_path.py`) | **33 PASS / 0 FAIL** — incl. all three migration-03 reads, and each content kind returning its real row count (hub 7, nav 5, social 4, policy 3, founder 1) |
| the same reads with the anon key | **refused** (`permission denied`) |
| payload shape checked against the real function bodies (`verification/probe_payload_keys.py`) | section keys match live keys exactly |
| migration 01 re-verified | **16 PASS / 0 FAIL** |
| migration 02 re-verified | **29 PASS / 0 FAIL** |
| migration 03 verified (apply + behavioural probes, writes rolled back) | **18 PASS / 0 FAIL** |
| migration 03 write probes run inside a forced-rollback block | every kind exercised, production counts unchanged (7/5/4/3/1) |
| `admin_ok()` for an anonymous caller | `false` — gate holds |
| emoji / AI-look audit on admin source | none |
| member pages after the change | The Meadow, login render; console clean; legacy admin URLs redirect |

Not yet exercised end-to-end in a browser: the **write** buttons (save/delete/tier),
because this session has no administrator credential. Their argument names are verified
against the live signatures and their reads are proven to return data; the remaining
step is for an administrator to sign in at `/admin` and click through.

## Access control as measured (not assumed)

`pg_proc.proacl` on the migration 01/02/03 functions reads
`postgres, authenticated, service_role`: `PUBLIC` and `anon` were revoked, and
**`authenticated` retains EXECUTE** — which is exactly why the new sections work for a
signed-in administrator while the anon key is refused. The 41 pre-existing `admin_*`
functions still carry `PUBLIC` (the house default), and their `admin_ok()` guard is what
turns an anon call into `{"error":"Forbidden"}`. Tightening those 41 is a production change
with a wider blast radius than this build, so it is listed below rather than done
unilaterally. It is cosmetic, not a vulnerability: the guard is already the boundary. The
exact change, if you want it:

```sql
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'admin\_%'
      AND (p.proacl IS NULL OR EXISTS (
        SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

Rollback is the inverse grant (`GRANT EXECUTE ... TO PUBLIC, anon`) for any function named.

## Configuration this depends on

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Locally they live in `.env`
  (mode 600, now covered by `.gitignore`). **Vercel needs both set** as environment
  variables or `/admin` shows a configuration error instead of a panel.
- Deploys here are an rsync into a scratch clone, and rsync copies ignored files, so
  `.env` must be **excluded from the deploy command** — the ignore rule alone does not
  protect it.
- The anon key is public by design (it ships to every visitor inside
  `public/js/supabase-config.js`); `service_role` is never used by this app.

## Known limits (not blockers)

- `admin_update_user` cannot clear a field to NULL — `COALESCE` treats a missing key as
  "leave unchanged".
- Support has no assignee / resolution-history columns, so those workflow features need
  an additive schema change.
- The subscriptions table is empty until the Stripe backfill runs; Memberships therefore
  shows the Stripe-linked paying members (`members_paying`, from the customer map) as the
  real picture, and says so in the panel.
- **Still absent versus the contract's full scope**, each needing a new RPC: badges and
  badge stages, challenges, impact conversion, an audit trail of administrator actions,
  administrator email invitations + roles, and task comments/feedback. These are additive;
  nothing member-facing has to change.
- Two findings from the earlier audit remain unapproved and unaddressed:
  `handle_subscription_event(...)` is anon-reachable with no check (a forged
  `customer.subscription.updated` would grant paid tier), and
  `reset_user_progress_by_id` / `unlock_all_tasks_for_user` are callable by any
  signed-in member. Both need approval before a change.

## Served-tree hygiene (13 October 2026)

Three demo files were deleted from `public/`, because "remove anything that is not needed"
had to include them: `users.json` (plaintext demo credentials, served at `/users.json`),
`admin_comms.json` and `tasks_master.json` (static stubs). A whole-tree search found no
page, script or component referencing any of them, so member behaviour cannot change. The
rebuild leaves no copy in `dist/`, and a static serve of `dist/` answers `404` for all
three. Provenance copies + reasoning: `information/removed-demo-files/`.

`src/legacy/testjar.html` was **kept** — the filename is misleading, it is the Honey Jar lid
decorator, a real member page, and `import.meta.glob('../legacy/*.html')` in
`src/components/LegacyPage.jsx` bundles every file in that folder as a page.
