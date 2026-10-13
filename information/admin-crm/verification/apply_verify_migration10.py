#!/usr/bin/env python3
"""Apply + verify migration 10 (EXECUTE-privilege hardening for admin_* functions).

Checks the privilege catalogue before and after, proves an unauthorised anon call
is refused by the privilege system, and proves the three predicate functions the
RLS policies use still work for the roles that need them.

Prints PASS/FAIL counts; exits non-zero on the first failure.
"""
import json
import time, os, re, sys, urllib.request, urllib.error
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
MIG = HERE.parent / "sql" / "2026-10-13-10-grant-hardening.sql"

creds = {}
for line in Path(os.path.expanduser("~/.hive-nectar/credentials.env")).read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip().strip('"').strip("'")
TOK = creds["SUPABASE_ACCESS_TOKEN"]

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {extra}")


def _once(sql, timeout=180):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:700]
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:400]


def run(sql, timeout=180, attempts=5):
    """Retry wrapper: the management API rate-limits bursts of queries with
    `ThrottlerException: Too Many Requests`, which must not be reported as a check
    failure or as an administrator that cannot act."""
    last = None
    for attempt in range(attempts):
        ok, payload = _once(sql, timeout)
        if ok:
            return ok, payload
        last = str(payload)
        if "Too Many Requests" not in last and "429" not in last:
            return ok, payload
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    return False, f"rate limited after {attempts} attempts: {last}"


def first_row(payload):
    """The management API has wrapped single-row results as [row], [[row]] and
    [{"jsonb_build_object": row}]; unwrap all three."""
    if isinstance(payload, dict):
        if "data" in payload and isinstance(payload["data"], (list, dict)):
            return first_row(payload["data"])
        if set(payload) == {"jsonb_build_object"}:
            return payload["jsonb_build_object"] or {}
        return payload
    if isinstance(payload, list):
        return first_row(payload[0]) if payload else {}
    return {}


# Migration 10 left the three policy predicates executable by anon, so an anon caller
# got a plain `false` instead of an error. Migration 11 part 4 revoked the entire
# admin_* surface from anon, so the expectation is now the stronger one: nothing at all.
KEPT = ()

SHAPE = """
select jsonb_build_object(
  'total',   (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'admin\\_%' and p.prokind='f'
                 and p.prorettype <> 'pg_catalog.trigger'::regtype),
  'anon',    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'admin\\_%' and p.prokind='f'
                 and p.prorettype <> 'pg_catalog.trigger'::regtype
                 and has_function_privilege('anon', p.oid, 'execute')),
  'auth',    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'admin\\_%' and p.prokind='f'
                 and p.prorettype <> 'pg_catalog.trigger'::regtype
                 and has_function_privilege('authenticated', p.oid, 'execute')),
  'servicerole', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'admin\\_%' and p.prokind='f'
                 and p.prorettype <> 'pg_catalog.trigger'::regtype
                 and not has_function_privilege('service_role', p.oid, 'execute')),
  'anon_names', (select jsonb_agg(p.proname order by p.proname)
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'admin\\_%' and p.prokind='f'
                 and p.prorettype <> 'pg_catalog.trigger'::regtype
                 and has_function_privilege('anon', p.oid, 'execute')),
  'helpers_public', (select jsonb_build_object(
        'assert', (select has_function_privilege('anon', p.oid, 'execute') from pg_proc p
                    join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='assert_admin_can'),
        'writer', (select has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p
                    join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='log_admin_action'
                    order by p.oid limit 1))))
"""


def shape():
    ok, payload = run(SHAPE)
    return ok, first_row(payload)


print("== stage A: privilege shape before ==")
ok, before = shape()
check("privilege catalogue readable", ok, str(before)[:300])
print(f"      total={before.get('total')} anon_exec={before.get('anon')} "
      f"authenticated_exec={before.get('auth')}")

print("== stage B: apply migration 10 ==")
ok, data = run(MIG.read_text())
check("migration applied without error", ok, str(data)[:500])
if not ok:
    sys.exit(1)

print("== stage C: privilege shape after ==")
ok, after = shape()
check("privilege catalogue readable after apply", ok, str(after)[:300])

check("admin_* function count unchanged",
      after.get("total") == before.get("total"),
      f"{before.get('total')} -> {after.get('total')}")

check("anon may execute no admin_* function at all",
      sorted(after.get("anon_names") or []) == sorted(KEPT),
      f"got {after.get('anon_names')}")

check("anon EXECUTE count is zero", (after.get("anon") or 0) == 0,
      f"{before.get('anon')} -> {after.get('anon')}")

check("every admin_* function is callable by authenticated",
      after.get("auth") == after.get("total"),
      f"auth={after.get('auth')} total={after.get('total')}")

check("service_role keeps EXECUTE on every admin_* function",
      after.get("servicerole") == 0,
      f"{after.get('servicerole')} denied")

helpers = after.get("helpers_public") or {}
check("assert_admin_can is not an anon API", helpers.get("assert") is False, str(helpers))
check("log_admin_action is not a client API", helpers.get("writer") is False, str(helpers))

print("== stage D: the predicates are closed to anon but still behave for a signed-in member ==")
# NOTE: set_config('request.jwt.claims', ...) only fakes the claims GUC -- the statement
# still executes as the owning role, so it cannot prove that anon lacks EXECUTE. Privilege
# questions are answered with has_function_privilege; the live PostgREST probe is stage G.
ok, payload = run("""
select jsonb_build_object(
  'ok',   has_function_privilege('anon', 'public.admin_ok()', 'execute'),
  'can',  has_function_privilege('anon', 'public.admin_can(text,uuid)', 'execute'),
  'role', has_function_privilege('anon', 'public.admin_role_of(uuid)', 'execute')
);
""")
row = first_row(payload) if ok else {}
check("anon has no EXECUTE on admin_ok", row.get("ok") is False, str(row))
check("anon has no EXECUTE on admin_can", row.get("can") is False, str(row))
check("anon has no EXECUTE on admin_role_of", row.get("role") is False, str(row))
check("authenticated still holds EXECUTE on the predicates",
      first_row(run("select jsonb_build_object('ok', has_function_privilege('authenticated', 'public.admin_ok()', 'execute'));")[1]).get("ok") is True,
      "has_function_privilege('authenticated', admin_ok)")

MEMBER = "0b336cd0-c4e8-41e3-816b-68a47e824c35"
ok, payload = run(f"""
begin;
select set_config('request.jwt.claims', '{{"sub":"{MEMBER}","role":"authenticated"}}', true);
select jsonb_build_object(
  'ok_false',  public.admin_ok() is false,
  'can_false', public.admin_can('team.manage') is false,
  'role_null', public.admin_role_of() is null
);
rollback;
""")
row = first_row(payload) if ok else {}
check("admin_ok() returns false for a signed-in non-admin", row.get("ok_false") is True, str(row))
check("admin_can() returns false for a signed-in non-admin", row.get("can_false") is True, str(row))
check("admin_role_of() returns null for a signed-in non-admin", row.get("role_null") is True, str(row))

print("== stage E: a real unauthorised call is refused by the privilege system ==")
ok, payload = run("""
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select public.admin_get_team_overview();
rollback;
""")
msg = json.dumps(payload)
check("anon calling admin_get_team_overview raises a privilege error",
      (not ok) and ("42501" in msg or "permission denied" in msg.lower()),
      msg[:300])

print("== stage F: an authenticated administrator is unaffected ==")
ADMIN = "04214ab6-36b8-4e60-bbfc-c2d0764f9cf6"
ok, payload = run(f"""
begin;
select set_config('request.jwt.claims', '{{"sub":"{ADMIN}","role":"authenticated"}}', true);
select jsonb_build_object(
  'role',     public.admin_role_of(),
  'can_team', public.admin_can('team.manage'),
  'team',     jsonb_array_length(public.admin_get_team_overview()->'members'),
  'logs',     (public.admin_get_action_logs(5) ? 'rows')
);
rollback;
""")
row = first_row(payload) if ok else {}
check("the existing administrator still resolves to super_admin",
      row.get("role") == "super_admin", str(row)[:300])
check("team.manage still held", row.get("can_team") is True, str(row)[:300])
check("admin_get_team_overview still returns members", isinstance(row.get("team"), int), str(row)[:300])
check("admin_get_action_logs still returns a rows key", row.get("logs") is True, str(row)[:300])

print("== stage G: live PostgREST probe with the public anon key ==")
anon_key = None
for candidate in (ROOT / "public" / "js" / "supabase-config.js", ROOT / ".env"):
    if not candidate.exists():
        continue
    m = re.search(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+", candidate.read_text())
    if m:
        anon_key = m.group(0)
        break
if not anon_key:
    check("anon key found in public/js/supabase-config.js or .env", False, str(ROOT))
else:
    req = urllib.request.Request(
        f"https://{REF}.supabase.co/rest/v1/rpc/admin_get_team_overview",
        data=b"{}",
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    status, body = None, ""
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, body = r.status, r.read().decode()[:300]
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()[:300]
    check("live REST: anon admin_get_team_overview is refused", status in (401, 403),
          f"status={status} body={body}")
    req = urllib.request.Request(
        f"https://{REF}.supabase.co/rest/v1/rpc/admin_ok",
        data=b"{}",
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}",
                 "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, body = r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()[:200]
    check("live REST: admin_ok is refused for anon too (no EXECUTE at all)",
          status in (401, 403) and "42501" in body, f"status={status} body={body}")

print("=" * 72)
print(f"  {PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
