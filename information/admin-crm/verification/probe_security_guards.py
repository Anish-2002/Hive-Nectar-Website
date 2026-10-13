#!/usr/bin/env python3
"""Second probe: are the other anon-reachable non-admin_* functions already guarded,
and is anything depended on by an RLS policy (so revoking it would break member reads)?
"""
import json, os, sys, time, urllib.error, urllib.request

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


BODIES = """select p.oid::regprocedure::text as sig,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('get_admin_stats','is_admin','storage_admin','award_theme_tokens',
                     'check_and_award_milestones','increment_theme_stage_progress','update_user_levels')
 order by p.proname, 1"""

POLICY_DEP = """select ns.nspname as schema, c.relname as table_name, pol.polname as policy,
       left(pg_get_expr(pol.polqual, pol.polrelid), 200) as using_expr
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
 where pg_get_expr(pol.polqual, pol.polrelid) ilike '%is_admin%'
    or pg_get_expr(pol.polqual, pol.polrelid) ilike '%storage_admin%'
    or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%is_admin%'
    or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%storage_admin%'
 order by 1,2"""

WHAT_ROWS = """select 'user_tasks' t, count(*) n from public.user_tasks
 union all select 'user_milestones', count(*) from public.user_milestones
 union all select 'sigma_logs', count(*) from public.sigma_logs
 union all select 'user_tokens', count(*) from public.user_tokens
 union all select 'profiles', count(*) from public.profiles"""


def main():
    ok, rows = run(BODIES)
    if not ok:
        sys.exit(f"probe failed: {rows}")
    for r in rows:
        d = r["def"]
        guarded = ("admin_can" in d or "is_admin" in d or "admin_ok" in d
                   or "auth.uid() <> " in d or "assert_admin" in d or "Your role" in d)
        print("=" * 76)
        print(f"{r['sig']}  anon={r['anon_exec']}  auth={r['auth_exec']}  internally_guarded={guarded}")
        print(d[:1400])
    ok, rows = run(POLICY_DEP)
    print("=" * 76)
    print(f"RLS policies referencing is_admin()/storage_admin(): {len(rows)}")
    for r in rows:
        print(f"  {r['schema']}.{r['table_name']} :: {r['policy']}  USING {r['using_expr']}")
    ok, rows = run(WHAT_ROWS)
    print("=" * 76)
    print("row counts (destructive-function blast radius):")
    for r in rows:
        print(f"  {r['t']:<18} {r['n']}")


if __name__ == "__main__":
    main()
