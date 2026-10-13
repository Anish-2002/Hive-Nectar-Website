# 12 - Phase A admin UI (grouped navigation, dashboard, six new screens)

Date: 14 October 2026. Brief: `CRM LOGS REQUIREMENTS.md` sections 3 (navigation and design
system), 4 (main dashboard), 6 (review centre), 7 (nectar/tasks/achievements), 8 (recognition
and physical gifts), 9 (support inbox and SLA), 5 (360-degree member profile).

## What shipped

| File | State | Lines |
|---|---|---|
| `src/admin/sections-phase-a.jsx` | new | 1310 |
| `src/admin/phase-a.css` | new | 247 |
| `src/admin/sections-dashboard.jsx` | new | 455 |
| `src/admin/dashboard.css` | new | 365 |
| `src/admin/AdminApp.jsx` | edited (flat `NAV` -> `NAV_GROUPS`) | 391 |
| `src/admin/sections.jsx` | edited (360 link, dynamic import) | 1993 |
| `src/admin/admin.css` | edited (collapsible group chrome) | - |

## Navigation

The sidebar was a flat list of 26 entries. It is now the six collapsible groups the brief
names, holding 32 sections:

- OVERVIEW (open) - Dashboard, Activity Feed, Analytics, Overview
- MEMBERS & RECOGNITION (open) - Members, Member Reviews, Reflections, Sigma Logs,
  Nectar & Impact, Impact Logs, Member Progress, Recognition & Rewards,
  Physical Gift Fulfilment, Memberships & Subscriptions
- THE MEADOW - Tasks, Themes & Stages, Tokens & Achievements, Milestones & Badges,
  Collaborations & Invitations
- COMMUNICATIONS - Support Inbox, Ticket History, Communication Board, Email & Notifications
- CONTENT & BUSINESS - Website CMS, Navigation Menu, Social Links, Policy Briefs, Founders
- OPERATIONS - Admin Team & Permissions, Audit Logs, System Health, Settings

Group headers are real `<button>` elements carrying `aria-expanded` and `aria-controls`, so
Enter/Space and a focus ring work without extra handlers. Open state is per group and
remembered in localStorage, and the group hosting the active section is always rendered open
(derived during render), so a deep link can never land on a hidden item.

**Screens the brief lists but the app cannot back with data do not appear as nav items**
(PollenPop, TRail/Resources, FAQ & Knowledge Base, Feedback & Suggestions, Billing &
Payments): the contract forbids a menu entry that leads nowhere. They stay deferred until the
owner defines their content model.

## Dashboard

Every figure comes from `admin_get_dashboard_metrics(p_from, p_to)`; nothing is computed in
the browser and nothing renders as a silent zero.

- 7/30/90-day presets plus a validated custom from/to; both re-query.
- Inline SVG charts drawn from the RPC's `series[]` (sign-ups, completed tasks, nectar), with
  axes and a `<title>` per point.
- The `support`, `billing` and `system` blocks are only returned to roles holding the matching
  permission; when one is absent the card reads "Not available for your role" rather than 0.
- Metric cards navigate through the app's own `onNavigate`, gated by `NAV_TARGETS`; the
  billing card is deliberately non-clickable because that screen is deferred.

## The new screens

- **Activity Feed** - one chronological stream over the live event tables (task completions,
  reflections, sigma logs, nectar, tokens, milestones, board posts, reviews, recognitions,
  support messages, admin actions, sign-ups) with date window and kind filter. Admin-action
  rows appear only to callers holding `audit.read`.
- **Reflections** - task reflections from `task_sigma_logs` with review status, paging and a
  drawer showing the full Define/Measure/Analyse/Improve/Control content.
- **Sigma Logs** - the general `sigma_logs` stream, same shape, same drawer.
- **Ticket History** - full ticket log with status/priority/overdue filters, paging, an
  `sla_state` pill per row, and an SLA strip (`admin_get_sla_stats`) showing open, overdue,
  unanswered, no-target, average open age, average first response, breaches and the live
  target hours.
- **Physical Gift Fulfilment** - the nine-stage open flow plus the four terminal states as a
  pipeline strip with live counts, a low-stock table, and the queue. Shipping addresses are
  shown only to callers holding `fulfilment.manage`; otherwise the row says the address is
  hidden for the role.
- **Member 360** - one RPC (`admin_get_member_360`) behind the brief's twelve tabs
  (overview, details, tasks, reflections, sigma, nectar/impact, tokens-badges-milestones, jar,
  collaborations, recognition, support, notes/audit) with an outstanding-review count in the
  header and per-tab counts. Shipping PII is gated on `fulfilment.manage`.

## Integration work done during verification

Found and fixed while wiring the two halves together:

1. **A static import cycle.** Linking the 360 drawer into the member record made
   `sections.jsx` and `sections-phase-a.jsx` import each other. The bundle still built, but
   ESM could evaluate one side half-built and throw at runtime, so the 360 drawer is now
   loaded with `React.lazy` + `Suspense` and the cycle is gone. `verify_admin_module_graph.py`
   now fails on any future cycle.
2. **A modifier class that styled nothing.** `admd-svg--bars` was applied to the bar chart but
   defined in no stylesheet; removed.
3. **An RPC with no screen.** `admin_get_sla_stats` shipped in migration 13 and nothing called
   it; the SLA strip now does.
4. **Two drawers, one concept.** `sections.jsx` already had a write-capable member drawer
   (edit, set points, revoke tasks/tokens/milestones, delete). Rather than replace it and lose
   those actions, the read-only 360 drawer is reachable from it via a "360 profile" button.
   Merging both into a single screen is offered but not done.

Five verifier expectations were also wrong and are corrected, not worked around: `Array.from`
read as table access; the NAV parser predating the grouped array; argument keys scraped from an
unrelated object after a call with prebuilt arguments; a line-wrapped nav label; and the
migration-11 enquiry check demanding `imported >= 1` from an importer that is idempotent by
design (it now also proves no enquiry is left unlinked).

## Verification (one gate run, this revision)

| check | result |
|---|---|
| `oxlint src/admin` | 0 errors, 1 warning (the fetch-in-effect pattern already used in `sections.jsx`) |
| `npm run build` | 0, `103 modules transformed`, built in 372ms |
| `verify_admin_module_graph.py` | 5 PASS / 0 FAIL |
| `verify_admin_ui_wiring.py` | 90 PASS / 0 WARN / 0 FAIL |
| `verify_guide_admin_section.py` | 25 PASS / 0 FAIL |
| `verify_crm_payload_shapes.py` | 25 PASS / 0 FAIL |
| `verify_admin_rpc_path.py` | 33 PASS / 0 FAIL |
| `apply_verify_migration13.py` | 73 PASS / 0 FAIL |
| `apply_verify_migration12.py` | 34 PASS / 0 FAIL |
| `apply_verify_migration11.py` | 137 PASS / 0 FAIL |
| `apply_verify_migration10.py` | 24 PASS / 0 FAIL |
| `apply_verify_migration09.py` | 46 PASS / 0 FAIL |
| `apply_verify_migration06.py` | 20 PASS / 0 FAIL |
| `reverify_migration01.py` | 16 PASS / 0 FAIL |
| `apply_verify_migration02.py` | 29 PASS / 0 FAIL |
| `apply_verify_migration03.py` | 18 PASS / 0 FAIL |
| `verify_reflections_flow.py` | 6 / 6 |

**Total for this revision: 581 checks PASS / 0 FAIL** across 16 verifiers, plus `oxlint` 0
errors and `vite build` 0.

## Not done

- The four model-less modules stay deferred (owner decision: define their content shape first).
- Real outbound email remains blocked (no Brevo secret; `send-email` 404s), so replies and
  notifications are stored in-app and the UI says exactly that.
- Browser click-through of the admin surface still cannot be done from this session (no admin
  credentials available here); the evidence above is mechanical plus live-RPC.
