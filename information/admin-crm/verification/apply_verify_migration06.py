#!/usr/bin/env python3
"""Apply + verify migration 06 (storage policies + reflection table hardening).

Every assertion is proven against the LIVE database after the migration runs.
The negative test proves RLS is actually enforced (a cross-user insert as the
`authenticated` role must be rejected by the policy).
Exit code 0 = all PASS, 1 = FAIL.
"""
import json
import time
import os
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
HERE = Path(__file__).resolve().parent
SQL_FILE = HERE.parent / "sql" / "2026-10-13-06-storage-and-reflections.sql"

creds = {}
for line in Path(os.path.expanduser("~/.hive-nectar/credentials.env")).read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip().strip('"').strip("'")
TOKEN = creds["SUPABASE_ACCESS_TOKEN"]

PASS, FAIL = 0, 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}   {detail}")


def sql(q, expect_error=False, attempts=5):
    """Retry wrapper: the management API rate-limits bursts of queries with
    `ThrottlerException: Too Many Requests`, which must not surface as a check failure."""
    last = None
    for attempt in range(attempts):
        try:
            return _once(q, expect_error)
        except SystemExit as e:
            last = str(e)
            if "Too Many Requests" not in last and "429" not in last:
                raise
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    raise SystemExit(last)


def _once(q, expect_error=False):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or "[]"), None
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if expect_error:
            return None, body
        raise SystemExit(f"HTTP {e.code} on SQL:\n{q[:200]}\n---\n{body[:600]}")


# --------------------------------------------------------------------------
print("== apply migration 06 ==")
script = SQL_FILE.read_text()
pre = sql("select count(*)::int as n from storage.buckets")[0][0]["n"]
print(f"  buckets before: {pre}")
sql(script)
print(f"  applied {SQL_FILE.name} ({len(script.splitlines())} lines)")

# --------------------------------------------------------------------------
print("\n== 1. storage policies: scoped admin trio per bucket ==")
pol = {(r["policyname"]): r for r in sql("""
 select policyname, cmd, roles::text as roles, coalesce(qual,'') as q, coalesce(with_check,'') as c
   from pg_policies where schemaname='storage' and tablename='objects'
""")[0]}

for name, bucket in (("badges_admin_insert", "Badges"), ("badges_admin_update", "Badges"),
                     ("badges_admin_delete", "Badges"),
                     ("jar_admin_insert", "Jar"), ("jar_admin_update", "Jar"), ("jar_admin_delete", "Jar"),
                     ("policies_admin_insert", "Policies"), ("policies_admin_update", "Policies"),
                     ("policies_admin_delete", "Policies"),
                     ("theme_image_admin_insert", "Theme image"), ("theme_image_admin_update", "Theme image"),
                     ("theme_image_admin_delete", "Theme image")):
    p = pol.get(name)
    if not p:
        check(f"{name} exists", False, "policy missing")
        continue
    expr = (p["q"] + " " + p["c"])
    scoped = f"'{bucket}'" in expr
    gated = "storage_admin()" in expr
    check(f"{name} scoped to {bucket} + storage_admin()", scoped and gated,
          f"expr={expr[:90]!r}")

# the old unscoped policy must be gone
b = pol.get("badges_admin_insert", {})
check("badges_admin_insert no longer unscoped (check is NOT empty)",
      b.get("c", "").strip() != "", "check expression is empty -> still open to any bucket")

print("\n== 2. Token policies untouched (no regression) ==")
for n in ("token_admin_insert", "token_admin_update", "token_admin_delete"):
    check(f"{n} still present", n in pol)

print("\n== 3. task_sigma_logs closed ==")
t = sql("""select c.relrowsecurity as rls,
    (select count(*) from pg_policies pp where pp.schemaname='public' and pp.tablename='task_sigma_logs') as n
  from pg_class c join pg_namespace n2 on n2.oid=c.relnamespace
 where n2.nspname='public' and c.relname='task_sigma_logs'""")[0][0]
check("RLS enabled on task_sigma_logs", bool(t["rls"]), json.dumps(t))
check("4 owner policies exist", t["n"] == 4, f"n={t['n']}")

print("\n== 4. RLS is actually ENFORCED (negative test) ==")
# Act as an ordinary signed-in member whose uid is NOT the row owner.
# The insert must be rejected by the WITH CHECK policy.
victim = sql("select id::text from profiles limit 1")[0][0]["id"]
taskid = sql("select id::text from tasks limit 1")[0][0]["id"]
probe = f"""
begin;
set local role authenticated;
set local request.jwt.claims = '{{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}}';
insert into public.task_sigma_logs (user_id, task_id, define)
values ('{victim}'::uuid, '{taskid}'::uuid, 'rls-probe-should-fail');
rollback;
"""
_, err = sql(probe, expect_error=True)
low = (err or "").lower()
check("cross-user insert rejected by RLS",
      "row-level security" in low or "violates" in low,
      (err or "NO ERROR — insert was allowed!")[:180])

print("\n== 5. member self-insert still allowed (positive test) ==")
selfprobe = f"""
begin;
set local role authenticated;
set local request.jwt.claims = '{{"sub":"{victim}","role":"authenticated"}}';
insert into public.task_sigma_logs (user_id, task_id, define)
values ('{victim}'::uuid, '{taskid}'::uuid, 'rls-probe-self-ok');
rollback;
"""
_, err2 = sql(selfprobe, expect_error=True)
check("own-row insert accepted (rolled back)", err2 is None, (err2 or "")[:180])

print(f"\n=== RESULT: {PASS} PASS / {FAIL} FAIL ===")
raise SystemExit(1 if FAIL else 0)
