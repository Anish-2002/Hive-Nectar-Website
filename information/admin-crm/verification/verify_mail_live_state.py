#!/usr/bin/env python3
"""Verify the live mail transport is still the NEWEST version, not a stale replay.

WHY THIS EXISTS
---------------
Migrations are replayed by their own verifiers: `apply_verify_migration11.py`
stage 0 re-applies `2026-10-13-11-crm-modules.sql` to the live database to prove
the file still applies. That file defines four functions the mail work later
replaced - admin_reply_to_member, admin_reply_ticket,
admin_send_member_notification and admin_get_integration_health - so replaying
migration 11 SILENTLY REVERTS them to the pre-fix bodies that report
'delivery_status = queued' without ever queueing anything, and the health block
goes back to claiming that nothing can be emailed.

Nothing in the old verifier notices, because it only asserts migration 11's own
additions. This verifier is the guard: it reads what is live NOW and fails if the
mail paths are not the post-m14/m15/m16 versions.

It checks two independent things, both from pg_proc (no rows are created):
  1. the three CRM send paths and the health read are the newest ones;
  2. the health block describes the transport that is actually installed.

Run it AFTER migrations 14/15/16 are (re)applied. Fix = re-apply 14, then 15,
then 16 in that order; never hand-edit a function.

Usage: /usr/bin/python3 information/admin-crm/verification/verify_mail_live_state.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PASS = 0
FAIL = 0


def check(label: str, ok: bool, detail=None) -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}  <<< {str(detail)[:600]}")


def creds() -> dict:
    env: dict[str, str] = {}
    path = Path(os.path.expanduser("~/.hive-nectar/credentials.env"))
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    env.setdefault("SUPABASE_PROJECT_REF", "gxboojbfmpejbjolfmjq")
    return env


ENV = creds()
REF = ENV.get("SUPABASE_PROJECT_REF", "gxboojbfmpejbjolfmjq")
PAT = ENV.get("SUPABASE_ACCESS_TOKEN")
print(f"project {REF}")


def _once(query, timeout=240):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        method="POST",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:1500]
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def run(query, timeout=240, attempts=5):
    """The management API throttles bursts with ThrottlerException: retry it."""
    last = None
    for attempt in range(1, attempts + 1):
        ok, res = _once(query, timeout=timeout)
        blob = json.dumps(res, default=str)
        if ok and "ThrottlerException" not in blob:
            return ok, res
        last = res
        if "ThrottlerException" in blob or "Too Many Requests" in blob:
            time.sleep(6 * attempt)
            continue
        return ok, res
    return False, last


def first_row(res):
    if isinstance(res, dict):
        return res
    if isinstance(res, list):
        if not res:
            return {}
        row = res[0]
        if isinstance(row, list):
            row = row[0] if row else {}
        if isinstance(row, dict) and len(row) == 1:
            only = next(iter(row.values()))
            if isinstance(only, dict):
                return only
            if isinstance(only, list):
                return only          # {"r": []} -> []  (an empty result set)
        return row
    return res


def claims(uid):
    return ("select set_config('request.jwt.claims', "
            "json_build_object('sub','%s','role','authenticated')::text, true);" % uid)


# ---------------------------------------------------------------- 1. the bodies
# A stale body is one that no longer touches the outbox or the legacy-vocabulary
# helper. Compare against markers only the post-m14/m15 versions carry.
ok, res = run("""
select jsonb_build_object(
  'paths', (select jsonb_object_agg(p.proname, jsonb_build_object(
              'queues',        position('mail_outbox' in pg_get_functiondef(p.oid)) > 0
                               or position('queue_email(' in pg_get_functiondef(p.oid)) > 0,
              'helper',        position('mail_legacy_status' in pg_get_functiondef(p.oid)) > 0,
              'writes_pending',pg_get_functiondef(p.oid) like '%''pending''%',
              'live_marker',   position('Mail is live over' in pg_get_functiondef(p.oid)) > 0,
              'old_detail',    position('nothing can be emailed' in pg_get_functiondef(p.oid)) > 0,
              'chars',         length(pg_get_functiondef(p.oid))))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('admin_reply_to_member','admin_reply_ticket',
                        'admin_send_member_notification','admin_get_integration_health')),
  'helper_exists', to_regprocedure('public.mail_legacy_status(text,text)') is not null,
  'outbox_exists', to_regclass('public.mail_outbox') is not null,
  'queue_email_exists', to_regprocedure('public.queue_email(text,text,text,text,text,text,text,text,bigint,uuid)') is not null
) as r
""")
d = first_row(res) if ok else {}
check("the live function bodies could be read", ok and bool(d.get("paths")), res)
paths = d.get("paths") or {}

# order-independent naming: the ticket path is the one whose subject renders the
# ticket number, but for staleness the three send paths must all be current.
stale = sorted(n for n, v in paths.items()
               if n != "admin_get_integration_health"
               and not (v.get("queues") and v.get("helper") and not v.get("writes_pending")))
check("no CRM send path has been reverted to a pre-fix body",
      bool(paths) and not stale,
      f"stale (re-apply migrations 14 then 15 then 16): {stale}" if stale else "")

h = paths.get("admin_get_integration_health") or {}
# The old phrase survives inside a legitimate CASE branch ("when the queue
# function is missing"), so the discriminator is the new sentence, not the
# absence of the old one. A replayed migration-11 body has live_marker false.
check("the health read is the post-m16 version",
      h.get("live_marker") is True and (h.get("chars") or 0) > 3000,
      f"admin_get_integration_health is {h.get('chars')} chars "
      f"(pre-m16 = 2023, m16 = 3465, live marker = {h.get('live_marker')}) - re-apply migration 16")

check("the legacy-vocabulary helper is installed",
      d.get("helper_exists") is True, d.get("helper_exists"))
check("the outbox ledger is installed",
      d.get("outbox_exists") is True, d.get("outbox_exists"))
check("queue_email(text,text,text,text,text,text,text,text,bigint,uuid) is installed",
      d.get("queue_email_exists") is True, d.get("queue_email_exists"))

# ------------------------------------------------------- 2. nothing anon-reachable
ok, res = run("""
select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb) as r
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and (p.proname like 'mail\\_%' or p.proname like 'admin\\_%mail%')
   and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('public', p.oid, 'execute'))
""")
leak = first_row(res) if ok else None
check("no mail function is reachable by anon or PUBLIC",
      ok and (leak if isinstance(leak, list) else leak) == [], leak)

# ---------------------------------------------------- 3. the health block, live
ok, res = run("""
select jsonb_build_object('uid', p.id::text) as r
  from public.admin_users a join public.profiles p on lower(p.email) = lower(a.email)
 limit 1
""")
who = first_row(res) if ok else {}
uid = who.get("uid")
if not uid:
    check("an administrator exists to call the health read", False, res)
else:
    check("an administrator exists to call the health read", True)
    # Session role, not a transaction: the management query endpoint rejects
    # explicit transaction control (42601). See admin-verifier-hardening.md.
    ok, res = run(f"""
{claims(uid)}
set role authenticated;
select jsonb_build_object(
  'et', public.admin_get_integration_health() -> 'health' -> 'email_transport') as r;
reset role;
""")
    et = ((first_row(res) or {}).get("et") or {}) if ok else {}
    check("admin_get_integration_health() ran as a signed-in administrator", ok, res)
    check("the health block answers", bool(et), res)
    check("health names the installed transport",
          str(et.get("transport") or "").lower() == "brevo", et)
    check("health names the sender address", bool(et.get("sender")), et)
    check("health reports the transport ready", et.get("ready") is True, et)
    check("health carries the outbox counts",
          isinstance(et.get("waiting"), int) and isinstance(et.get("sent"), int)
          and isinstance(et.get("failed"), int), et)
    check("health no longer claims nothing can be emailed",
          "nothing can be emailed" not in str(et.get("detail") or ""), et)

print("=" * 72)
print(f"  {PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
