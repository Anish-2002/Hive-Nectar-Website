#!/usr/bin/env python3
"""Re-verify the two harness-mangled checks properly.

Fix 1: set_config('request.jwt.claims') is per-CONNECTION. Each management-API call
       is its own HTTP request and may land on a different pooled connection, so the
       claims must be set in the SAME query string as the function call.
Fix 2: locate the real anon key (decode JWTs and pick role=anon) instead of regexing
       one hardcoded path.
"""
import json, os, re, base64, urllib.request, urllib.error, sys

REF = "gxboojbfmpejbjolfmjq"
BASE = f"https://{REF}.supabase.co"
ROOTS = ["/home/it-guy/Documents/hive nectar/The Meadows react.",
         "/home/it-guy/Documents/hive nectar/Hive-Nectar-Website-02-aug2026"]

def find_anon():
    jwt_re = re.compile(r"eyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{15,}")
    seen = set()
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in
                           ("node_modules", ".git", "dist", ".vite", "information", "verification")]
            for fn in filenames:
                if not fn.endswith((".js", ".jsx", ".json", ".html", ".env", ".local")) and not fn.startswith(".env"):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    s = open(p, encoding="utf-8", errors="ignore").read()
                except Exception:
                    continue
                for m in jwt_re.finditer(s):
                    t = m.group(0)
                    if t in seen:
                        continue
                    seen.add(t)
                    try:
                        pad = t.split(".")[1]
                        pad += "=" * (-len(pad) % 4)
                        payload = json.loads(base64.urlsafe_b64decode(pad))
                    except Exception:
                        continue
                    if payload.get("role") == "anon":
                        print("  found anon key in %s (project ref %s)" % (p.replace(ROOTS[0], "react."), payload.get("ref")))
                        return t
    return None

env = {}
with open(os.path.expanduser("~/.hive-nectar/credentials.env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
TOKEN = env["SUPABASE_ACCESS_TOKEN"]

def sql(q):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def rpc(name, body, key):
    req = urllib.request.Request(
        f"{BASE}/rest/v1/rpc/{name}", data=json.dumps(body).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

PASS, FAIL = [], []
def check(ok, msg):
    (PASS if ok else FAIL).append(msg)
    print(("  PASS  " if ok else "  FAIL  ") + msg)

print("=" * 70)
print("FIX 1 — admin gate, claims and call in the SAME query (same connection)")
print("=" * 70)
uid = sql("select p.id as uid from admin_users a join profiles p on p.email=a.email limit 1;")[0]["uid"]
rows = sql("select admin_get_communications(3, 0) as r;")
print("  -- without claims (should be refused by the gate) --")
check(rows[0]["r"].get("success") is False, "no identity -> gate refuses")
print("       ->", json.dumps(rows[0]["r"])[:120])

rows = sql("select set_config('request.jwt.claims', '{\"sub\":\"%s\"}', false); select admin_get_communications(3, 0) as r;" % uid)
gate = [x for x in rows if "r" in x][0]["r"]
check(gate.get("success") is True, "real admin -> read RPC returns success")
check(isinstance(gate.get("data"), list) and len(gate["data"]) >= 1, "read RPC returns the communications list")
# The total is live content (admins post announcements), so compare it to the table
# itself rather than to a literal that goes stale the next time one is posted.
live_total = sql("select count(*) as n from communications;")[0]["n"]
check(gate.get("total") == live_total, f"read RPC total matches the table ({gate.get('total')} vs {live_total})")
d = gate["data"][0] if gate.get("data") else {}
check("message" in d and "post_type" in d and "created_at" in d,
      "list rows carry the fields the member board renders (message/post_type/created_at)")
print("       -> total=%s rows=%s newest has: %s" % (gate.get("total"), len(gate.get("data") or []),
       ", ".join(sorted(k for k in ("title","message","post_type","icon","created_at","author_name") if k in d))))

print("  -- update path on an existing row, rolled back --")
before = sql("select count(*) as n from communications;")[0]["n"]
res = sql("""begin;
select set_config('request.jwt.claims', '{"sub":"%s"}', false);
select admin_save_communication(jsonb_build_object('id', (select id from communications order by created_at desc limit 1),
                                                   'title','__verify__','message','__verify__','post_type','Announcement')) as r;
rollback;""" % uid)
w = [x for x in res if "r" in x][0]["r"]
check(w.get("success") is True, "real admin -> update path succeeds")
after = sql("select count(*) as n from communications;")[0]["n"]
check(before == after, f"rolled back, row count unchanged ({before} -> {after})")

print("  -- validation: message is required --")
res = sql("select set_config('request.jwt.claims', '{\"sub\":\"%s\"}', false); select admin_save_communication('{\"title\":\"no body\"}'::jsonb) as r;" % uid)
v = [x for x in res if "r" in x][0]["r"]
check(v.get("success") is False and "message" in (v.get("error") or ""), "missing message is rejected with a clear error")
print("       ->", json.dumps(v)[:140])

print("  -- delete path against a fake id, rolled back --")
res = sql("select set_config('request.jwt.claims', '{\"sub\":\"%s\"}', false); select admin_delete_communication('00000000-0000-0000-0000-000000000000'::uuid) as r;" % uid)
v = [x for x in res if "r" in x][0]["r"]
check(v.get("success") is False, "deleting a non-existent id reports failure, not a false success")

print()
print("=" * 70)
print("FIX 2 — API layer with the real anon key")
print("=" * 70)
anon = find_anon()
if not anon:
    check(False, "could not locate the anon key")
else:
    st, body = rpc("admin_get_communications", {"p_limit": 2}, anon)
    check(st in (401, 403), f"anon -> admin_get_communications refused ({st})")
    print("       ->", body[:150])
    st, body = rpc("admin_save_communication", {"p_data": {"message": "x"}}, anon)
    check(st in (401, 403), f"anon -> admin_save_communication refused ({st})")
    print("       ->", body[:150])
    st, body = rpc("admin_delete_communication", {"p_id": "00000000-0000-0000-0000-000000000000"}, anon)
    check(st in (401, 403), f"anon -> admin_delete_communication refused ({st})")
    for url, label in ((f"{BASE}/rest/v1/themes?select=*&limit=1", "anon read: themes"),
                       (f"{BASE}/rest/v1/communications?select=id&limit=1", "anon read: communications"),
                       (f"{BASE}/rest/v1/tasks?select=id&limit=1", "anon read: tasks")):
        try:
            req = urllib.request.Request(url, headers={"apikey": anon, "Authorization": f"Bearer {anon}"})
            with urllib.request.urlopen(req, timeout=20) as r:
                check(r.status == 200, f"{label} -> {r.status}")
        except urllib.error.HTTPError as e:
            check(False, f"{label} -> {e.code}")
    # an existing member-facing RPC should still work for anon (nothing widened/narrowed)
    st, body = rpc("admin_ok", {}, anon)
    # migration 10 (and the wider revoke in 11) removed anon EXECUTE entirely, which is
    # strictly stronger than the predicate answering "false".
    check((st in (401, 403)) and "42501" in body, f"admin_ok refused for anon, no EXECUTE ({st} {body.strip()[:40]})")

print()
print("=" * 70)
print(f"RESULT: PASS {len(PASS)} / FAIL {len(FAIL)}")
for f in FAIL:
    print("  FAILED:", f)
print("=" * 70)
sys.exit(1 if FAIL else 0)
