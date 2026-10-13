# 10 — Coverage of `CRM LOGS REQUIREMENTS.md` against the live system (14 October 2026)

The brief was re-sent by the owner as "this is new requirement". It is **byte-identical** to
the copy already governing this work: 395 lines / 17,235 bytes, `diff` clean against
`information/CRM LOGS REQUIREMENTS.md`. So this document is the brief's own mandatory step 1–3
(read the guide, inspect the real database, document what exists / what is broken / what must be
extended), done against live evidence rather than against the guide's prose.

Every claim below was read out of the production project on 14 October 2026: **58 tables,
161 functions in `public`, 103 of them `admin_*`**. Probes:
`cache/scratch/probe_brief_coverage.py`, `probe_brief_coverage2.py`.

## 1. Navigation: the brief asks for 33 items in 6 groups, the CRM has 26 flat entries

`src/admin/AdminApp.jsx:52-79` — one flat `NAV` array, no grouping, no collapsing.

| brief group | brief item | state | evidence / home |
|---|---|---|---|
| Overview | Dashboard | PARTIAL | `OverviewSection` exists; needs date filters, charts, clickable metric cards (brief §4) |
| Overview | Activity Feed | **MISSING screen** (derivable) | no feed table, but `admin_action_logs`, `member_review_events`, `recognition_events`, `nectar_ledger`, `user_tasks.completed_at` are all live sources |
| Overview | Analytics | PARTIAL | `AnalyticsSection` exists; needs date filters + trends |
| Members & Recognition | Members | PARTIAL | `MembersSection` + `admin_get_users`, `admin_get_user`; the 360° profile with 12 tabs and outstanding-review badges is not built |
| Members & Recognition | Member Reviews | DONE | `ReviewCentreSection`; live vocab exactly matches brief §6 (`new / in_review / needs_clarification / reviewed / flagged`); sources `task_reflection, sigma_log, task_evidence, badge_submission, milestone`; ingest via `admin_sync_review_queue` |
| Members & Recognition | Reflections | MISSING screen | data is live: `task_sigma_logs` (3 rows, DMAIC + `task_id`) is where task reflections live — there is no `reflections` table |
| Members & Recognition | Sigma Logs | MISSING screen | data is live: `sigma_logs` (9 rows, `define/measure/analysis/improve/control`) + `admin_get_sigma_logs`, `admin_delete_sigma` |
| Members & Recognition | Nectar & Impact | PARTIAL | `NectarLedgerSection`, `LogsSection`; `nectar_ledger` + `admin_get_nectar_ledger` + `admin_adjust_nectar` |
| Members & Recognition | Recognition & Rewards | PARTIAL | `RecognitionSection`; `recognitions` carries all 13 brief statuses verbatim |
| Members & Recognition | Physical Gift Fulfilment | PARTIAL | inside `RecognitionSection`; needs its own catalogue/stock/dispatch queue (`gift_catalogue`, `gift_stock_movements`, `admin_adjust_gift_stock`, `admin_get_gift_stock_movements`) |
| Members & Recognition | Memberships & Subscriptions | PARTIAL | `SubscriptionsSection`; **`subscriptions` is empty — the live source is `profiles.subscription_status/tier/current_period_end`** |
| The Meadow | Tasks | DONE | `TasksSection`, 150 tasks |
| The Meadow | Themes & Stages | PARTIAL | `ThemesSection`; stage data in `themes` / `theme_settings` / `theme_guardrails` |
| The Meadow | Tokens & Achievements | DONE | `TokensSection`; 70 tokens, `user_tokens`, `user_badge_progress` |
| The Meadow | Milestones & Badges | DONE | `MilestonesSection`; 32 milestones, `badge_stages` |
| The Meadow | Honey Jar | DONE (screen present) | `user_jar_decorations` (6 rows) + `admin_list_jar_decorations`, `save_jar_decorations` |
| The Meadow | Collaborations & Invitations | DONE | `CollaborationsSection`; `collaborations`, `collaboration_invites` |
| Communications | Support Inbox | DONE | `SupportInboxSection`; `support_tickets` (21 cols incl. `ticket_no`, `assignee_id`, `merged_into`) + `support_messages` (14) |
| Communications | Ticket History | MISSING screen | schema is live: statuses `new/open/pending_customer/pending_internal/resolved/closed`, priorities incl. `urgent`, `resolved_at`, `closed_at`, `reopened_at` |
| Communications | Communication Board | PARTIAL | `CommunicationsSection`; `admin_get_communications` / `admin_save_communication` / `admin_delete_communication` over `communications` (`post_type`, `title`, `content`, `icon`) |
| Communications | Announcements | PARTIAL | same table; **live data defect: `post_type` is free text with no allowlist — production rows read `Security`, `SECURITY`, `TEST`, `Update.`, `Announcements`, `Announcement`** (brief §3 demands canonical stored values + cleaned display) |
| Communications | Email & Notifications | PARTIAL | `NotificationsSection`; `admin_notifications` has `channel`, `delivery_status`, `delivery_error`, `attempts` (delivery history + retries). **Transport is dead** (`send-email` 404s, no Brevo secret) so this surface must keep saying "stored only" |
| Content & Business | Website CMS | PARTIAL | `admin_get_site_content(p_kind)` over 5 live kinds only: `hub_content` (7), `navigation_menu`, `social_links`, `policy_briefs`, `founders` |
| Content & Business | PollenPop | **MISSING** | no table, no function. Only trace: `support_tickets.source` already allows `'pollenpop'` |
| Content & Business | TRail / Resources | **MISSING** | no table, no function |
| Content & Business | FAQ & Knowledge Base | **MISSING** | no table, no function |
| Content & Business | Feedback & Suggestions | **MISSING** | only task-scoped `task_feedback`; `contact_inquiries.category` is free text holding `support/test/general` |
| Operations | Billing & Payments | **MISSING** | no payments/invoices/revenue table; `subscriptions` empty; `stripe_events` + `webhook_debug` exist but the webhook deployment is unverified (see §3) |
| Operations | Admin Team & Permissions | DONE | `TeamSection`; `admin_roles`, `admin_team_members`, `admin_invitations`, 7 roles |
| Operations | Audit Logs | DONE | `AuditSection`; `admin_action_logs` (10 cols) + `admin_get_audit_actions` |
| Operations | System Health | DONE | `IntegrationHealthSection`; `admin_get_integration_health` |
| Operations | Settings | DONE | `SettingsSection`; `admin_get_settings` / `admin_save_setting` / `admin_delete_setting` |

**Verdict: 9 done, 4 missing screens over live data, 12 partial, 4 with no data model at all
(PollenPop, TRail/Resources, FAQ & KB, Feedback & Suggestions), 1 blocked (Billing/Stripe).**

## 2. Real defects found while auditing (not assumptions)

1. **`communications.post_type` is uncontrolled free text.** Six production rows, six different
   spellings, one with a trailing period. Any Announcements screen that groups by type will show
   junk until this is canonicalised. Fix = allowlist + a mapping view that leaves stored values
   untouched (brief §3: "preserve canonical stored values even when the interface displays
   cleaned text").
2. **SLA due dates are not set on ticket creation.** `sla_due_at` is written only by
   `admin_update_ticket`; the insert path has no trigger for it. Response-time tracking therefore
   starts blank on every new ticket. `first_response_at` *is* automatic
   (`tg_support_message_rollup`). This is a one-trigger gap.
3. **`subscriptions` is empty while `profiles.subscription_*` carries the truth.** A billing
   screen reading `subscriptions` would show zero everywhere and look broken.
4. **`contact_inquiries.category` is free text** (`support`, `test`, `general`) and feeds ticket
   creation — same class as (1).
5. **No member-360 aggregate RPC.** Twelve tabs are wanted; the closest live calls are
   `admin_get_user`, `admin_get_member_subscription`, `admin_list_user_tasks`,
   `admin_list_user_tokens`, `admin_list_user_milestones`, `admin_list_theme_progress`,
   `admin_list_jar_decorations` — seven round trips, no outstanding-review count. One new
   `SECURITY DEFINER` RPC returning the whole profile payload (plus a review badge count) is the
   right shape and keeps the tab count at one request per tab.

## 3. Blockers that no amount of UI work can clear

- **Email.** `send-email` and `check-renewals` return 404; no Brevo/SMTP secret on the project.
  Every "reply to member", "notify", "announcement delivered" path can only be *stored*, and the
  UI must keep reporting `delivery_status` honestly (it already does).
- **Stripe.** `STRIPE_RESTRICTED_KEY` is present locally but the webhook function is undeployed
  and `subscriptions` is empty, so verified revenue/payment history cannot be rendered from the
  database alone. The brief says Stripe stays authoritative — this needs the webhook deployed and
  a secret configured, or a restricted key used from a server function.
- **No admin credential in the agent session** (vault prompts don't run under Telegram), so the
  CRM cannot be clicked through as an admin end to end; verification stays mechanical plus live
  RPC calls with real JWT claims.

## 4. Proposed build order (audit → architecture → implementation → verification per module)

**Phase A — backbone, no product decisions needed (all data is already live):**
1. Grouped, collapsible navigation matching the brief's 6 groups exactly (33 entries; the 4
   model-less modules appear only when their tables exist, so no nav item lands on a dead screen).
2. Dashboard: date filters, real trends, metric cards that navigate to their data.
3. Activity Feed from the five live event sources.
4. Reflections + Sigma Logs screens over `task_sigma_logs` / `sigma_logs` (with the review link).
5. Physical Gift Fulfilment screen split out of Recognition (catalogue, stock, dispatch queue).
6. Ticket History + SLA surfacing, plus the missing SLA-on-create trigger.
7. Member 360: one new `admin_get_member_360(p_user_id)` RPC + the 12-tab profile with
   outstanding-review counters.

**Phase B — content modules that need a small data model (needs the owner's content shape):**
FAQ & Knowledge Base, Feedback & Suggestions, TRail/Resources, PollenPop.

**Phase C — billing:** deploy the Stripe webhook, backfill `subscriptions`, then Billing &
Payments on top of real Stripe data.

**Phase D — canonicalisation:** `post_type` allowlist + display mapping; inquiry category
allowlist. Both are additive and do not rewrite stored values.

Each phase ships with a verifier in the house style (live PostgREST / management-API assertions, PASS/FAIL
counts, exit 0) and the guide/Wiring/`verify_admin_ui_wiring.py` gates re-run.

## 5. What is NOT claimed

No module above is reported as complete. The 9 "done" rows mean the screen exists and its RPCs
are live and verified — not that every paragraph of the brief for that module is satisfied (the
brief's §13 end-to-end list is only partially achievable while email and Stripe are undeployed).
