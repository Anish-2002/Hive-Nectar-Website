#!/usr/bin/env python3
"""probe-health.py - read the CRM health block as a real admin session.

verify the migration-16 claim: after m14 the health screen must describe the
installed mail transport (name / sender / counts / enabled), and must NOT
repeat the pre-fix sentence 'nothing can be emailed from the CRM yet'.
"""
import json, re, sys, time, urllib.error, urllib.request
from pathlib import Path

BASE = "https://gxboojbfmpejbjolfmjq.supabase.co"
creds = {}
for line in (Path.home() / ".hive-nectar/credentials.env").read_text().splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
    if m:
        creds[m.group(1)] = m.group(2).strip().strip('"')
PAT = creds["SUPABASE_ACCESS_TOKEN"]
cfg = json.loads(urllib.request.urlopen(
    urllib.request.Request(f"https://api.supabase.com/v1/projects/gxboojbfmpejbjolfmjq/api-keys",
                           headers={"Authorization": f"Bearer {PAT}"})).read().decode())
anon_key = next(k["api_key"] for k in cfg if k.get("name") == "anon")
service_key = next(k["api_key"] for k in cfg if k.get("name") == "service_role")
print(f"keys: anon {len(anon_key)} ch, service_role {len(service_key)} ch (values withheld)")


def jget(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:300]


def q(sql, attempts=5):
    """Read through the Supabase management API (needs the account PAT)."""
    last = None
    for a in range(attempts):
        req = urllib.request.Request(
            "https://api.supabase.com/v1/projects/gxboojbfmpejbjolfmjq/database/query",
            data=json.dumps({"query": sql}).encode(), method="POST",
            headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            last = e.read().decode()
            if ("Too Many Requests" in last or "429" in last) and a < attempts - 1:
                time.sleep(15 * (a + 1))
                continue
            return {"error": last[:300]}
    return {"error": str(last)[:300]}


rows = q("""select jsonb_build_object('email', a.email) as r
              from public.admin_users a
              join public.profiles p on lower(p.email) = lower(a.email)
             limit 1;""")
admin_email = (rows[0]["r"]["email"] if isinstance(rows, list) and rows else None)
if not admin_email:
    print(f"FAIL no administrator account found: {str(rows)[:200]}")
    sys.exit(1)

s, link = jget(f"{BASE}/auth/v1/admin/generate_link", "POST",
               {"type": "magiclink", "email": admin_email},
               {"apikey": service_key, "Authorization": f"Bearer {service_key}"})
token_hash = (link or {}).get("hashed_token") if isinstance(link, dict) else None
if s != 200 or not token_hash:
    print(f"FAIL could not mint a one-time admin session (HTTP {s}): {str(link)[:200]}")
    sys.exit(1)
s, sess = jget(f"{BASE}/auth/v1/verify", "POST",
               {"type": "magiclink", "token_hash": token_hash},
               {"apikey": anon_key, "Authorization": f"Bearer {anon_key}"})
access = (sess or {}).get("access_token") if isinstance(sess, dict) else None
if s != 200 or not access:
    print(f"FAIL one-time session could not be exchanged (HTTP {s}): {str(sess)[:200]}")
    sys.exit(1)
print(f"session: one-time admin access token minted for "
      f"{re.sub(r'^(.).*(@.*)$', r'\1***\2', admin_email)} ({len(access)} ch, withheld)")

hdr = {"apikey": anon_key, "Authorization": f"Bearer {access}"}
s, health = jget(f"{BASE}/rest/v1/rpc/admin_get_integration_health", "POST", {}, hdr)
if s != 200 or not isinstance(health, dict):
    print(f"FAIL admin_get_integration_health refused (HTTP {s}): {str(health)[:300]}")
    sys.exit(1)
h = health.get("health") or {}
et = h.get("email_transport") or {}
print("email_transport:")
for k in ("ready", "transport", "sender", "enabled", "waiting", "sent", "failed"):
    print(f"  {k:<10} {et.get(k)}")
print(f"  detail     {et.get('detail')}")

ok = True
if et.get("ready") is not True:
    print("FAIL the transport is installed but health does not report it ready"); ok = False
if (et.get("transport") or "").lower() != "brevo":
    print("FAIL health does not name the configured transport"); ok = False
if not et.get("sender"):
    print("FAIL health does not name the sender address"); ok = False
if "nothing can be emailed" in (et.get("detail") or ""):
    print("FAIL health still repeats the pre-fix sentence"); ok = False
if not isinstance(et.get("waiting"), int) or not isinstance(et.get("sent"), int) \
        or not isinstance(et.get("failed"), int):
    print("FAIL health does not carry the outbox counts"); ok = False
print("=" * 72)
print("PASS health describes the mail transport that is actually installed"
      if ok else "FAIL health does not describe the installed transport")
sys.exit(0 if ok else 1)
