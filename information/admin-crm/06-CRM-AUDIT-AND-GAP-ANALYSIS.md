# 06 — CRM AUDIT AND GAP ANALYSIS (Phase 1)

**Brief:** `information/CRM REQUIREMENT.md` (387 lines, received 2026-10-13) — mandatory phases
**Audit → Architecture → Implementation → Verification**. This file is the **Phase 1 deliverable**.
**Project of record:** `The Meadows react.` (React/Vite port, byte-parity host of the live site).
**Site:** `https://www.hivenectar.earth` (Vercel) · **Backend:** Supabase project `gxboojbfmpejbjolfmjq`.

**Every number and every capability verdict below was read from the LIVE database on 2026-10-13**,
via read-only `SELECT` against `pg_class` / `pg_proc` / `pg_policies` / `information_schema` and
row counts per table. Nothing here is recalled from the guide or from an earlier session.
Raw captures: `cache/scratch/crm_brief_ground_truth.json`, `crm_audit_facts.json`.

---

## 1. Live ground truth

| Fact | Value |
| --- | --- |
| Tables in `public` | **42** |
| Functions in `public` | **102** |
| Admin RPC surface (`admin_*`) | **53** + `admin_ok()` gate = **54 gated, all 54 wired to the admin UI** |
| RLS policies in `public` | 70 |
| Storage buckets | **6** — `Token`, `Badges`, `Jar`(decorations), `Policies`, `avatars`, + theme imagery |
| Members | `profiles` **20** |
| Tasks | `tasks` **150** (`user_tasks` **170** completions) |
| Tokens | `tokens` **70** (`user_tokens` **51** awarded) |
| Milestones | `milestones` **32** (`user_milestones` **40** awarded) |
| Badges | `badges` **5**, `badge_stages` **20** — but `user_badge_progress` **0** |
| Communications | `communications` **7** |
| Support | `contact_inquiries` **6** — this is the ONLY support surface |
| Collaborations | `collaborations` **1**, `collaboration_invites` **12** |
| Feedback | `task_feedback` **12**, `task_comments` **1** |
| Stripe | `stripe_events` **44**, `products` **3**, `prices` **3**, `customers` **5**, `subscriptions` **0** |
| Config | `app_config` **3 rows** (`notification_email`, `notify_broadcast`, `site_url`), `theme_guardrails` **10** |
| Admins | `admin_users` **1 row**; `is_admin` = `profiles.email ∈ admin_users` |

**Tables that exist but have never held a row** (declared-but-dead scope, must be decided, not assumed):
`achievements`, `challenges`, `subscriptions`, `theme_stats`, `user_badge_progress`,
`user_challenge_progress`, `user_task_group_stats`.

---

## 2. Capability matrix — the brief's own navigation, audited

Status: **WORKING** = real table + real RPC/es + UI wired · **PARTIAL** = data exists, some
operations have no backend or no UI · **MISSING** = nothing behind it.

### Overview
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Dashboard | WORKING | `get_admin_stats`, `admin_get_stats`, `admin_get_analytics`, `admin_get_sigma_logs` — all wired | needs chart date filters + real error surfacing (never silent zero) |
| Activity Feed | PARTIAL | `sigma_logs` **8**, `task_sigma_logs` **3**, `stripe_events` **44** | no unified feed RPC; no actor/target/action normalisation |
| Analytics | WORKING | `admin_get_analytics` wired; migration 02 fixed the `stage` text bug | cohorts/task-activity series not yet exposed |

### Community
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Members | WORKING | `admin_get_users`, `admin_update_user`, `admin_delete_user`, `admin_set_member_tier` wired | no 360° detail RPC (subscription/history/badges/referrals/tickets in one payload) |
| Memberships & Subscriptions | PARTIAL | `admin_get_member_subscription`, `admin_update_subscription`, `downgrade_expired_subscriptions` | `subscriptions` **0 rows**; no Stripe-side actions; renewal dates NULL |
| Collaborations & Invitations | PARTIAL | `admin_get_collaborations`, `admin_get_collab_invites`, `admin_delete_*` wired | no approve/reject/expire action; `collaborations` has only 2 user refs, no state |
| Referrals | MISSING | `collaboration_invites.invitee_email` is the only referential trace | no referral table, no referral RPC, no attribution |

### The Meadow
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Tasks | WORKING | `admin_get_tasks`, `admin_save_task`, `admin_delete_task` wired | no duplicate/activate/archive/reorder/preview; no completion stats per task |
| Themes & Stages | WORKING | `admin_get_themes`, `admin_save_theme`, `admin_delete_theme`, `admin_delete_theme_progress` wired; `themes` 5, `theme_guardrails` 10 | stage editor is a raw text field; guardrails are displayed, **not enforced** |
| Nectar & Impact | PARTIAL | `impact_conversion` **11 rows**; `admin_get_sigma_logs` | no nectar ledger, no before/after adjustment RPC with reason |
| Tokens & Achievements | WORKING | `admin_get_tokens`, `admin_save_token`, `admin_delete_token`, `admin_get_user_tokens` wired | `achievements` table is EMPTY and unused (dead scope); artwork upload not exposed in UI |
| Milestones & Badges | PARTIAL | `admin_get_milestones`, `admin_save_milestone`, `admin_delete_milestone`, `admin_delete_user_milestone` wired; badges tables exist | no badge CRUD RPC at all; `user_badge_progress` empty; artwork upload not exposed |
| Honey Jar | PARTIAL | `user_jar_decorations` **6 rows**; `admin_delete_user_token` | no inspection RPC for a member's arrangement |

### Content
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Website CMS | WORKING | `hub_content` 7, `navigation_menu` 5, `social_links` 4, `policy_briefs` 3, `founders` 1 — five kinds wired via `admin_get_site_content` / `admin_save_site_item` / `admin_delete_site_item` | no media library, no draft/publish, no preview |
| Communication Board | WORKING | `admin_get_communications`, `admin_save_communication`, `admin_delete_communication` wired; `communications` 7 rows | the legacy broken path (`js/admin-crm.js:372` inserts without `message`) is superseded by migration 01; no scheduling |
| TRail / Resources | WORKING | `hub_content` rows with `category_slug`/`source_url` | no file upload pipeline |
| PollenPop | PARTIAL | content only | no request review/approve/reject with reason |
| Announcements | WORKING | same `communications` surface | audience targeting not modelled |

### Customer Experience
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Support Inbox | **MISSING** | **only `contact_inquiries` (6 rows)** | **no tickets, no conversation, no assignee, no status, no priority, no SLA — the brief's highest-priority module needs a new schema + RPCs** |
| Ticket History | MISSING | — | same |
| Knowledge Base / FAQ | MISSING | — | no table |
| Feedback & Suggestions | PARTIAL | `task_feedback` 12, `task_comments` 1 | no triage UI; no linkage to tasks in admin |

### Operations
| Module | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Payments & Billing | PARTIAL | `stripe_events` 44, `products`/`prices`/`customers` populated | no refund/cancel action; `subscriptions` empty |
| Email & Notifications | **BROKEN** | `config.js` → `sendEmail()` posts to `/functions/v1/send-email` | **edge function returns 404 → welcome, contact-notify and broadcast emails all fail silently** |
| Admin Team | PARTIAL | `admin_users` 1 row; `admin_get_admins`, `remove_admin`; `add_admin` hardened | **no roles, no permissions, no email invitations** |
| Audit Logs | PARTIAL | `sigma_logs` 8 | no actor/action/target/before-after audit trail for admin operations |
| System Health | MISSING | — | no integration health view |
| Settings | **BROKEN** | `app_config` 3 rows exist | **the public reader calls `get_all_config()`, which DOES NOT EXIST live** → config is permanently inert |

---

## 3. Confirmed defects (each verified against the live system)

1. **Config reader is dead.** `public/js/config.js` and `src/lib/supabase.js` both call
   `supabase.rpc('get_all_config')`. **No such function exists** — the only config RPC is
   `admin_get_config()` (admin-gated). Every `getConfig(key)` call therefore fails, logs
   `Failed to load config:` and returns `null`. Consumers are `signup.js`
   (`sender_name`, `welcome_email_subject`, `site_url`), `contact.js` (`notify_contact`,
   `notification_email`, `site_url`) and `admin-crm.js` (`notify_broadcast`) — all with
   `|| default` fallbacks, which is why nobody noticed.
   **Verdict: real, confirmed, currently harmless only because of the fallbacks.**
   The three live `app_config` values are byte-identical to those fallbacks, so restoring the
   reader is behaviour-preserving *today* — but it would *activate* the settings store, so it is
   listed for approval as an additive RPC (see §6, A1).
2. **Outbound email is dead.** `send-email` edge function → **404**; `check-renewals` → **404**.
   Three flows (signup welcome, contact-form admin notification, broadcast notice) all call it.
3. **Communication `message` vs `content` mismatch — confirmed.** Live `communications` has
   **both** columns. The legacy writer `public/js/admin-crm.js:372` inserts
   `{title, content, author_id, created_at}` while `message` is `NOT NULL` with no default →
   "Broadcast sent!" can never succeed. Migration 01 writes `message` **and** mirrors `content`.
4. **`badges_admin_insert` storage policy is over-permissive.** Its `with check` expression is
   **empty** — i.e. `true` for every `authenticated` user, with **no `bucket_id` restriction**.
   Any signed-in member can insert an object into **any** bucket. (The `Token` policies are
   correctly scoped by `bucket_id = 'Token' AND storage_admin()`.)
5. **No admin upload path for `Badges` replacement or for `Jar` / `Policies` / theme imagery.**
   `Badges` has INSERT only (no UPDATE/DELETE), so re-uploading a milestone/badge image cannot
   overwrite. Tokens are fine (`token_admin_insert/update/delete`).
6. **Five tables are RLS-OFF and anon-writable:** `achievements`, `challenges`,
   `impact_conversion`, `task_sigma_logs`, `theme_stats`. Enabling RLS blind could break member
   reads → must be preceded by an anon-write audit of the member pages (contract: no silent
   member-facing change).
7. **Security findings — REMEDIATED 13 October 2026** (owner: "Approved for 4 security
   finding / Fix that"). `handle_subscription_event(...)` was anon-reachable through a
   `PUBLIC` grant with no check → forging a Stripe event granted a paid tier (revenue
   bypass); `downgrade_expired_subscriptions`, `reset_user_progress_by_id` and
   `unlock_all_tasks_for_user` were anon-proof but callable by any signed-in member with an
   arbitrary `p_user_id`. Closed by `sql/2026-10-13-12-security-remediation.sql`, applied
   live and proven by `verification/apply_verify_migration12.py` (**34 PASS / 0 FAIL**).
   Full record, including the ten same-class functions deliberately left alone because they
   are the member gameplay flow, in **`09-SECURITY-REMEDIATION.md`**. The earlier minimal
   hardening is kept (anon EXECUTE revoked on 6 functions; `add_admin` internal guard).

### Legacy admin pages (to be retired by this CRM)
`public/js/admin-crm.js` (565 lines — 10 direct `.from()` writes, `localStorage` inbox/comms,
broken broadcast insert, calls gated `get_admin_stats`) · `public/js/admin.js` (18) ·
`admin-achievements.js` (**no gate at all**) · `admin-users.js` · `admin-tasks.js`.
All are superseded by `src/admin/` (54/54 RPCs wired, RPC-only, no direct table access).

---

## 4. Architecture (Phase 2)

**Decisions, all consistent with the contract's "administration replacement only":**

- **One database, one source of truth.** Supabase stays authoritative for members, tasks,
  progress, nectar, tokens, milestones, badges, content, tickets. No mirror, no second DB, no
  external CRM, no Twenty, no Docker.
- **The CRM is the existing `src/admin/` React app inside `The Meadows react.`**, served at
  `/admin`, gated by `is_admin()`. It keeps the Vercel deployment and the public site untouched.
  Optional later move to a private subdomain = set `VITE_*` env + deploy the same bundle.
- **RPC-only admin plane.** Every read and write goes through a `SECURITY DEFINER` `jsonb`
  RPC gated by `admin_ok()`. No `.from()` table access anywhere in admin code (RLS would block
  it anyway). Pattern per house convention:
  `admin_ok()` → `{success, data}` → `jsonb` → `REVOKE … FROM PUBLIC, anon` →
  write `message` and mirror `content` → `NOTIFY pgrst, 'reload schema';`.
- **Secrets never in browser code.** Only `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
  No service-role key, no SMTP secret, no Stripe secret in the repo. Server-authorised work
  happens in `SECURITY DEFINER` SQL or in an edge function holding its own env.
- **Media.** Uploads go to Supabase Storage from the admin session (admin-authenticated), and the
  resulting **public URL is written into the existing `icon_url` / `thumbnail_url` / `file_url`
  column** — matching exactly what is already stored today
  (`…/storage/v1/object/public/Token/Reflective/Seed….png`,
  `…/storage/v1/object/public/Badges/Nectar%20Progession/Worker10.png`). New bucket policies use
  the existing `storage_admin()` helper.
- **Roles.** `admin_users` grows a `role` column (`super_admin | admin | support_agent |
  content_editor | analyst`) with a permission matrix enforced **server-side in the RPCs**, plus
  table-level RLS. Super Admin is protected against lockout (cannot remove/demote the last one).
- **Audit.** One `admin_audit_log` table (actor, action, target_kind, target_id, before, after,
  at) written by every mutating admin RPC.
- **Support.** New ticket schema (see §5) with human-readable `HN-<n>` numbers, an inbound-email
  path keyed on a durable ticket reference in headers (not the subject), and Brevo delivery
  through a server-side function.

---

## 5. Implementation plan (Phase 3) — migrations `04…N`

| # | Migration | Deliverable | Acceptance tests covered |
| --- | --- | --- | --- |
| 04 | `04-support-centre.sql` | `support_tickets`, `support_messages`, `support_attachments`, `support_templates`, `ticket_counters`; `HN-#####` numbering; RPCs `admin_get_tickets`, `admin_get_ticket`, `admin_reply_ticket`, `admin_add_ticket_note`, `admin_update_ticket`, `admin_assign_ticket`, `admin_resolve_ticket`, `admin_reopen_ticket`, `admin_merge_tickets`; public `submit_support_request()` + tokenized `get_ticket_thread()` for visitors | **7, 8, 9, 10** |
| 05 | `05-admin-team-roles.sql` | `admin_users.role`, `admin_invites` (single-use, time-limited, hashed token), `admin_audit_log`, RPCs `admin_invite_admin`, `admin_accept_invite`, `admin_update_admin_role`, `admin_get_audit_log`; super-admin lockout guard | **11, 13** |
| 06 | `06-media-and-badges.sql` | tightened `badges_admin_insert` (+ UPDATE/DELETE scoped by bucket + `storage_admin()`), new policies for `Jar`/`Policies`/theme imagery; `admin_save_badge`, `admin_save_badge_stage`, `admin_delete_badge`, `admin_get_badges`, `admin_upload_asset` metadata RPC | **5** |
| 07 | `07-nectar-ledger-and-repairs.sql` | `nectar_ledger` (before/after, reason, actor), `admin_adjust_nectar`, `admin_repair_progress`, `admin_get_member_360` (single 360° payload) | **2, 3, 4** |
| 08 | `08-tasks-admin-extras.sql` | duplicate / activate / archive / reorder / preview RPCs; task completion stats; guardrail enforcement made real or removed from the UI | **3, 14** |
| 09 | `09-cms-and-settings.sql` | `get_all_config()` (public reader restore), `admin_save_config`, media library, PollenPop review RPCs, announcement audience | **6** |
| 10 | `10-content-restore-fix.sql` | **fix `get_all_config` (defect 1)** and the `message` mirror wherever still needed | **6, 14** |
| 11 | `11-stripe-portal.sql` | server-side cancel/refund via edge function; renewal-date backfill; `subscriptions` reconciliation | **12** |
| — | **Edge functions** | `send-email` (Brevo, server-side secret) and `stripe-webhook`/`check-renewals` deploy; `email_log` for delivery status + retry | **8, 12** |

**Deliberately NOT touched:** public pages, member experience, the task engine's earning rules,
tier semantics (`member_tier` drives access; `tier` is a display mirror), the 24-hour sequential
unlock, Novice/Experienced logic, `themes` visibility, RLS-off tables (until §3.6 is audited).

---

## 6. User addenda, 2026-10-13 (received after the brief)

- **A1 — Token + milestone image upload from the CRM.** `tokens.icon_url` and
  `milestones.icon_url` (and `badges.icon_url`) hold **full public Storage URLs today**. The admin
  forms must upload to the bucket, then write that URL. Requires: bucket policies for `Badges`
  UPDATE/DELETE (exists INSERT-only) and any bucket lacking a policy; a small upload helper in
  `src/admin/`; and the save RPCs must accept `icon_url` (verify the key lists — `admin_save_token`
  and `admin_save_milestone` take `p_data jsonb`, so this is a key-allowlist check, not new SQL).
- **A2 — "Admins should never have to log into Supabase."** Every module in §2 must reach
  WORKING, including Settings, Admin Team, badges, media and support. This is the CRM's acceptance
  bar and it drives migrations 04–11.
- **A3 — Broadcast notification icon persists ~24h.** A message-like icon lingers for 24 hours
  after a new communication is pushed. Investigated in the same pass — see
  `07-MEMBER-FIXES.md` for the root cause and fix.
- **A4 — Profile → Reflections must split into Pending / Submitted.** Pending = reflections not yet
  submitted (this is the number the reflection notification badge shows); Submitted = all
  submitted reflections, each with an eye icon to view and an edit action. See `07-MEMBER-FIXES.md`.

---

## 7. Verification plan (Phase 4)

The brief's 15 end-to-end checks are mapped to executable verifiers, in the house style already
proven in `information/admin-crm/verification/` (each returns a PASS/FAIL count and exits
non-zero on failure). Every claim in the final report must be backed by a run, and every mutation
must be proven by **read-back**, not by a click.

| Check | Verifier |
| --- | --- |
| 1 signup → visible | probe `profiles` count before/after a test signup |
| 2 search/detail authorised | anon + member + admin RPC call matrix |
| 3 task CRUD persists | SQL write → member-facing read-back |
| 4 nectar balance + audit | ledger before/after equality |
| 5 achievement mgmt | save → read-back → member display |
| 6 announcement content on site | `communications.message` non-empty → board read |
| 7–10 support lifecycle | full ticket journey with real writes + email log |
| 11 admin invitations | invite → accept → permission boundary test |
| 12 Stripe reports | compare RPC output vs `stripe_events` |
| 13 unauthorised denial | anon/other-member call → 42501 |
| 14 regression | public page smoke + member workflow |
| 15 build/startup | `npm run build` + dev-server health check |

---

## 8. Blockers and approvals needed

1. **Brevo credential** for a live `send-email` edge function (Brevo SMTP is `follydevs@gmail.com`).
   Without the secret the function can be deployed but cannot deliver — reported honestly, not mocked.
2. **Inbound email** requires a provider webhook (Brevo inbound or a forwarder to a webhook URL).
   Cannot be completed without that account-level configuration.
3. **RLS-off tables** (§3.6): approval to audit member writes, then enable RLS.
4. **Security findings** (§3.7): awaiting "full remediation".
5. **Dev Supabase project** still blocked (`POST /v1/projects` → 403, no organisations) → the
   CRM is developed against production with read-only probes and rollback-proof harnesses.
