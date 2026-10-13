#!/usr/bin/env python3
"""Live probe: which public functions are callable by anon / any signed-in member.

Prints (1) the target three with their definitions, (2) a sweep of every SECURITY
DEFINER public function with anon_exec / auth_exec flags so the same class of hole
can be caught anywhere else.
"""
import json, os, re, sys, time, urllib.error, urllib.request

REF = "gxboojbfmpejbjolfmjq"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
ENV = {}
with open(os.path.expanduser("~/.hive-nectar/credentials.env")) as fh:
    for line in fh:
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.strip().split("=", 1)
            ENV[k] = v
TOK = ENV["SUPABASE_ACCESS_TOKEN"]


def _once(q, timeout=180):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:900]
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:400]


def run(q, timeout=180, attempts=5):
    for attempt in range(attempts):
        ok, payload = _once(q, timeout)
        if ok:
            return ok, payload
        if "Too Many Requests" not in str(payload) and "429" not in str(payload):
            return ok, payload
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    return False, f"rate limited after {attempts} attempts: {payload}"


TARGETS = """select p.oid::regprocedure::text as sig,
       p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       coalesce(array_to_string(p.proacl::text[], ' '), '(default)') as acl,
       pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('handle_subscription_event', 'reset_user_progress_by_id',
                     'unlock_all_tasks_for_user', 'downgrade_expired_subscriptions')
 order by p.proname"""

SWEEP = """select p.oid::regprocedure::text as sig,
       p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
 order by 1"""


def main():
    ok, rows = run(TARGETS)
    if not ok:
        sys.exit(f"probe failed: {rows}")
    for r in rows:
        print("=" * 78)
        print(f"{r['sig']}  SECURITY DEFINER={r['prosecdef']}  anon={r['anon_exec']}  auth={r['auth_exec']}")
        print(f"acl: {r['acl']}")
        print(r["def"])
    ok, rows = run(SWEEP)
    if not ok:
        sys.exit(f"sweep failed: {rows}")
    exposed = [r for r in rows if r["prosecdef"] and (r["anon_exec"] or r["auth_exec"])]
    print("=" * 78)
    print(f"SECURITY DEFINER public functions reachable by anon or any signed-in member: {len(exposed)}")
    for r in exposed:
        print(f"  {'ANON' if r['anon_exec'] else '    '} {'AUTH' if r['auth_exec'] else '    '}  {r['sig']}")
    report = [r for r in rows if r["anon_exec"] and not r["sig"].startswith("admin_")]
    print("-" * 78)
    print("anon-reachable, non admin_* (sort by name to eyeball):")
    for r in sorted(report, key=lambda r: r["sig"]):
        print("   ", r["sig"])


if __name__ == "__main__":
    main()
