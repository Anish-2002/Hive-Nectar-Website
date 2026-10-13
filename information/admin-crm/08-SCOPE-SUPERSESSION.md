# 08 — SCOPE SUPERSESSION (CRM LOGS REQUIREMENTS.md)

`information/CRM LOGS REQUIREMENTS.md` (395 lines, dropped into the tree
2026-10-13 22:51) is the **superset** of `CRM REQUIREMENT.md`. Where they differ,
this file governs. Both mandate the same method — Audit → Architecture →
Implementation → Verification — and the same prohibitions: no Twenty, no emoji, no
mock data, no dummy controls, no unverified completion claims, protect the live
member site.

## What it adds beyond the first brief

| New module | Live state today (probed 2026-10-13) |
| --- | --- |
| **Member Review Centre** (reflections + Sigma review, statuses New / In Review / Needs Clarification / Reviewed / Flagged, assignment, per-member outstanding counters) | Nothing. `task_sigma_logs` (3 rows) and `sigma_logs` are read by four `admin_get_sigma_logs`-style RPCs; there is **no review status, reviewer, date or note column anywhere**. New table + RPCs. |
| **Recognition & Physical Gift Fulfilment** (catalogue, SKU, stock, unit cost, 13-status workflow, address capture with consent, tracking) | Nothing. No gift, catalogue, stock, order or address table exists. Largest single new subsystem. |
| **Audit logs** for sensitive actions (nectar adjustments, gift approvals, address access, ticket replies, permission changes, destructive ops) | Nothing. No audit/action-log table exists. Must land early, because every later module has to write to it. |
| **Seven administrator roles** (Super Admin, Administrator, Member Reviewer, Support Agent, Rewards/Fulfilment Manager, Content Editor, Read-Only Analyst) with backend-enforced permissions and email invitations | Only a flat `admin_users` allowlist (1 row) and `is_admin`/`admin_ok`. Role model + invite tokens are new. |
| **Central notifications** (support replies, gift approvals, shipping, admin events) with delivery history and retries | Nothing. Depends on the blocked email path. |
| **Nectar ledger** with earned vs awaiting-review vs recognition split | No ledger table; `profiles.nectar` is a running total. Additive ledger only — no back-filled history may be invented. |
| **Member 360 with 12 tabs** and count badges for outstanding review | Partial: `admin_get_member_*` RPCs exist for progress, tokens, milestones, impact; there is no single profile aggregate and no review counters. |
| **System Health / integration health / webhook outcomes / scheduled jobs** | Partial: `stripe_events` (44 rows) and `webhook_debug` exist; `send-email` + `check-renewals` edge functions return **404** and `subscriptions` is empty. |

## Consequence for the build order

Audit logging and the role model are **cross-cutting**, so they come before the
feature modules that must write to them. Revised order:

1. **06** media/storage + reflections RLS — *applied and verified*.
2. **09** audit log + `admin_action_logs` writer + roles/permissions + invite tokens.
3. **10** Member Review Centre (reflections + Sigma review, counters).
4. **11** Support Centre (tickets, conversation, inbound matching) — blocked on a real
   email path; the blocker must be reported, not worked around.
5. **12** Recognition & Physical Gift Fulfilment.
6. **13** Nectar ledger + CMS/media library + settings.
7. **14** Notifications + System Health.
8. **15** Member 360 aggregate + dashboard metrics/charts wired to it.

Each ships as SQL + wiring + a packaged verifier in
`information/admin-crm/verification/`, as migrations 01–06 did, and each is
proven against the live database before the next starts.
