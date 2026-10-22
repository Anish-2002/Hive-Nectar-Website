#!/usr/bin/env python3
"""Apply migration 03 (site content) and verify it for real.

Checks, in order:
  structural  -- the three functions exist, take the right arguments, are
                 SECURITY DEFINER, and PUBLIC/anon have no EXECUTE
  read        -- as the administrator, each kind returns exactly as many rows as
                 the table holds
  gate        -- a signed-in NON-admin gets Forbidden; the anon key gets
                 permission denied; an unknown kind is refused
  write       -- insert -> update -> validation -> delete for EVERY kind, inside
                 a DO block that always raises, so the transaction rolls back and
                 the production rows are untouched (counts re-checked in-tx)

Credentials come from ~/.hive-nectar/credentials.env and are never printed.
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
SQLFILE = Path("/home/it-guy/Documents/hive nectar/The Meadows react."
               "/information/admin-crm/sql/2026-10-13-03-site-content.sql")
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"

creds = {}
for line in ENV.read_text().splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
    if m and m.group(2).strip():
        creds[m.group(1)] = m.group(2).strip().strip('"').strip("'")
TOKEN = creds["SUPABASE_ACCESS_TOKEN"]

WANT = {
    # pg_get_function_identity_arguments returns the NAMED form
    "admin_get_site_content": "p_kind text",
    "admin_save_site_item": "p_kind text, p_data jsonb",
    "admin_delete_site_item": "p_kind text, p_id text",
}
KINDS = {
    "hub": ("hub_content", "order_index"),
    "nav": ("navigation_menu", "order_index"),
    "social": ("social_links", "order_index"),
    "policy": ("policy_briefs", "name"),
    "founder": ("founders", "order_index"),
}
PASS, FAIL = [], []


def ok(name, detail=""):
    PASS.append(f"{name}{(' -- ' + detail) if detail else ''}")


def bad(name, detail=""):
    FAIL.append(f"{name}{(' -- ' + detail) if detail else ''}")


def sql_once(q, timeout=120):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:600]}"


def sql(q, timeout=120, attempts=6):
    """Retry while the management API is rate-limiting.

    `429 ThrottlerException` while the gate runs its scripts back to back is a
    transport limit, not `APPLY FAILED` - retrying keeps a rate limit from
    reading as a broken migration.
    """
    last = (None, None)
    for i in range(attempts):
        rows, err = sql_once(q, timeout)
        if not err or ("Too Many Requests" not in err and "429" not in err):
            return rows, err
        last = (None, f"{err} (after {i + 1} attempt(s))")
        if i < attempts - 1:
            time.sleep(10 * (i + 1))
    return last


# ------------------------------------------------------------------ apply
ddl = SQLFILE.read_text()
if "NOTIFY pgrst" not in ddl:
    bad("file ends with NOTIFY pgrst", "missing")
rows, err = sql(ddl, timeout=180)
if err:
    print("APPLY FAILED:", err)
    sys.exit(1)
ok("migration 03 applied", f"{len(ddl)} bytes")

# ------------------------------------------------------------------ structure
rows, err = sql(
    "select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, "
    "p.prosecdef as secdef, p.provolatile as vol, "
    "coalesce(array_to_string(array(select case when a.grantee = 0 then 'PUBLIC' "
    "  else pg_get_userbyid(a.grantee) end from aclexplode(p.proacl) a "
    "  where a.privilege_type = 'EXECUTE'), ','), '(none)') as execute_grantees "
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
    "where n.nspname = 'public' and p.proname in "
    "('admin_get_site_content','admin_save_site_item','admin_delete_site_item');"
)
if err:
    sys.exit(f"cannot read pg_proc: {err}")
found = {r["name"]: r for r in rows}
for name, args in WANT.items():
    r = found.get(name)
    if not r:
        bad(f"{name} exists")
        continue
    if r["args"] != args:
        bad(f"{name} arguments", f"got ({r['args']}) want ({args})")
    elif not r["secdef"]:
        bad(f"{name} is SECURITY DEFINER")
    else:
        ok(f"{name}({args}) exists, SECURITY DEFINER")
    grantees = r["execute_grantees"]
    if "PUBLIC" in grantees or "anon" in grantees:
        bad(f"{name} not reachable by PUBLIC/anon", grantees)
    else:
        ok(f"{name} EXECUTE limited", grantees)

# ------------------------------------------------------------------ identities
admin_email = sql("select email from public.admin_users limit 1;")[0][0]["email"]
admin_id = sql(f"select id::text as id from public.profiles where email = '{admin_email}';")[0][0]["id"]
nonadmin = sql("select p.id::text as id, p.email as email from public.profiles p "
               f"where p.email <> '{admin_email}' and p.email is not null "
               "order by p.join_date nulls last limit 1;")[0][0]
ADMIN_CLAIMS = json.dumps({"sub": admin_id, "email": admin_email, "role": "authenticated"})
MEMBER_CLAIMS = json.dumps({"sub": nonadmin["id"], "email": nonadmin["email"], "role": "authenticated"})


def as_role(claims, role, body):
    return sql(
        f"select set_config('request.jwt.claims', $j${claims}$j$, true);"
        f" set local role {role}; {body}"
    )


# ------------------------------------------------------------------ read + counts
counts, err = sql("select 'hub_content' as t, count(*) as n from public.hub_content "
                  "union all select 'navigation_menu', count(*) from public.navigation_menu "
                  "union all select 'social_links', count(*) from public.social_links "
                  "union all select 'policy_briefs', count(*) from public.policy_briefs "
                  "union all select 'founders', count(*) from public.founders;")
LIVE = {r["t"]: r["n"] for r in counts}

for kind, (table, _) in KINDS.items():
    out, err = as_role(ADMIN_CLAIMS, "authenticated",
                       f"select public.admin_get_site_content('{kind}') as out;")
    if err:
        bad(f"read {kind}", err)
        continue
    payload = out[-1]["out"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if payload.get("success") is not True:
        bad(f"read {kind}: refused for the administrator", str(payload)[:120])
        continue
    n = len(payload.get("data") or [])
    if n != LIVE[table]:
        bad(f"read {kind}: row count", f"returned {n}, table holds {LIVE[table]}")
    else:
        ok(f"read {kind}: {n} row(s) = count(*) on {table}")

# ------------------------------------------------------------------ gate
out, err = as_role(MEMBER_CLAIMS, "authenticated", "select public.admin_get_site_content('hub') as out;")
if err:
    bad("non-admin call", err[:160])
else:
    payload = out[-1]["out"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if payload.get("success") is False and "orbidden" in str(payload.get("error")):
        ok("signed-in non-admin is refused by the gate", "Forbidden")
    else:
        bad("signed-in non-admin is refused by the gate", str(payload)[:140])

out, err = as_role(MEMBER_CLAIMS, "authenticated",
                   "select public.admin_save_site_item('nav', jsonb_build_object('label','x','path','/x')) as out;")
if err:
    bad("non-admin write call", err[:160])
else:
    payload = out[-1]["out"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if payload.get("success") is False:
        ok("signed-in non-admin cannot write content", "Forbidden")
    else:
        bad("signed-in non-admin cannot write content", str(payload)[:140])

out, err = as_role(json.dumps({"role": "anon"}), "anon", "select public.admin_get_site_content('hub') as out;")
if err and "permission denied" in err:
    ok("anon key is refused at the ACL", "permission denied")
elif err:
    bad("anon key is refused at the ACL", err[:160])
else:
    bad("anon key is refused at the ACL", f"ankey got through: {str(out)[:120]}")

out, err = as_role(ADMIN_CLAIMS, "authenticated",
                   "select public.admin_get_site_content('nonsense') as out;")
payload = out[-1]["out"] if not err else None
if isinstance(payload, str):
    payload = json.loads(payload)
if isinstance(payload, dict) and payload.get("success") is False and "Unknown content kind" in str(payload.get("error")):
    ok("unknown kind is refused with a readable message")
else:
    bad("unknown kind is refused", str(payload or err)[:140])

# ------------------------------------------------------------------ write probe
PROBE = """
do $$
declare
  v jsonb; v_id text; v_before int; v_after int;
  kinds text[] := array['hub','nav','social','policy','founder'];
  k text; table_name text; payload jsonb;
begin
  foreach k in array kinds loop
    table_name := case k
      when 'hub' then 'hub_content' when 'nav' then 'navigation_menu'
      when 'social' then 'social_links' when 'policy' then 'policy_briefs'
      else 'founders' end;
    execute format('select count(*) from public.%I', table_name) into v_before;

    payload := case k
      when 'hub'    then jsonb_build_object('title','__probe__','category_slug','__probe__','source_url','/__probe__','order_index',9999)
      when 'nav'    then jsonb_build_object('label','__probe__','path','/__probe__','order_index',9999)
      when 'social' then jsonb_build_object('name','__probe__','url','/__probe__','order_index',9999)
      when 'policy' then jsonb_build_object('name','__probe__','status','draft')
      else jsonb_build_object('name','__probe__','position','__probe__','bio','__probe__','order_index',9999)
    end;

    -- insert
    v := public.admin_save_site_item(k, payload);
    if (v ->> 'success')::boolean is not true then
      raise exception 'INSERT %: %', k, v;
    end if;
    v_id := v -> 'data' ->> 'id';
    if v_id is null then raise exception 'INSERT %: no id returned (%)', k, v; end if;

    -- update the row we just made
    payload := payload || jsonb_build_object('id', v_id);
    v := public.admin_save_site_item(k, payload);
    if (v ->> 'success')::boolean is not true
       or (v -> 'data' ->> 'id') <> v_id then
      raise exception 'UPDATE %: %', k, v;
    end if;

    -- validation must fire on a required field (every kind has at least one)
    v := public.admin_save_site_item(k, ('{"id":"' || v_id || '"}')::jsonb);
    if (v ->> 'success')::boolean is not false then
      raise exception 'VALIDATION % did not fire: %', k, v;
    end if;

    -- delete it again
    v := public.admin_delete_site_item(k, v_id);
    if (v ->> 'success')::boolean is not true then
      raise exception 'DELETE %: %', k, v;
    end if;

    execute format('select count(*) from public.%I', table_name) into v_after;
    if v_after <> v_before then
      raise exception 'COUNTS %: % -> %', k, v_before, v_after;
    end if;
  end loop;

  -- deleting something that is not there must be refused, not silently fine
  v := public.admin_delete_site_item('nav', 'not-a-real-id');
  if (v ->> 'success')::boolean is not false then
    raise exception 'DELETE of a missing id was not refused: %', v;
  end if;

  raise exception 'ROLLBACK-PROBE-OK';
end $$;
"""

out, err = as_role(ADMIN_CLAIMS, "authenticated", PROBE)
if err and "ROLLBACK-PROBE-OK" in err:
    ok("write probe: insert/update/validate/delete for all 5 kinds, rolled back")
elif err:
    bad("write probe", err[:400])
else:
    bad("write probe", "the probe did not raise -- writes may have committed")

# after the rollback, counts must be exactly what they were
counts, err = sql("select 'hub_content' as t, count(*) as n from public.hub_content "
                  "union all select 'navigation_menu', count(*) from public.navigation_menu "
                  "union all select 'social_links', count(*) from public.social_links "
                  "union all select 'policy_briefs', count(*) from public.policy_briefs "
                  "union all select 'founders', count(*) from public.founders;")
NOW = {r["t"]: r["n"] for r in counts}
if NOW == LIVE:
    ok("production row counts unchanged after the write probe",
       ", ".join(f"{v} {k}" for k, v in sorted(LIVE.items())))
else:
    bad("production row counts unchanged after the write probe", f"{LIVE} -> {NOW}")

print("=" * 72)
for line in PASS:
    print("  PASS  " + line)
for line in FAIL:
    print("  FAIL  " + line)
print("=" * 72)
print(f"  {len(PASS)} PASS / {len(FAIL)} FAIL")
sys.exit(1 if FAIL else 0)
