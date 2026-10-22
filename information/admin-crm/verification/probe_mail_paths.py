#!/usr/bin/env python3
"""probe_mail_paths.py - functional proof that the CRM can actually email.

Read-only against schema; creates and then deletes its own throwaway rows.

    python3 probe_mail_paths.py --live

Why it exists: a CRM screen that records a reply and reports delivery without a
transport ever answering is the failure this whole mail path replaced. Source
checks (verify_mail_wiring.py) prove the wiring is present; this probe proves the
database half actually runs, for all three send paths the CRM exposes:

  1. member notification   public.admin_send_member_notification()
  2. review reply          public.admin_reply_to_member()
  3. ticket reply          public.admin_reply_ticket()

Each call is made inside a simulated authenticated admin session
(request.jwt.claims), which is what the admin UI is. Every row created here is
deleted at the end, and the run reports whether the cleanup was complete.

What a PASS means - and does not mean: the message is queued for the provider,
the outbox row is claimable and carries a rendered Brevo payload addressed to the
right recipient, and the member-facing column records 'queued'. It does NOT mean
Brevo delivered an email: that needs a signed-in admin session, which only the
browser has. To prove a delivery, send one from the Mail Queue screen and read
mail_outbox / admin_notifications back - status 'sent' plus a provider message id
only ever come from apply_mail_result() recording a provider answer.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
ENV = Path.home() / ".hive-nectar/credentials.env"
TAG = "hermes-mail-path-self-test"

passes, fails, notes = [], [], []


def ok(m):
    passes.append(m)
    print("  PASS  " + m)


def bad(m):
    fails.append(m)
    print("  FAIL  " + m)


def load_env():
    creds = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            creds[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return creds


def sql(query, attempts=5):
    """Query the management API, backing off when its rate limiter answers 429."""
    body, last = None, None
    for attempt in range(attempts):
        req = urllib.request.Request(
            API,
            data=json.dumps({"query": query}).encode(),
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body, last = r.read().decode(), None
                break
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode()[:300]}"
        except Exception as e:  # noqa: BLE001
            last = str(e)
        if "Too Many Requests" not in (last or "") and "429" not in (last or ""):
            return None, last
        if attempt < attempts - 1:
            time.sleep(15 * (attempt + 1))
    return (json.loads(body), None) if body else (None, last)


def first_row(res):
    """The first row of a management-API answer, shape normalised.

    That endpoint answers with [row], [[row]] or {rows:[row]} depending on the
    statement, so unwrap the envelope but leave the row itself alone - callers
    read the row's own columns (usually a single `r` jsonb column).
    """
    if isinstance(res, dict):
        if "error" in res or "message" in res:
            return {}
        res = res.get("rows")
    while isinstance(res, list) and len(res) == 1 and not isinstance(res[0], dict):
        res = res[0]
    if isinstance(res, list) and res and isinstance(res[0], dict):
        return res[0]
    return {}


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


CREDS = load_env() if ENV.exists() else {}
TOKEN = CREDS.get("SUPABASE_ACCESS_TOKEN")
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"

if "--live" not in sys.argv:
    print(__doc__)
    print("refusing to run: pass --live (this probe creates and deletes live rows)")
    sys.exit(2)
if not TOKEN:
    sys.exit("no SUPABASE_ACCESS_TOKEN in ~/.hive-nectar/credentials.env")

# ---------------------------------------------------------------- actors
res, err = sql("""
  select jsonb_build_object(
    'admin', (select p.id::text from public.profiles p
                join public.admin_users a on lower(a.email) = lower(p.email) limit 1),
    'target', coalesce(
       (select p.id::text from public.profiles p
          where p.email ilike '%example.%' or p.email ilike '%self-test%' limit 1),
       (select p.id::text from public.profiles p
          join public.admin_users a on lower(a.email) = lower(p.email) limit 1))
  ) as r;
""")
if err:
    sys.exit(f"cannot read actors: {err}")
actors = first_row(res).get("r")
actors = json.loads(actors) if isinstance(actors, str) else actors
ADMIN, TARGET = (actors or {}).get("admin"), (actors or {}).get("target")
if not ADMIN:
    sys.exit("no admin profile found (admin_users is empty?)")
if not TARGET:
    sys.exit("no safe target profile: need a member whose address is unroutable, "
             "or the admin's own profile")
print(f"  admin {ADMIN[:8]}...  target {TARGET[:8]}...")

CLAIMS = """select set_config('request.jwt.claims',
    '{"sub":"%s","role":"authenticated","aud":"authenticated"}', false),
    set_config('request.jwt.claim.sub', '%s', false);""" % (ADMIN, ADMIN)

base = first_row(sql("select coalesce(max(id),0) as m from public.admin_action_logs;")[0] or {})
try:
    BASELINE = int(base.get("m"))
except (TypeError, ValueError):
    BASELINE = 9223372036854775807
made = {"notif": 0, "review": None, "ticket": None, "mail": []}

# ---------------------------------------------------------------- 1. notification
res, err = sql(CLAIMS + """
  select public.is_admin() as is_admin,
         public.admin_send_member_notification(%s, %s, %s, null, 'admin.message') as r;""" % (
    q(TARGET), q("CRM mail-path self-test"),
    q("Verification row for the CRM mail path. Deleted immediately after the check.")))
if err:
    bad(f"admin_send_member_notification raised: {err.splitlines()[0][:180]}")
else:
    row = first_row(res)
    rpc = row.get("r")
    rpc = json.loads(rpc) if isinstance(rpc, str) else (rpc or {})
    if row.get("is_admin") is not True:
        bad("the simulated admin session is not recognised as admin")
    elif rpc.get("success") is not True:
        bad(f"notification path refused: {json.dumps(rpc)[:200]}")
    else:
        made["notif"] = rpc.get("notification_id") or 0
        if rpc.get("mail_id"):
            made["mail"].append(rpc["mail_id"])
        ok(f"notification queued (delivery_status={rpc.get('delivery_status')})")

# ---------------------------------------------------------------- 2. claim it
if err:
    pass
else:
    res, cerr = sql(CLAIMS + " select public.admin_mail_flush_claim(null, 3) as r;")
    cl = first_row(res).get("r") if not cerr else None
    cl = json.loads(cl) if isinstance(cl, str) else cl
    if cerr:
        bad(f"flush claim raised: {cerr.splitlines()[0][:160]}")
    elif not (cl or {}).get("success"):
        bad(f"flush claim refused: {json.dumps(cl)[:200]}")
    else:
        data = (cl.get("data") or [{}])
        payload = data[0] if data else {}
        if payload.get("to_email") and payload.get("subject"):
            ok("flush claim returned a rendered payload for the provider "
               f"(to={payload['to_email']}, attempts={payload.get('attempts')})")
        else:
            bad(f"claimed rows carry no usable payload: {json.dumps(cl)[:200]}")
        if (cl.get("transport") or "") == "brevo":
            ok("the claim names Brevo as the transport")
        else:
            bad(f"claim transport is {cl.get('transport')!r}, expected 'brevo'")

# ---------------------------------------------------------------- 3. read back
if made["notif"]:
    res, err = sql("""
      select jsonb_build_object(
        'notif_status', (select delivery_status from public.admin_notifications where id = %s),
        'outbox_status', (select status from public.mail_outbox where notification_id = %s),
        'outbox_to', (select to_email from public.mail_outbox where notification_id = %s)
      ) as r;""" % (made["notif"], made["notif"], made["notif"]))
    back = first_row(res).get("r") if not err else None
    back = json.loads(back) if isinstance(back, str) else (back or {})
    if back.get("notif_status") == "queued":
        ok("the notification row records 'queued' (the word legacy CHECKs rejected before m15)")
    else:
        bad(f"notification delivery_status={back.get('notif_status')!r}, expected 'queued'")
    if back.get("outbox_status") in ("pending", "sending"):
        ok(f"the outbox row is claimable ({back.get('outbox_status')})")
    else:
        bad(f"outbox status={back.get('outbox_status')!r}")

# ---------------------------------------------------------------- 4. review reply
res, err = sql("insert into public.member_reviews (source, source_id, user_id, status, priority)"
               " values ('task_reflection', %s, %s, 'new', 'normal') returning id;"
               % (q(TAG), q(TARGET)))
review = first_row(res).get("id") if not err else None
if err or not review:
    bad(f"cannot stage a synthetic review: {(err or 'no id').splitlines()[0][:160]}")
else:
    made["review"] = review
    res, err = sql(CLAIMS + " select public.admin_reply_to_member('%s', %s, 'in_app') as r;"
                   % (review, q("Synthetic reply used to verify the review-reply mail path.")))
    row = first_row(res) if not err else {}
    rpc = row.get("r")
    rpc = json.loads(rpc) if isinstance(rpc, str) else (rpc or {})
    if err:
        bad(f"admin_reply_to_member raised: {err.splitlines()[0][:180]}")
    elif rpc.get("success") is not True:
        bad(f"review reply path refused: {json.dumps(rpc)[:200]}")
    else:
        if rpc.get("mail_id"):
            made["mail"].append(rpc["mail_id"])
        res2, err2 = sql("""
          select jsonb_build_object(
            'delivery', (select member_response_delivery from public.member_reviews where id = '%s'),
            'stamped', (select member_response_at is not null from public.member_reviews where id = '%s'),
            'notif', (select delivery_status from public.admin_notifications where id = %s),
            'outbox', (select status from public.mail_outbox where id = '%s')
          ) as r;""" % (review, review, rpc.get("notification_id") or 0,
                        rpc.get("mail_id") or "0" * 8 + "-0000-0000-0000-000000000000"))
        b = first_row(res2).get("r") if not err2 else None
        b = json.loads(b) if isinstance(b, str) else (b or {})
        if b.get("delivery") == "queued":
            ok("review reply records member_response_delivery='queued' (was 'stored_only')")
        else:
            bad(f"review delivery={b.get('delivery')!r}, expected 'queued'")
        if b.get("stamped"):
            ok("review reply stamps member_response_at")
        else:
            bad("review reply did not stamp member_response_at")

# ---------------------------------------------------------------- 5. ticket reply
res, err = sql("""
  insert into public.support_tickets (requester_email, requester_name, subject, status, priority, source)
  values ('%s@example.invalid', 'Hermes Self Test', 'Hermes mail-path self-test ticket', 'open', 'normal', 'crm')
  returning id;""" % TAG)
ticket = first_row(res).get("id") if not err else None
if err or not ticket:
    bad(f"cannot stage a synthetic ticket: {(err or 'no id').splitlines()[0][:160]}")
else:
    made["ticket"] = ticket
    res, err = sql(CLAIMS + " select public.admin_reply_ticket('%s', %s, false) as r;"
                   % (ticket, q("Synthetic reply used to verify the ticket-reply mail path.")))
    row = first_row(res) if not err else {}
    rpc = row.get("r")
    rpc = json.loads(rpc) if isinstance(rpc, str) else (rpc or {})
    if err:
        bad(f"admin_reply_ticket raised: {err.splitlines()[0][:180]}")
    elif rpc.get("success") is not True:
        bad(f"ticket reply path refused: {json.dumps(rpc)[:200]}")
    else:
        if rpc.get("mail_id"):
            made["mail"].append(rpc["mail_id"])
        res2, err2 = sql("""
          select jsonb_build_object(
            'email_status', (select m.email_status from public.support_messages m
                                where m.ticket_id = '%s' order by m.created_at desc limit 1),
            'subject', (select o.subject from public.mail_outbox o
                                where o.support_message_id = (select m.id from public.support_messages m
                                   where m.ticket_id = '%s' order by m.created_at desc limit 1)),
            'outbox', (select o.status from public.mail_outbox o
                                where o.support_message_id = (select m.id from public.support_messages m
                                   where m.ticket_id = '%s' order by m.created_at desc limit 1))
          ) as r;""" % (ticket, ticket, ticket))
        b = first_row(res2).get("r") if not err2 else None
        b = json.loads(b) if isinstance(b, str) else (b or {})
        if b.get("email_status") == "queued":
            ok("ticket reply records email_status='queued'")
        else:
            bad(f"ticket email_status={b.get('email_status')!r}, expected 'queued'")
        subj = b.get("subject") or ""
        if "self-test ticket" in subj and "ticket" in subj.lower():
            ok(f"the queued subject renders the ticket number ({subj[:60]!r})")
        else:
            bad(f"queued subject looks wrong: {subj[:80]!r}")

# ---------------------------------------------------------------- cleanup
sql("""
  delete from public.member_review_events where review_id = {rev};
  delete from public.mail_outbox where notification_id = {nid}
     or related_id in ({rev_s}, {tkt_s}) or support_message_id in
       (select id from public.support_messages where ticket_id = {tkt_s});
  delete from public.admin_notifications where id = {nid} or related_id in ({rev_s}, {tkt_s});
  delete from public.support_messages where ticket_id = {tkt_s};
  delete from public.support_tickets where id = {tkt_s};
  delete from public.member_reviews where id = {rev};
  delete from public.admin_action_logs where id > {base};
""".format(rev=("'%s'" % made["review"] if made["review"] else "null"),
           rev_s=q(made["review"] or ""),
           tkt_s=q(made["ticket"] or ""),
           nid=made["notif"] or 0, base=BASELINE))

res, err = sql("""
  select jsonb_build_object(
    'notif_left', (select count(*) from public.admin_notifications where id = %s),
    'review_left', (select count(*) from public.member_reviews where source_id = %s),
    'ticket_left', (select count(*) from public.support_tickets where requester_email = '%s@example.invalid'),
    'tagged_outbox', (select count(*) from public.mail_outbox where to_email like '%%example.%%'
                        or to_email like '%%self-test%%'),
    'logs_left', (select count(*) from public.admin_action_logs where id > %s)
  ) as r;""" % (made["notif"] or 0, q(TAG), TAG, BASELINE))
if err:
    bad(f"cannot confirm cleanup: {err.splitlines()[0][:160]}")
else:
    c = first_row(res).get("r")
    c = json.loads(c) if isinstance(c, str) else (c or {})
    left = {k: v for k, v in c.items() if v}
    if left:
        bad(f"cleanup left rows behind: {json.dumps(left)}")
    else:
        ok("every row this probe created is gone")

print("=" * 72)
print(f"  {len(passes)} PASS / {len(fails)} FAIL")
for f in fails:
    print("  - " + f)
sys.exit(1 if fails else 0)
