#!/usr/bin/env python3
"""verify_mail_wiring.py - the CRM mail path is wired end to end, in source.

Read-only. Exit 0 when every check passes.

The failure this catches: a reply/notification screen that records a message and
then reports delivery as if the transport had answered, when in fact nothing left
the building. Every mutation site must (a) call the token-forwarding transport
helper, and (b) show the transport's own answer. A hardcoded "not_configured" or a
fabricated success in a send path is a FAIL.
"""
import re
import sys
from pathlib import Path

ROOT = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
ADMIN = ROOT / "src/admin"
SQL = ROOT / "information/admin-crm/sql/2026-10-14-14-mail-transport.sql"
FN = ROOT / "supabase/functions/send-mail/index.ts"

passes, fails = [], []


def ok(m):
    passes.append(m)
    print("  PASS  " + m)


def bad(m):
    fails.append(m)
    print("  FAIL  " + m)


def read(p):
    return p.read_text(encoding="utf-8") if p.exists() else ""


# ---------------------------------------------------------------- 1. transport helper
mail = read(ADMIN / "mail.js")
if not mail:
    bad("src/admin/mail.js is missing - nothing can transmit queued mail")
else:
    if re.search(r"/functions/v1/send-mail", mail):
        ok("transport helper posts to the deployed send-mail function")
    else:
        bad("mail.js does not call /functions/v1/send-mail")
    if "getSession()" in mail and re.search(r"Authorization:\s*`Bearer \$\{token\}`", mail):
        ok("helper forwards the signed-in session token (the function authorises on it)")
    else:
        bad("helper does not forward the session token; the function would refuse every call")
    if re.search(r"if\s*\(!token\)", mail):
        ok("helper refuses to call without a session instead of faking a send")
    else:
        bad("helper does not guard against an absent session")
    if re.search(r"throw new Error\(`send-mail \$\{res\.status\}", mail):
        ok("non-JSON / error responses surface the HTTP status, not a success")
    else:
        bad("helper does not surface an unparseable transport response")
    if "mailSummary" in mail and re.search(r"status === 'sent'", mail):
        ok("mailSummary only says sent when a row came back sent")
    else:
        bad("mailSummary does not key its wording off the returned row status")

# ---------------------------------------------------------------- 2. every mutation site
crm = read(ADMIN / "sections-crm.jsx")
sites = {
    "review reply (admin_reply_to_member)": r"admin_reply_to_member",
    "ticket reply (admin_reply_ticket)": r"admin_reply_ticket",
    "member notification (admin_send_member_notification)": r"admin_send_member_notification",
}
for label, rpc_name in sites.items():
    i = crm.find(rpc_name)
    if i < 0:
        bad(f"{label}: RPC call not found in sections-crm.jsx")
        continue
    window = crm[i:i + 1800]
    if "sendQueuedMail(" in window:
        ok(f"{label} hands the queued row to the transport")
    else:
        bad(f"{label} never transmits (stored in-app only)")
    if re.search(r"queueLine\(|No email was queued", window):
        ok(f"{label} reports a refused queue honestly")
    else:
        bad(f"{label} does not report a queue refusal")

if re.search(r"sendQueuedMail", crm):
    ok("sections-crm.jsx imports the transport helper")
else:
    bad("sections-crm.jsx does not use the transport helper")

# ---------------------------------------------------------------- 3. no fake success
fake = []
for pat, label in [
    (r"notify\(['\"]Reply recorded['\"]\s*,\s*'ok'\)", "notify 'Reply recorded' without the transport result"),
    (r"notify\(['\"]Notification queued['\"]\s*,\s*'ok'\)", "notify 'Notification queued' without the transport result"),
    (r"notify\(internal \? ['\"]Internal note added['\"] : ['\"]Reply recorded['\"]\s*,\s*'ok'\)", "ticket notify without the transport result"),
]:
    if re.search(pat, crm):
        fake.append(label)
if fake:
    bad("fabricated success in a send path: " + "; ".join(fake))
else:
    ok("no send path reports success without the transport's answer")

# ---------------------------------------------------------------- 4. status vocabulary
if re.search(r"case 'not_configured'", crm) and re.search(r"case 'pending'", crm):
    ok("delivery vocabulary covers both the queued and the unconfigured state")
else:
    bad("delivery vocabulary is missing a real state (pending / not_configured)")

# ---------------------------------------------------------------- 5. queue screen reachable
app = read(ADMIN / "AdminApp.jsx")
if re.search(r"component:\s*MailSection", app) and re.search(r"from './sections-mail\.jsx'", app):
    ok("Mail Queue screen is imported and present in the nav")
else:
    bad("Mail Queue screen is not reachable from the admin nav")
if re.search(r"admin_get_mail_outbox", read(ADMIN / "sections-mail.jsx")):
    ok("queue screen reads the outbox through admin_get_mail_outbox")
else:
    bad("queue screen does not read the outbox RPC")

# ---------------------------------------------------------------- 6. database layer
sql = read(SQL)
if not sql:
    bad("migration 14 mail transport SQL is missing")
else:
    for fn in ["mail_outbox", "queue_email", "apply_mail_result", "admin_get_mail_outbox",
               "admin_mail_flush_claim", "admin_retry_mail", "admin_queue_test_email"]:
        if fn in sql:
            ok(f"migration 14 defines {fn}")
        else:
            bad(f"migration 14 does not define {fn}")
    if re.search(r"revoke all on function[^;]*from public, anon", sql, re.I):
        ok("internal mail functions are revoked from public AND anon")
    else:
        bad("internal mail functions are not revoked from both public and anon")
    if re.search(r"notify pgrst, 'reload schema'", sql, re.I):
        ok("migration 14 ends with a PostgREST schema reload")
    else:
        bad("migration 14 does not notify PostgREST (stale schema cache)")
    if re.search(r"not_configured", sql):
        ok("migration 14 still reports not_configured when no transport is configured")
    else:
        bad("migration 14 removed the honest not_configured state")

# ---------------------------------------------------------------- 7. edge function
fn = read(FN)
if not fn:
    bad("supabase/functions/send-mail/index.ts is missing")
else:
    if "BREVO_API_KEY" in fn:
        ok("edge function reads BREVO_API_KEY from its own secrets (never from the browser)")
    else:
        bad("edge function does not read BREVO_API_KEY")
    if re.search(r"admin_mail_flush_claim", fn) and re.search(r"apply_mail_result", fn):
        ok("edge function claims rows and writes the real outcome back")
    else:
        bad("edge function does not both claim and record")
    if re.search(r"^\s*if\s*\(!payload\)", fn, re.M) or "success: false" in fn:
        ok("edge function reports provider failures as failures")
    else:
        bad("edge function may report a provider failure as success")

# ---------------------------------------------------------------- 8. legacy vocabulary (migration 15)
# The trap this catches: the outbox keeps its own status words (pending / queued),
# but three legacy columns carry CHECK constraints that allow only their own
# vocabulary. Writing the outbox word straight into them fails at run time with
# 23514 - every send path dead. Each such write must go through the mapping helper.
M15 = ROOT / "information/admin-crm/sql/2026-10-14-15-mail-status-vocabulary.sql"
legacy = read(M15)
if not legacy:
    bad("migration 15 (mail status vocabulary) is missing - the send paths write "
        "outbox words into CHECK-constrained columns")
else:
    if re.search(r"create or replace function public\.mail_legacy_status", legacy, re.I):
        ok("migration 15 defines the mail_legacy_status mapping helper")
    else:
        bad("migration 15 does not define mail_legacy_status")
    for fn in ["admin_send_member_notification", "admin_reply_to_member",
               "admin_reply_ticket", "apply_mail_result"]:
        if re.search(r"create or replace function public\.%s\b" % fn, legacy, re.I):
            ok(f"migration 15 rebuilds {fn} against the live vocabulary")
        else:
            bad(f"migration 15 leaves {fn} writing a rejected status")
    body = re.split(r"create or replace function public\.mail_legacy_status", legacy, 1, flags=re.I)
    body = body[1] if len(body) > 1 else ""
    body = re.split(r"create or replace function public\.", body, 1)[0]
    # Live CHECK vocabulary (source: pg_get_constraintdef on the three columns).
    ALLOW = {
        "delivery_status": {"not_configured", "queued", "sent", "failed", "read"},
        "email_status": {"not_attempted", "not_configured", "queued", "sent", "failed"},
        "member_response_delivery": {"stored_only", "queued", "sent", "failed"},
    }

    def top_expr(s):
        """The expression right of an assignment, cut at a top-level , ; or keyword."""
        depth, out = 0, []
        for i, ch in enumerate(s):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif depth == 0 and ch in ",;":
                break
            elif depth == 0 and re.match(r"(where|return)\b", s[i:]):
                break
            out.append(ch)
        return "".join(out).strip()

    mapped = set(re.findall(
        r"(\w+)\s*:=\s*(?:coalesce\s*\(\s*)?public\.mail_legacy_status\s*\(", legacy))
    raw = []
    for col, allowed in ALLOW.items():
        for m in re.finditer(r"\b%s\s*=(?!=)" % col, body):
            expr = top_expr(body[m.end():m.end() + 240])
            if "mail_legacy_status(" in expr:
                continue                      # mapped at the site
            v = re.match(r"([A-Za-z_]\w*)$", expr)
            if v and v.group(1) in mapped:
                continue                      # a variable already mapped upstream
            lits = set(re.findall(r"'([^']*)'", expr))
            if lits and lits <= allowed and re.fullmatch(r"(?:'[^']*'|\s)+", expr):
                continue                      # a literal the column's CHECK allows
            raw.append("%s = %s" % (col, expr[:60]))
    if raw:
        bad("status written into a legacy CHECK column without mapping: " + "; ".join(raw[:3]))
    else:
        ok("every legacy status write is mapped, or a literal its CHECK allows")
    if "ticket_no::text" in legacy:
        ok("ticket render casts the bigint ticket_no to text")
    else:
        bad("ticket render still passes a bigint where text is required (22P02 at run time)")
    if re.search(r"notify pgrst, 'reload schema'", legacy, re.I):
        ok("migration 15 ends with a PostgREST schema reload")
    else:
        bad("migration 15 does not notify PostgREST (stale schema cache)")

print("=" * 72)
print(f"  {len(passes)} PASS / {len(fails)} FAIL")
sys.exit(1 if fails else 0)
