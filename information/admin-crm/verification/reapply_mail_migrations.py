#!/usr/bin/env python3
"""Re-apply the mail migrations (14 -> 15 -> 16) to the live project, in order.

WHY THIS EXISTS
---------------
Two of the older migration verifiers REPLAY their migration file against the live
database (apply_verify_migration11.py stage 0, apply_verify_migration09.py).
Migration 11's file defines four functions that the mail work later replaced:

    admin_reply_to_member, admin_reply_ticket, admin_send_member_notification,
    admin_get_integration_health

so any replay of migration 11 silently resets them to the pre-fix bodies: the CRM
reports 'delivery_status = queued' without queueing anything, and the health block
goes back to saying nothing can be emailed.

This script converges the database back to the newest state. It is idempotent and
never touches data - migration 14 uses `on conflict (key) do nothing`, so owner
edits to the mail config are preserved.

Usage: /usr/bin/python3 information/admin-crm/verification/reapply_mail_migrations.py
Exit 0 only when all three applied and the invariants hold.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SQL = HERE.parent / "sql"
ORDER = [
    "2026-10-14-14-mail-transport.sql",
    "2026-10-14-15-mail-status-vocabulary.sql",
    "2026-10-14-16-mail-health.sql",
]

REPORT = r"""
select jsonb_build_object(
  'helper_exists', to_regprocedure('public.mail_legacy_status(text,text)') is not null,
  'helper_anon', coalesce(has_function_privilege('anon',
     (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'mail_legacy_status'), 'EXECUTE'), false),
  'outbox', to_regclass('public.mail_outbox') is not null,
  'still_writes_pending', (select coalesce(jsonb_agg(p.proname), '[]'::jsonb) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('apply_mail_result','admin_reply_to_member','admin_reply_ticket',
                         'admin_send_member_notification')
       and pg_get_functiondef(p.oid) like '%''pending''%'),
  'route_through_helper', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('apply_mail_result','admin_reply_to_member','admin_reply_ticket',
                         'admin_send_member_notification')
       and position('mail_legacy_status' in pg_get_functiondef(p.oid)) > 0),
  'health_live', (select position('Mail is live over' in pg_get_functiondef(p.oid)) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_get_integration_health')
) as r;
"""

PASS = 0
FAIL = 0


def check(label: str, ok: bool, detail=None) -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}  <<< {str(detail)[:400]}")


def creds() -> dict:
    env: dict[str, str] = {}
    path = Path(os.path.expanduser("~/.hive-nectar/credentials.env"))
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env


ENV = creds()
REF = ENV.get("SUPABASE_PROJECT_REF", "gxboojbfmpejbjolfmjq")
PAT = ENV.get("SUPABASE_ACCESS_TOKEN")


def run(sql: str, timeout: int = 300, attempts: int = 6):
    """POST one script. The management endpoint rejects transaction control
    (42601) and throttles bursts (ThrottlerException) - strip, then retry."""
    stripped = "\n".join(
        ln for ln in sql.splitlines()
        if not re.match(r"(?i)^\s*(begin|commit|start transaction|rollback)\s*;\s*$", ln)
    )
    last = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            f"https://api.supabase.com/v1/projects/{REF}/database/query",
            data=json.dumps({"query": stripped}).encode(),
            headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode() or "null"
                if "ThrottlerException" in body:
                    last = f"HTTP {r.status} {body[:200]}"
                    time.sleep(12 * attempt)
                    continue
                return r.status, json.loads(body)
        except urllib.error.HTTPError as e:
            text = e.read().decode()[:1200]
            if "ThrottlerException" in text or e.code >= 500:
                last = f"HTTP {e.code} {text[:200]}"
                time.sleep(12 * attempt)
                continue
            return e.code, text
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            time.sleep(4 * attempt)
    return 0, last


def first_row(res):
    if isinstance(res, list) and res:
        row = res[0]
        if isinstance(row, list):
            row = row[0] if row else {}
        if isinstance(row, dict) and len(row) == 1:
            only = next(iter(row.values()))
            if isinstance(only, dict):
                return only
        return row
    return res if isinstance(res, dict) else {}


print(f"project {REF}")
print("re-applying the mail migrations in order (a replay of migration 11 resets them)")

for name in ORDER:
    path = SQL / name
    if not path.exists():
        check(f"{name} present", False, path)
        continue
    status, res = run(path.read_text(encoding="utf-8") + "\n" + REPORT)
    rep = first_row(res) or {}
    ok = status in (200, 201) and isinstance(rep, dict) and "helper_exists" in rep
    check(f"{name} applied (HTTP {status})", ok, res)
    if ok:
        check("  the legacy-vocabulary helper is installed and not anon-reachable",
              rep.get("helper_exists") is True and rep.get("helper_anon") is False, rep)
        check("  the outbox ledger is installed", rep.get("outbox") is True, rep)
        # m14 alone writes 'pending'; m15 owns that fix, so the vocabulary
        # assertions are made from m15 onwards.
        if name != "2026-10-14-14-mail-transport.sql":
            check("  no send path writes the word 'pending'",
                  (rep.get("still_writes_pending") or []) == [], rep.get("still_writes_pending"))
            check("  4/4 send paths route through the mail_legacy_status helper",
                  rep.get("route_through_helper") == 4, rep.get("route_through_helper"))
        if name == "2026-10-14-16-mail-health.sql":
            check("  the health read is the post-m16 version",
                  rep.get("health_live") is True, rep.get("health_live"))

print("=" * 72)
print(f"  {PASS} PASS / {FAIL} FAIL")
if FAIL:
    print("The live mail paths are NOT in the newest state - do not use the CRM mail")
    print("screens until this is green (verify_mail_live_state.py explains the gap).")
sys.exit(1 if FAIL else 0)
