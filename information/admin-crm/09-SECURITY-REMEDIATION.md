# 09 — Security remediation of the four approved findings (13 October 2026)

The four findings recorded in `06-CRM-AUDIT-AND-GAP-ANALYSIS.md` §7 were approved for
remediation by the owner on 13 October 2026 ("Approved for 4 security finding / Fix that").
They are closed by `sql/2026-10-13-12-security-remediation.sql`, applied live and proven by
`verification/apply_verify_migration12.py` — **34 PASS / 0 FAIL**.

## What was actually wrong (measured, not assumed)

The starting point was a live probe of the whole privilege surface
(`verification/probe_security_surface.py`), which asked the database two questions per
function: *may `anon` execute it?* and *may any signed-in member execute it?*
(`has_function_privilege`). It returned 139 `SECURITY DEFINER` functions reachable by one or
both, and the four below are the ones that could change money, accounts or another member's
records with no inside check at all.

| # | Function | Reachable by | Impact |
|---|----------|--------------|--------|
| F1 | `handle_subscription_event(text,text,text,bigint,text)` | **anon** (the ACL carried a `PUBLIC` grant, `=X/postgres`) | Forge `checkout.session.completed` with a known `stripe_customer_id` and any of the three real `prod_…` ids and the account is granted `plus`/`steward`/`collective`; forge `customer.subscription.deleted` and a paying member is dropped to `free`. A revenue bypass and a denial-of-service on paying members. No session needed — plain `POST /rest/v1/rpc/handle_subscription_event` with the public anon key. |
| F2 | `downgrade_expired_subscriptions()` | any signed-in member | Any member could trigger a site-wide billing sweep. |
| F3 | `reset_user_progress_by_id(uuid)` | any signed-in member | Any member could wipe **any** other member's `user_tasks`, `user_milestones`, `sigma_logs`, `task_sigma_logs`, `user_task_group_stats`, `task_comments`, `task_feedback`, `user_theme_progress`, `user_badge_progress`, `user_challenge_progress`, `user_tokens` and reset their profile to zero (11 tables plus a profile rewrite). |
| F4 | `unlock_all_tasks_for_user(uuid)` | any signed-in member | Any member could mark every task complete for **any** member and rewrite their `nectar_points`, `total_tasks_completed`, `experience`, `user_level` and `engagement_level`. |

All three of F2–F4 were anon-proof (migration 01 had already revoked anon EXECUTE on six
functions) but none of them looked at *who* was calling.

## The fix

`sql/2026-10-13-12-security-remediation.sql` (203 lines, additive, re-runnable):

* **F1** — `revoke all` from `PUBLIC`, `anon` and `authenticated`, `grant execute` to
  `service_role`. Safe because the only legitimate caller is the Stripe webhook edge
  function, which authenticates with `SUPABASE_SERVICE_ROLE_KEY`
  (`information/supabase/functions/stripe-webhook/index.ts:11` — `createClient(supabaseUrl,
  supabaseServiceKey)`), and because no client code calls it anywhere (repo-wide grep over
  `js/`, `jsx/`, `html/`: zero matches).
* **F2** — kept callable by `authenticated` (so an administrator's browser session still
  works) but the body now opens with `perform public.assert_admin_can('billing.manage')`
  plus an audit row `billing.downgrade_expired`.
* **F3** — same shape, guarded by `member.write`, audited as `member.progress_reset`.
* **F4** — same shape, guarded by `member.write`, audited as `member.tasks_unlocked`.

The guard is `assert_admin_can`, the migration-09 helper that raises `42501` for a caller
with no session or no such permission. It is itself revoked from client roles, so it can
only run from inside a `SECURITY DEFINER` body — a client cannot call the guard directly
(asserted by the verifier).

Because the guard sits above the first statement, a refused caller changes **nothing**:
the verifier measures the blast radius (`user_tasks`, `nectar_points`, `user_tokens` before
and after) rather than assuming it, and confirms the forged-event attempt left the test
account's tier at `free`.

## How it was proven

`verification/apply_verify_migration12.py` applies the migration and then runs 34 checks
against the live database:

* **Privileges** — `has_function_privilege` for every role/function pair, including that
  `service_role` keeps `handle_subscription_event` and that the guard stays internal.
* **Behaviour as a real non-admin member** — `set local role authenticated` with the test
  member's claims (`0b336cd0-…`), so the *privilege* check is genuine rather than a faked
  claims GUC: all four calls are refused `42501`, and the member's three row counts and
  points are byte-identical afterwards.
* **Behaviour with no session at all** — `set local role anon`.
* **The administrator path is still open** — the same call as the primary admin
  (`04214ab6-…`) succeeds, and the audit row it writes is found in `admin_action_logs`.
  This is the no-false-positive check: a guard that also locks out administrators would be
  a broken feature, not a fix.
* **The 20 RLS policies that call `is_admin()`/`storage_admin()` still work** — those two
  helpers deliberately keep their grants (revoking them would break member reads such as
  `task_sigma_logs_select_own` and the storage upload policies).
* **The real endpoint refuses the real anon key** — `POST /rest/v1/rpc/…` with the public
  anon key returns `401 {"code":"42501","message":"permission denied for function …"}` for
  both F1 and F2.

## Deliberately NOT changed (same class, needs the owner's word)

These are reachable with an arbitrary `p_user_id` and have no inside check, but they are
the *existing member gameplay flow* — the public site calls them as the member plays, and
the standing contract forbids changing member-facing behaviour without approval:

`increment_theme_stage_progress(uuid,text,text)`,
`increment_theme_stage_progress(uuid,text,text,integer)`,
`update_user_levels(uuid)`, `reset_experienced_progress(uuid)`, `award_milestone(uuid,…)`,
`approve_badge_stage(uuid)`, `submit_badge_stage(uuid,…)`, `mark_milestone_viewed(uuid,bigint)`,
`mark_token_viewed(uuid,uuid)`, `complete_task(uuid,uuid,text)`.

Applying the same `auth.uid()` check the newer versions already use
(`award_theme_tokens` and `check_and_award_milestones` carry
`if p_user_id is distinct from auth.uid() then return 'Unauthorized'`) is the natural next
batch — it needs the member call sites checked first, because a legitimate call that passes
a stale user id would start being refused.

`is_admin(uuid)` and `storage_admin()` are also anon-reachable and were left alone on
purpose: 20 RLS policies call them, and the verifier asserts those grants survive.

## Residual risk after the fix

* The Stripe webhook depends on the edge function being deployed with its service-role
  secret. The grant side is proven (`service_role` still holds EXECUTE); the *deployment*
  was already known broken independently of this work (`send-email` and `check-renewals`
  return 404, no Brevo/SMTP secret), so billing events may not be arriving for a different
  reason. That is unchanged by migration 12 and remains on the open list.
* F2–F4 now refuse inside the database, but the legacy `public/js/admin-crm.js` page still
  carries a "downgrade expired" button; a plain `administrator` (which does not hold
  `billing.manage` by the migration-09 permission model) will now get an honest refusal
  from the server instead of a silent sweep. `super_admin` is unaffected.
