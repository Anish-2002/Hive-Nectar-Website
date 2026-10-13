# 11 — Phase A read layer (migration 13)

Date: 14 October 2026. Scope: `CRM LOGS REQUIREMENTS.md` §4 (dashboard), §6 (review inbox),
§9 (support/SLA), §13.3 (a new reflection must appear for review). Contract: administration
surface only — no member-facing behaviour, data semantics or game rule changed.

File: `sql/2026-10-14-13-ops-read-layer.sql`
Verifier: `verification/apply_verify_migration13.py` — **73 PASS / 0 FAIL**, exit 0.

## What shipped

7 admin read RPCs (all SECURITY DEFINER, JSONB, permission-gated, EXECUTE revoked from
`public`/`anon`, granted to `authenticated` + `service_role`):

| RPC | Args | Gate |
|---|---|---|
| `admin_get_dashboard_metrics` | `(timestamptz, timestamptz)` | `member.read`; billing/support/system blocks added only for `billing.read` / `support.read` / `health.read` |
| `admin_get_activity_feed` | `(int, timestamptz, timestamptz, text)` | `member.read`; admin-action rows only for `audit.read`, review/recognition/support rows for their own permission |
| `admin_get_reflections` | `(text, int, int)` | `review.read` |
| `admin_get_sigma_inbox` | `(text, int, int)` | `review.read` |
| `admin_get_ticket_history` | `(text, text, int, int, boolean)` | `support.read` |
| `admin_get_sla_stats` | `(timestamptz, timestamptz)` | `support.read` |
| `admin_get_member_360` | `(uuid)` | `member.read`; shipping PII only for `fulfilment.manage` |
| `admin_get_fulfilment_queue` | `(text, int)` | `recognition.read`; addresses only for `fulfilment.manage` |

Internal (EXECUTE revoked from every client role, `service_role` included where unused):
`sla_target_interval(text)`, `tg_support_ticket_sla()`, `review_queue_ingest()`.

## Three live defects this closes

1. **The review queue was never populated.** `member_reviews` held 0 rows while 3 reflections
   and 9 sigma logs existed — `admin_sync_review_queue()` exists in migration 11 but nothing
   ever called it, and no trigger existed, so the Review Centre was permanently empty and brief
   §13.3 was unreachable. Now: an `after insert` trigger on `task_sigma_logs` and `sigma_logs`
   enqueues a review item, plus a one-off backfill (12 items queued live). The trigger wraps its
   work in an exception guard so a queue problem can never block a member's submission — proven
   by stage 4, which submits as the member, sees exactly one queued item, then cleans up.
2. **SLA targets were never set.** `sla_due_at` existed on 1 of 6 tickets and
   `first_response_at` on 0, so every SLA figure was blank. Now a `before insert` trigger sets
   `sla_due_at` from `app_config` keys `sla_hours_urgent|high|normal|low` (defaults 4/8/24/72h,
   owner-editable without a deploy) and existing open tickets were backfilled.
3. **The Rewards/Fulfilment role could not open its own screens.** `fulfilment_manager` held
   `recognition.approve`, `fulfilment.manage`, `member.read`, `export.data` — but the gift and
   recognition read RPCs guard on `recognition.read`, which it did not have, so the role the
   brief creates for gift fulfilment could not list gifts. Its permission array now includes
   `recognition.read`.

## Verified behaviour (live, not asserted)

- Anonymous `set role anon` call → `42501 permission denied for function` (EXECUTE genuinely revoked).
- Signed-in member call → `42501 Forbidden` from `assert_admin_can`, for every new RPC.
- Admin (super-admin identity) call → real data: members 20 (free 15 / paid 5), 12 review items
  awaiting, 5 open tickets (5 overdue, avg age ~3,505h — the legacy queue), tier distribution,
  51 tokens, 40 milestones, 30-day series with signups/tasks/nectar per day.
- Reading changes nothing: nectar, tokens, milestones and submission counts identical before/after.
- The ingest proof left no residue: counts returned to the 3 / 12 baseline.

## Phase A still owed (in progress / deferred)

- UI: grouped collapsible nav, dashboard filters + charts, activity feed, reflections, sigma
  inbox, ticket history, gift fulfilment, member-360 drawer (in build).
- Deferred by owner decision: PollenPop, TRail/Resources, FAQ & KB, Feedback & Suggestions
  (no data model exists — inventing one needs the owner's content shape).
- Blocked on credentials/deployment, not on code: real email delivery (no Brevo secret,
  `send-email` 404s), verified Stripe revenue (webhook undeployed, `subscriptions` empty —
  membership truth currently lives in `profiles.subscription_*`).
