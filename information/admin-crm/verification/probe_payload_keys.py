#!/usr/bin/env python3
"""Dump the real shape of the new admin payloads (read-only).

The previous probe guessed inner key names and got null -- so this walks the
actual JSON: top-level data keys, then one level deeper for each.
"""
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
ENV = Path.home() / ".hive-nectar/credentials.env"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"

creds = {}
for line in ENV.read_text().splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
    if m and m.group(2).strip():
        creds[m.group(1)] = m.group(2).strip().strip('"').strip("'")
TOKEN = creds["SUPABASE_ACCESS_TOKEN"]


def sql(q):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"


admin_email = sql("select email from public.admin_users limit 1;")[0][0]["email"]
admin_id = sql(f"select id::text as id from public.profiles where email='{admin_email}';")[0][0]["id"]
member_id = sql("select id::text as id from public.profiles where email <> "
                f"'{admin_email}' limit 1;")[0][0]["id"]
claims = json.dumps({"sub": admin_id, "email": admin_email, "role": "authenticated"})

CALLS = {
    "admin_get_subscriptions(10,0)": "public.admin_get_subscriptions(10,0)",
    "admin_get_member_subscription(m)": f"public.admin_get_member_subscription('{member_id}'::uuid)",
    "admin_get_analytics(30)": "public.admin_get_analytics(30)",
}

for label, expr in CALLS.items():
    out, err = sql(
        f"select set_config('request.jwt.claims', $j${claims}$j$, true);"
        f" set local role authenticated;"
        f" select {expr} as out;"
    )
    if err:
        print(f"{label}: ERROR {err}")
        continue
    payload = out[-1]["out"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    data = payload.get("data", payload)
    print(f"=== {label}")
    print(f"    success={payload.get('success')}  data keys: {list(data) if isinstance(data, dict) else type(data).__name__}")
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, list):
                inner = list(v[0]) if v and isinstance(v[0], dict) else (v[0] if v else None)
                print(f"      {k}: list[{len(v)}]  first={json.dumps(inner)[:150]}")
            elif isinstance(v, dict):
                print(f"      {k}: dict keys={list(v)}  {json.dumps(v)[:220]}")
            else:
                print(f"      {k}: {json.dumps(v)[:150]}")
    print()
