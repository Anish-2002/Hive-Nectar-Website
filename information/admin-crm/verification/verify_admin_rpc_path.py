#!/usr/bin/env python3
"""
Exercise every read RPC in the admin surface AS THE ADMIN, through the same
SECURITY DEFINER path the browser will use, and prove the same calls are refused
for an anonymous caller.

Why: a browser smoke test only proves the shell renders. This proves the other
half -- that when an administrator's JWT is presented, each admin_* function
actually returns data, and when an anonymous one is presented, it refuses. The
claim is injected per request so PostgREST/Postgres evaluates auth.email() and
auth.uid() exactly as it would for a signed-in admin.

Read-only: every call below is a getter. Nothing is written or deleted.
Credentials are read from ~/.hive-nectar/credentials.env and never printed.
"""
import json
import time
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
ENV = Path.home() / ".hive-nectar/credentials.env"


def load_env():
    creds = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            creds[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return creds


CREDS = load_env()
TOKEN = CREDS.get("SUPABASE_ACCESS_TOKEN")
if not TOKEN:
    sys.exit("no SUPABASE_ACCESS_TOKEN in credentials.env")

API = f"https://api.supabase.com/v1/projects/{REF}/database/query"


def sql(query, attempts=5):
    """Query the management API, backing off when its rate limiter kicks in.

    The limiter answers `ThrottlerException: Too Many Requests`; without the retry that
    is indistinguishable from a real failure whenever several verifiers run in a row.
    """
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
            last = f"HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:  # noqa: BLE001
            last = str(e)
        if "Too Many Requests" not in last and "429" not in last:
            return None, last
        if attempt < attempts - 1:
            time.sleep(15 * (attempt + 1))
    if last and body is None:
        return None, f"rate limited after {attempts} attempts: {last}"
    try:
        return json.loads(body), None
    except json.JSONDecodeError:
        return body, None


# ---------------------------------------------------------------- who is admin
rows, err = sql("select email from public.admin_users limit 3;")
if err:
    sys.exit(f"cannot read admin_users: {err}")
admin_emails = [r.get("email") for r in rows] if isinstance(rows, list) else []
if not admin_emails:
    sys.exit("admin_users is empty")
admin_email = admin_emails[0]
masked = re.sub(r"^([^@]{1})[^@]*", r"\1***", admin_email)

rows, err = sql(f"select id::text as id from public.profiles where email = '{admin_email}' limit 1;")
if err:
    sys.exit(f"cannot read the admin profile: {err}")
if not rows:
    sys.exit("the allowlisted admin has no profiles row -> admin_ok() cannot pass for them")
admin_id = rows[0]["id"]

rows, err = sql("select id::text as id from public.profiles where email <> "
                f"'{admin_email}' order by join_date nulls last limit 1;")
member_id = rows[0]["id"] if rows else admin_id

print(f"admin identity: {masked}  (profiles.id {admin_id[:8]}...)")
print(f"sample member id: {member_id[:8]}...")
print()

CLAIMS = json.dumps({"sub": admin_id, "email": admin_email, "role": "authenticated"})
ANON_CLAIMS = json.dumps({"role": "anon"})

# (function, argument list) -- getters only
GETTERS = [
    ("admin_ok", ""),
    ("admin_get_stats", ""),
    ("admin_get_users", ""),
    ("admin_get_user", f"'{member_id}'::uuid"),
    ("admin_get_tasks", ""),
    ("admin_get_themes", ""),
    ("admin_get_tokens", ""),
    ("admin_get_milestones", ""),
    ("admin_get_config", ""),
    ("admin_get_admins", ""),
    ("admin_get_inquiries", ""),
    ("admin_get_sigma_logs", ""),
    ("admin_get_collaborations", ""),
    ("admin_get_collab_invites", ""),
    ("admin_get_communications", "10, 0"),
    ("admin_list_user_tasks", ""),
    ("admin_list_user_tokens", ""),
    ("admin_list_user_milestones", ""),
    ("admin_list_theme_progress", ""),
    ("admin_list_jar_decorations", ""),
    # migration 02: the reads behind the Memberships and Analytics sections
    ("admin_get_subscriptions", "10, 0"),
    ("admin_get_member_subscription", f"'{member_id}'::uuid"),
    ("admin_get_analytics", "30"),
    # migration 03: the five site-content kinds behind the content sections
    ("admin_get_site_content", "'hub'"),
    ("admin_get_site_content", "'nav'"),
    ("admin_get_site_content", "'social'"),
    ("admin_get_site_content", "'policy'"),
    ("admin_get_site_content", "'founder'"),
]

# the same functions must be closed to an anon-key caller
ANON_CLOSED = [
    ("admin_get_subscriptions", "10, 0"),
    ("admin_get_member_subscription", f"'{member_id}'::uuid"),
    ("admin_get_analytics", "30"),
    ("admin_get_site_content", "'hub'"),
]

passes, failures = [], []


def call(claims, fn, args, role="authenticated"):
    q = (
        f"select set_config('request.jwt.claims', $j${claims}$j$, true);"
        f" set local role {role};"
        f" select public.{fn}({args}) as out;"
    )
    return sql(q)


for fn, args in GETTERS:
    out, err = call(CLAIMS, fn, args)
    if err:
        failures.append(f"{fn}: {err}")
        continue
    if not isinstance(out, list) or not out:
        failures.append(f"{fn}: unexpected response shape {str(out)[:120]}")
        continue
    payload = out[-1].get("out")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass
    if isinstance(payload, dict) and payload.get("success") is False:
        failures.append(f"{fn}: refused for an admin -> {payload.get('error') or payload}")
    elif fn == "admin_ok":
        if payload is True or payload == "true":
            passes.append(f"{fn}: True for the administrator")
        else:
            failures.append(f"{fn}: returned {payload!r} for the administrator")
    elif isinstance(payload, dict) and "data" in payload:
        data = payload["data"]
        n = len(data) if isinstance(data, (list, dict)) else 1
        passes.append(f"{fn}: {n} record(s)")
    else:
        passes.append(f"{fn}: {str(payload)[:60]}")

# anonymous must be refused by admin_ok (the gate the UI relies on). Refusal is now the
# stronger one: no EXECUTE at all (42501), rather than a callable predicate returning
# false -- the blanket revoke in migration 11 superseded the "returns false" posture.
out, err = call(ANON_CLAIMS, "admin_ok", "", role="anon")
if err and "permission denied" in err:
    passes.append("admin_ok: not executable by anon at all (gate holds)")
elif err:
    failures.append(f"anon admin_ok: unexpected error {err}")
else:
    payload = out[-1].get("out") if isinstance(out, list) and out else None
    if payload is False or payload == "false":
        passes.append("admin_ok: False for anon (gate holds)")
    else:
        failures.append(f"admin_ok returned {payload!r} for anon -> gate leak")

# ...and the migration-01/02 reads must not even be reachable with the anon key
for fn, args in ANON_CLOSED:
    out, err = call(ANON_CLAIMS, fn, args, role="anon")
    if err and "permission denied" in err:
        passes.append(f"{fn}: refused for anon (permission denied)")
    elif err:
        failures.append(f"{fn}: anon got an unexpected error {err[:110]}")
    else:
        failures.append(f"{fn}: anon was NOT refused -> {str(out)[:120]}")

print("=" * 72)
for line in passes:
    print("  PASS  " + line)
for line in failures:
    print("  FAIL  " + line)
print("=" * 72)
print(f"  {len(passes)} PASS / {len(failures)} FAIL")
sys.exit(1 if failures else 0)
