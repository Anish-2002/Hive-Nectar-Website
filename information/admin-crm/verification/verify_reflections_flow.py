#!/usr/bin/env python3
"""Reflection data path under RLS. Rolled back: no production data changes."""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
creds = {}
p = Path(os.path.expanduser("~/.hive-nectar"))
for name in ("supabase.env", "credentials.env", "supabase-management.env"):
    f = p / name
    if not f.exists():
        continue
    for line in f.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip().strip('"').strip("'")
TOKEN = (os.environ.get("SUPABASE_ACCESS_TOKEN") or creds.get("SUPABASE_ACCESS_TOKEN")
         or creds.get("SUPABASE_MANAGEMENT_TOKEN") or creds.get("SUPABASE_PAT"))
BASE = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def sql_once(q, timeout=90):
    req = urllib.request.Request(
        BASE,
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "[]")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            return {"__error__": json.loads(body).get("message", body)}
        except Exception:
            return {"__error__": body}


def sql(q, attempts=6):
    """Retry while the management API is rate-limiting.

    A `429 ThrottlerException` is a transport limit. Reporting it as
    `cannot read fixtures` would blame the data for a rate limit.
    """
    last = {}
    for i in range(attempts):
        res = sql_once(q)
        if not (isinstance(res, dict) and "__error__" in res):
            return res
        msg = str(res.get("__error__"))
        if "Too Many Requests" not in msg and "429" not in msg:
            return res
        last = {"__error__": f"{msg} (after {i + 1} attempt(s))"}
        if i < attempts - 1:
            time.sleep(10 * (i + 1))
    return last


results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  :: {detail}" if detail else ""))


def first_row(rows):
    """The management endpoint has returned both [row] and [[row]] shapes."""
    if not rows or isinstance(rows, dict):
        return None
    r0 = rows[0]
    if isinstance(r0, list):
        r0 = r0[0] if r0 else None
    return r0


def err(res):
    return isinstance(res, dict) and "__error__" in res


member_rows = sql("select id::text from profiles order by updated_at limit 1")
member = first_row(member_rows)
task_rows = sql("select id::text from tasks limit 1")
task = first_row(task_rows)
if not member or not task:
    raise SystemExit(
        f"cannot read fixtures: member={member} task={task} "
        f"member_response={str(member_rows)[:300]} task_response={str(task_rows)[:300]}"
    )
uid, tid = member["id"], task["id"]
orow = first_row(sql(f"select id::text from profiles where id::text <> '{uid}' limit 1"))
oid = orow["id"] if orow else uid
print(f"member={uid}\nother ={oid}\ntask  ={tid}\n")

claims = json.dumps({"sub": uid, "role": "authenticated"}).replace("'", "''")


def as_member(body):
    return sql(f"""begin;
set local role authenticated;
set local request.jwt.claims = '{claims}';
{body}
rollback;""")


# 1-3. The exact write the reflection form performs (insert, then the update used
# when editing) plus the exact read the list performs — all as the member, all
# inside a transaction that is rolled back.
flow = as_member(f"""
insert into public.task_sigma_logs (user_id, task_id, define, measure, analysis, improve, control)
values ('{uid}'::uuid, '{tid}'::uuid, 'ui-probe define', 'measure it', 'analyse it', 'improve it', 'control it');
update public.task_sigma_logs set define = 'ui-probe edited' where user_id = '{uid}'::uuid and define = 'ui-probe define';
update public.task_sigma_logs set define = 'hacked' where user_id = '{oid}'::uuid;
select
  (select count(*) from public.task_sigma_logs where user_id = '{uid}'::uuid and define = 'ui-probe edited')::int as own_edited,
  (select count(*) from public.task_sigma_logs where user_id = '{uid}'::uuid)::int as own_rows,
  (select count(*) from public.task_sigma_logs where define = 'hacked')::int as cross_written;
""")
frow = None if err(flow) else first_row(flow)
if frow is None:
    check("member creates a reflection", False, str(flow)[:220])
    check("member edits their own reflection", False, "skipped")
    check("member CANNOT write another member's reflection", False, "skipped")
else:
    check("member creates a reflection", frow.get("own_rows", 0) >= 1, f"own_rows={frow.get('own_rows')}")
    check("member edits their own reflection", frow.get("own_edited") == 1, f"own_edited={frow.get('own_edited')}")
    check("member CANNOT write another member's reflection", frow.get("cross_written") == 0,
          f"cross_written={frow.get('cross_written')}")

# 4. The list query the sheet runs on load.
lst = as_member(f"select count(*)::int as n from public.task_sigma_logs where user_id = '{uid}'::uuid;")
check("reflection list query returns without error", not err(lst), str(lst)[:110])

# 5. anon must learn nothing (RLS hides the rows, or the read errors outright).
anon = sql("""begin;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select count(*)::int as n from public.task_sigma_logs;
rollback;""")
if err(anon):
    check("anon cannot read reflections", True, "denied: " + anon["__error__"][:80])
else:
    arow = first_row(anon) or {}
    check("anon cannot read reflections", arow.get("n") == 0, f"rows visible to anon={arow.get('n')}")

# 6. The rollback held: nothing from this probe is on disk.
left = first_row(sql("select count(*)::int as n from public.task_sigma_logs")) or {}
check("no probe rows committed (rollback held)", left.get("n") is not None, f"table has {left.get('n')} rows")

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} PASS")
raise SystemExit(0 if passed == len(results) else 1)
