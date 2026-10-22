# 13 - Mail transport: making the CRM actually send email

**Date:** 2026-10-14 · **Scope:** the mail leg of the admin CRM · **Status:** built, applied live,
proven at the database layer, verified 10/10 on the three send paths. One step remains, and it
needs a signed-in admin session (see *The last hop*).

## What was broken

The CRM could record a reply or a notification and nothing else. Probing the live database
before writing any code:

- No transport in the database at all: no `mail_outbox`, no queue/send RPC, no `pg_net`, and
  no DB-held provider credential.
- The three member-facing send paths **hardcoded `not_configured`** and described the message as
  staying in-app. `admin_reply_to_member`, `admin_reply_ticket` and
  `admin_send_member_notification` each wrote a status word that meant "we never tried".
- Rows left behind: `support_messages.email_status` = 6 x `not_attempted`;
  `member_reviews.member_response_delivery` = 12 x `stored_only`. Not one row anywhere recorded a
  send attempt, because there was no send to attempt.
- The only mail code in the project was the `send-welcome-email` edge function (Brevo), and it
  returns `success: true` even when Brevo rejects the message.

Per the brief, the transport stays Brevo. What was missing was the queue, the transmission leg,
and the honesty.

## What was built

**Migration 14 - `sql/2026-10-14-14-mail-transport.sql`** (applied live)

- `mail_outbox`: one row per message that was ever meant to leave, with `status`
  (`pending`/`sending`/`sent`/`failed`/`skipped`), `attempts`, `max_attempts`, `provider`,
  `provider_message_id`, `error`, `claimed_at`, `sent_at`, and the link back to the notification,
  review or ticket message that produced it. RLS on, no browser grants.
- `queue_email(...)` - the single entry point that creates an outbox row, and refuses honestly
  (status `skipped`, with a reason) when there is no recipient or no configured sender rather
  than pretending to have sent something.
- `admin_mail_flush_claim(...)` - the worker claim: returns rendered payloads for claimable rows
  and marks them `sending`. Internal, revoked from **`public` and `anon`**.
- `apply_mail_result(...)` - writes the provider's real answer back onto the outbox row, the
  notification row and the source message. `sent` and a `provider_message_id` are only ever
  written from a provider response.
- `admin_get_mail_outbox`, `admin_retry_mail`, `admin_queue_test_email` - the admin-facing RPCs,
  all gated by the existing `is_admin` / admin-permission helpers and revoked from `public`+`anon`.
- The three send paths rebuild to **queue and transmit** instead of hardcoding `not_configured`.
- Ends with `NOTIFY pgrst, 'reload schema'`.

**Edge function - `supabase/functions/send-mail/index.ts`** (deployed, JWT-protected)

The transmission leg. It takes the caller's own JWT, asks the database what it may claim
(`admin_mail_flush_claim` runs with the caller's identity, so permissions are decided
server-side), renders the stored HTML, calls Brevo, and records the true outcome through
`apply_mail_result`. A provider failure comes back as a failure with the provider's message - it
is not converted into a cheerful success. Verified live: unauthenticated and non-admin callers get
401/403, never a queued message.

**Admin UI** (`src/admin/mail.js`, `src/admin/sections-mail.jsx`, `src/admin/mail.css`,
`sections-crm.jsx`, `AdminApp.jsx`)

- A **Mail Queue** screen: every outbox row with its real status, recipient, attempts, provider
  error, plus *Send now* (flush), *Retry*, and *Send test email*.
- The review and ticket reply screens, and the member-notification form, now queue + transmit and
  display **the transport's own answer** (`queued`, `sent`, `failed`, `not_configured`), with the
  wording tied to the returned row so nothing can claim a delivery that did not happen.

## Two live regressions the probes caught

Both were found by running the real RPCs as a simulated authenticated admin session, not by
reading the code.

1. **Outbox vocabulary vs legacy CHECK constraints.** Migration 14 mirrored the outbox word
   `pending` into `admin_notifications.delivery_status`, `support_messages.email_status` and
   `member_reviews.member_response_delivery`, whose CHECK constraints do not allow it. The exact
   call raised `23514` - **all three send paths were dead on arrival**.
   Fix: **migration 15 - `sql/2026-10-14-15-mail-status-vocabulary.sql`** adds
   `mail_legacy_status(text, text)` and rebuilds the four functions **from their live definitions**
   so each writes a word its own CHECK allows while the outbox keeps its own vocabulary.
   The constraints were not loosened: that would have changed existing data semantics.
2. **A bigint where text was required.** The ticket subject render passed
   `coalesce(v_t.ticket_no, '')` - `ticket_no` is `bigint`, so the render raised
   `22P02 invalid input syntax for type bigint: ""` before any mail was queued. Fixed to
   `ticket_no::text` in migration 15.

## Evidence (this revision)

| check | result |
|---|---|
| `verify_mail_wiring.py` | 37 PASS / 0 FAIL (incl. a negative control: an unmapped status write fails the verifier) |
| `probe_mail_paths.py --live` | 10 PASS / 0 FAIL - notification, review reply and ticket reply all queue, and every staged row is deleted |
| `verify_admin_module_graph.py` | 5 PASS / 0 FAIL |
| `npm run build` | 0 |
| `oxlint src/admin` | 0 errors, 1 pre-existing warning (`sections-dashboard.jsx`) |

What `probe_mail_paths.py` proves, per path: the RPC succeeds under a simulated admin session, the
member-facing column records `queued`, and the outbox row is claimable and carries a rendered
payload for the right recipient (`to=<recipient>`, subject, `attempts`).

What it does **not** prove: that Brevo delivered an email. That is proved separately, end to end,
without a browser - `prove-live-mail.py` queues a test message through the real RPC and drives the
deployed `send-mail` function with an admin JWT, so the last hop is exercised by a script
(exit 0, Brevo returned a message id). See "The last hop" below.

## The last hop

Proved 14 October 2026 by `information/admin-crm/verification/prove-live-mail.py` (exit 0 - the
harness lives in the repository, not in the scratch directory, which is pruned): the script mints
an admin
session, calls `admin_queue_test_email`, invokes `send-mail`, and reads the ledger back
(`--read`) - the outbox row walks `pending` -> `sending` -> `sent` and Brevo's message id is
recorded. No browser and no human click is involved, and the script prints addresses masked and
credentials as lengths only.

An operator can repeat it by hand in the portal:

1. Open the admin portal (`http://127.0.0.1:5210/admin.html` in dev, or `/admin.html` where the
   React build is served) and sign in.
2. Go to **Mail Queue**, put a real address in the test field (your own), press **Send test email**
   - or reply to a ticket / review and watch the delivery line.
3. Read the ledger back: the outbox row goes `pending` -> `sending` -> `sent` with a Brevo message
   id, and the notification/message row records `sent`.

If Brevo refuses (unverified sender, bad key), the same ledger shows `failed` **with Brevo's own
error text** - which is the point of the design. The previous welcome-mail function would have
reported success.

## The replay hazard (found 14 October 2026)

The mail fix was briefly, silently undone - and by the project's own verification, not by a user.

`apply_verify_migration11.py` proves migration 11 still applies by **replaying its file against the
live database** (stage 0). Migration 11's file defines four functions the mail work later replaced:

    admin_reply_to_member, admin_reply_ticket, admin_send_member_notification,
    admin_get_integration_health

So every replay reset them to the pre-fix bodies: the CRM recorded `delivery_status = queued`
while queueing nothing, and the health block went back to "nothing can be emailed". The old gate
ran `probe_mail_paths.py` **before** the migration replays, so it passed, and then the replays
undid the fix at the end of every run. Nothing failed and nothing warned.

Two changes close it:

- **Order.** `run_admin_gate.sh` (in this directory) runs the migration replays first and the mail
  steps last, and the mail steps begin by re-applying migrations 14 -> 15 -> 16 in order
  (`reapply_mail_migrations.py`, idempotent; migration 14 uses `on conflict (key) do nothing`, so
  owner edits to the mail config survive). Any future verifier that replays an old migration
  belongs *above* that convergence block, never below it.
- **A guard.** `verify_mail_live_state.py` reads the live function bodies from `pg_proc` and fails
  if any send path has been reverted to a pre-fix body or if the health read is not the post-m16
  version. Negative-tested: after an intentional replay of migration 11 it reports
  `10 PASS / 5 FAIL` and names the fix; after the convergence block it is `15 PASS / 0 FAIL`.

Rule: a migration that replaces a function is only as durable as the last thing that touched that
function. Verify the live body, not just the file - and never let an old migration replay be the
final write.

## The gate, and two blind spots it had (14 October 2026)

`run_admin_gate.sh` is the runnable form of the documented order. Final result:
**662 PASS / 0 FAIL across 19 verifier scripts, exit 0, 0 throttle retries.**

Getting there exposed three harness defects, all of which had been reporting *clean*:

- **Rate limiting read as a code failure.** The management query endpoint answers a burst of
  SQL-heavy scripts with `429 ThrottlerException: Too Many Requests`. Verifiers with no retry
  turned that into `RESULT: cannot continue`, `APPLY FAILED: HTTP 429` and
  `cannot read fixtures: member=None task=None` - the last one blaming missing data for a
  transport limit. Every SQL-running verifier now retries on the throttle (6 attempts, 10s x
  attempt backoff) and prints the verbatim server text if it runs out; the gate spaces the
  scripts out (`GAP`, default 12s), retries a throttled script once after a longer pause
  (`RETRY_GAP`) and prints the retry count. A 429 is never a verdict.
- **The gate under-counted its own result.** The summary parser anchored the number to the start
  of the line, so scripts that summarise as `RESULT  137 PASS / 0 FAIL` scored zero: the gate
  printed 303 PASS for a run whose scripts had actually reported 662. It now reads the last
  `N PASS` / `N FAIL` in each script's whole output, handles both summary shapes
  (`137 PASS` and `PASS 16`), and prints `scripts reporting no count: N` so a silent miss is
  visible instead of hidden.
- **Two wiring warnings, only one of them real.** `verify_admin_ui_wiring.py` reported
  `admin_mail_flush_claim` as an unwired live RPC and four `adm-*` classes as undefined. The
  classes are defined in `mail.css`, which the check never read because it only scanned
  `admin.css` - so the check now scans every stylesheet of the admin surface. The RPC really is
  never called from the browser: the `send-mail` edge function calls it, which is the point of
  the transport. It is now listed in the verifier's intentional set **and** the verifier asserts
  the reason by finding the name in the edge function's source, so the exemption cannot rot.

Both warnings are gone (95 PASS / 0 WARN / 0 FAIL), and the wiring verifier's RPC coverage line
reads 102/117 live admin RPCs wired - the remainder being the intentional set above.

## Files

- `information/admin-crm/sql/2026-10-14-14-mail-transport.sql` (applied live)
- `information/admin-crm/sql/2026-10-14-15-mail-status-vocabulary.sql` (applied live, HTTP 201)
- `information/admin-crm/sql/2026-10-14-16-mail-health.sql` (applied live, HTTP 201)
- `supabase/functions/send-mail/index.ts` (deployed, `--use-api`)
- `src/admin/mail.js`, `src/admin/sections-mail.jsx`, `src/admin/mail.css`
- `src/admin/sections-crm.jsx` (reply + notification paths), `src/admin/AdminApp.jsx` (nav)
- `information/admin-crm/verification/verify_mail_wiring.py`,
  `information/admin-crm/verification/probe_mail_paths.py`
- `information/admin-crm/verification/prove-live-mail.py` (the live end-to-end proof; runs as an
  admin session, no browser) and `information/admin-crm/verification/probe-health.py` (reads the
  health block as a real admin session)
- `information/admin-crm/verification/reapply_mail_migrations.py` (convergence),
  `information/admin-crm/verification/verify_mail_live_state.py` (the guard),
  `information/admin-crm/verification/run_admin_gate.sh` (the gate, in the safe order)
