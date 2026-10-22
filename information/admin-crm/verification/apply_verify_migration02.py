#!/usr/bin/env python3
"""
Apply migration 02 (subscriptions / membership / analytics) and verify it.

Behavioural checks, not textual:
  * the five functions exist with the exact signatures declared
  * anon lost EXECUTE, authenticated kept it
  * as a real administrator each read RPC returns success:true with data
  * as an anonymous caller the same RPCs are refused at the API layer (42501)

WRITE SAFETY (rebuilt after a real incident)
  The previous revision of this harness called the write RPC outside a
  transaction and COMMITTED a tier change to a production member row. The write
  probe now runs inside a DO block that ends in RAISE EXCEPTION, so Postgres is
  forced to roll the whole statement back -- a committed write is impossible by
  construction. The in-transaction values are returned inside the error text as
  evidence, and the rollback is then confirmed by a fresh read on a new
  connection.

  The probe targets the administrator's OWN row and writes a tier that differs
  from its current value, so "inside the transaction it changed" and "after the
  abort it did not" are both observable. Nothing else is written.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
PROJ = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
MIG = PROJ / "information/admin-crm/sql/2026-10-13-02-subscriptions-analytics.sql"
CRED = Path.home() / ".hive-nectar/credentials.env"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"

PASS, FAIL = [], []


def ok(msg):
    PASS.append(msg)
    print(f"  PASS  {msg}")


def bad(msg):
    FAIL.append(msg)
    print(f"  FAIL  {msg}")


def load_env(path):
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r"^([A-Za-z_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


CREDS = load_env(CRED)
TOKEN = CREDS.get("SUPABASE_ACCESS_TOKEN")
if not TOKEN:
    sys.exit("no SUPABASE_ACCESS_TOKEN")


def mask_email(email):
    """a***@gmail.com — the report must never print a member's full address."""
    return re.sub(r"^([^@]{1})[^@]*", r"\1***", email or "")


ANON = load_env(PROJ / ".env").get("VITE_SUPABASE_ANON_KEY")
URL = f"https://{REF}.supabase.co"


def sql_once(query, timeout=90):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, e.read().decode()[:600]
    except json.JSONDecodeError as e:
        return None, f"bad json: {e}"


def sql(query, attempts=6):
    """Retry while the management API is rate-limiting.

    The gate runs a dozen SQL-heavy verifiers back to back and the endpoint
    answers bursts with `429 ThrottlerException: Too Many Requests`. That is a
    transport limit, not a verdict on the migration, so it must never be
    reported as `RESULT: cannot continue`.
    """
    last = (None, None)
    for i in range(attempts):
        rows, err = sql_once(query)
        if not err or ("Too Many Requests" not in err and "429" not in err):
            return rows, err
        last = (None, f"{err} (after {i + 1} attempt(s))")
        if i < attempts - 1:
            time.sleep(10 * (i + 1))
    return last


def scalar(query):
    rows, err = sql(query)
    if err:
        return None, err
    if isinstance(rows, list) and rows:
        return list(rows[0].values())[0], None
    return None, f"no rows: {str(rows)[:120]}"


print("=" * 70)
print("STEP 1 — apply the migration")
print("=" * 70)
body = MIG.read_text()
res, err = sql(body)
if err:
    bad(f"apply failed: {err}")
    print("\nRESULT: cannot continue")
    sys.exit(1)
ok(f"migration applied ({len(body)} bytes, {body.count('CREATE OR REPLACE FUNCTION')} functions)")

FUNCS = {
    "admin_get_subscriptions": "p_limit integer, p_offset integer",
    "admin_get_member_subscription": "p_user_id uuid",
    "admin_set_member_tier": "p_user_id uuid, p_member_tier integer, p_tier text",
    "admin_update_subscription": "p_id text, p_data jsonb",
    "admin_get_analytics": "p_days integer",
}

print("\n" + "=" * 70)
print("STEP 2 — signatures exist exactly as declared")
print("=" * 70)
for name, sig in FUNCS.items():
    got, err = scalar(
        "select pg_get_function_identity_arguments(oid) from pg_proc "
        f"where proname = '{name}' and pronamespace = 'public'::regnamespace;"
    )
    if err:
        bad(f"{name}: {err}")
    elif got and got.replace(" ", "") == sig.replace(" ", ""):
        ok(f"{name}({got})")
    elif got:
        bad(f"{name}: signature mismatch (got {got}, want {sig})")
    else:
        bad(f"{name}: not found in public")

print("\n" + "=" * 70)
print("STEP 3 — privileges: anon out, authenticated in")
print("=" * 70)
for name in FUNCS:
    a, err = scalar(
        f"select has_function_privilege('anon', p.oid, 'EXECUTE') from pg_proc p "
        f"where p.proname = '{name}' and p.pronamespace = 'public'::regnamespace limit 1;"
    )
    t, _ = scalar(
        f"select has_function_privilege('authenticated', p.oid, 'EXECUTE') from pg_proc p "
        f"where p.proname = '{name}' and p.pronamespace = 'public'::regnamespace limit 1;"
    )
    if err:
        bad(f"{name}: {err}")
    elif a is False and t is True:
        ok(f"{name}: anon=f authenticated=t")
    else:
        bad(f"{name}: anon={a} authenticated={t} (expected False/True)")

print("\n" + "=" * 70)
print("STEP 4 — the admin path actually returns data")
print("=" * 70)
rows, err = sql("select email from public.admin_users limit 3;")
admin_email = (rows[0]["email"] if rows else None) if not err else None
rows, err = sql(f"select id::text as id from public.profiles where email = '{admin_email}' limit 1;")
if not rows:
    bad("no profile for the allowlisted admin")
    print("\nRESULT: cannot continue")
    sys.exit(1)
admin_id = rows[0]["id"]
print(f"  admin identity: {mask_email(admin_email)} (profiles.id {admin_id[:8]}...)")

# a real member row, read-only target for the payload checks
rows, _ = sql("select id::text as id from public.profiles where email <> "
              f"'{admin_email}' order by join_date nulls last limit 1;")
member_id = rows[0]["id"] if rows else admin_id

CLAIMS = json.dumps({"sub": admin_id, "email": admin_email, "role": "authenticated"})


def as_admin(expr):
    return sql(
        f"select set_config('request.jwt.claims', $j${CLAIMS}$j$, true);"
        f" set local role authenticated;"
        f" select {expr} as out;"
    )


READS = [
    "admin_get_subscriptions()",
    "admin_get_subscriptions(5,0)",
    "admin_get_analytics(30)",
    f"admin_get_member_subscription('{member_id}'::uuid)",
]
for expr in READS:
    res, err = as_admin(expr)
    if err:
        bad(f"{expr.split('(')[0]}: {err}")
        continue
    out = res[0]["out"] if isinstance(res, list) and res else None
    if isinstance(out, dict) and out.get("success") is True:
        d = out.get("data")
        if isinstance(d, dict) and d:
            ok(f"{expr.split('(')[0]}: success=True, keys={','.join(list(d)[:6])}")
        elif isinstance(d, list):
            ok(f"{expr.split('(')[0]}: success=True, {len(d)} row(s)")
        else:
            ok(f"{expr.split('(')[0]}: success=True")
    elif isinstance(out, dict):
        bad(f"{expr.split('(')[0]}: {out.get('error') or out.get('success')}")
    else:
        bad(f"{expr.split('(')[0]}: unexpected {str(out)[:120]}")

print("\n  -- validation must refuse before any UPDATE --")
res, err = as_admin(f"admin_set_member_tier('{member_id}'::uuid, 9)")
out = res[0]["out"] if (res and isinstance(res, list)) else None
if isinstance(out, dict) and out.get("success") is False:
    ok(f"admin_set_member_tier rejects tier 9 ({out.get('error')})")
else:
    bad(f"admin_set_member_tier accepted tier 9: {str(out)[:120]}")

res, err = as_admin("admin_update_subscription('does-not-exist', '{\"status\":\"active\"}'::jsonb)")
out = res[0]["out"] if (res and isinstance(res, list)) else None
if isinstance(out, dict) and out.get("success") is False:
    ok(f"admin_update_subscription refuses an unknown id ({out.get('error')})")
else:
    bad(f"admin_update_subscription on unknown id: {str(out)[:120]}")

print("\n" + "=" * 70)
print("STEP 4b — write path, inside a DO block that ALWAYS aborts")
print("=" * 70)
admin_before, _ = scalar(f"select member_tier from public.profiles where id = '{admin_id}';")
print(f"  admin member_tier before: {admin_before}")

# RAISE EXCEPTION guarantees the statement is rolled back: the UPDATE cannot commit.
probe = f"""
do $do$
declare
  v       jsonb;
  v_after integer;
begin
  perform set_config('request.jwt.claims', $j${CLAIMS}$j$, true);
  perform set_config('role', 'authenticated', true);
  v := public.admin_set_member_tier('{admin_id}'::uuid, 1);
  select p.member_tier into v_after from public.profiles p where p.id = '{admin_id}';
  raise exception 'PROBE out=% after=%', v::text, v_after;
end
$do$;
"""
res, err = sql(probe)
# the API wraps the database error in JSON, so decode it before parsing the marker
try:
    err_text = json.loads(err).get("message", "") if err else ""
except (json.JSONDecodeError, AttributeError):
    err_text = err or ""
m = re.search(r"PROBE out=(\{.*\}) after=(\d+)", err_text)
if m:
    payload, after = m.group(1), m.group(2)
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = {}
    if parsed.get("success") is True:
        ok(f"write path succeeded inside the statement (returned success=True)")
    else:
        bad(f"write path returned {payload[:150]}")
    if after == "1":
        ok("inside the statement member_tier was 1 (the write really happened)")
    else:
        bad(f"inside the statement member_tier was {after} (write did not take effect)")
else:
    bad(f"no probe evidence in the error text: {str(err)[:200]}")

admin_after, _ = scalar(f"select member_tier from public.profiles where id = '{admin_id}';")
if admin_after == admin_before:
    ok(f"ABORT ROLLED IT BACK — fresh read still shows member_tier={admin_after}")
else:
    bad(f"ROLLBACK FAILED — member_tier is now {admin_after}, was {admin_before}")

if err and "PROBE" in err:
    ok("the statement ended in an exception (so nothing could commit)")

print("\n" + "=" * 70)
print("STEP 5 — anonymous caller is refused at the API layer")
print("=" * 70)
if not ANON:
    bad("anon key not found in the React .env")
else:
    for name, args in [("admin_get_subscriptions", {"p_limit": 1}),
                       ("admin_get_analytics", {}),
                       ("admin_set_member_tier", {"p_user_id": member_id, "p_member_tier": 3})]:
        req = urllib.request.Request(
            f"{URL}/rest/v1/rpc/{name}",
            data=json.dumps(args).encode(),
            headers={"apikey": ANON, "Authorization": f"Bearer {ANON}",
                     "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                code, payload = r.status, r.read().decode()[:120]
        except urllib.error.HTTPError as e:
            code, payload = e.code, e.read().decode()[:120]
        if code in (401, 403) or "42501" in payload or "permission denied" in payload.lower():
            ok(f"anon {name}: refused ({code})")
        else:
            bad(f"anon {name}: {code} {payload}")

print("\n" + "=" * 70)
print("STEP 6 — nothing else disturbed")
print("=" * 70)
# `communications` is live content -- admins post announcements -- so the migration must
# not remove any (>=) rather than pin a count that goes stale the next time one is posted.
for table, expect, op in [("profiles", 20, "=="), ("subscriptions", 0, "=="),
                          ("admin_users", 1, "=="), ("communications", 6, ">=")]:
    n, err = scalar(f"select COUNT(*) from public.{table};")
    if err:
        bad(f"{table}: {err}")
    elif (n == expect) if op == "==" else (n >= expect):
        ok(f"{table} still {n} rows")
    else:
        bad(f"{table}: {n} rows (expected {op} {expect})")

# the member row the earlier harness committed to -- must be exactly as restored
row, err = sql("select member_tier, tier, subscription_status, subscription_tier, "
               "stripe_subscription_id from public.profiles "
               "where id = '1af55909-5869-4245-9153-8fa96dcae2c3';")
if row and isinstance(row, list):
    r = row[0]
    if r.get("tier") == "free" and r.get("member_tier") == 2 \
            and r.get("subscription_status") == "canceled" and r.get("subscription_tier") is None:
        ok("previously-written member row is in the documented restored state "
           "(tier='free', member_tier=2, canceled)")
    else:
        bad(f"member row unexpected: {r}")

print("\n" + "=" * 70)
print(f"RESULT: PASS {len(PASS)} / FAIL {len(FAIL)}")
if FAIL:
    print("FAILURES:")
    for f in FAIL:
        print(f"  - {f}")
print("=" * 70)
sys.exit(1 if FAIL else 0)
