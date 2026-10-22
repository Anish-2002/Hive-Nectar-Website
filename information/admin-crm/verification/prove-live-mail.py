#!/usr/bin/env python3
"""prove-live-mail.py - the live end-to-end proof, no browser, no human click.

The one thing the database-layer probes cannot show is that the DEPLOYED edge
function hands a real message to Brevo and records Brevo's own answer. This
does exactly that, as the project's own administrator:

  1. mint a one-time session for the admin account (project admin API)
  2. queue the built-in test message as that admin (admin_queue_test_email)
  3. POST it to the deployed send-mail function with that admin's token
  4. read the outbox ledger back and print the provider's answer

Secrets never leave memory: the service-role key and the access token are used
in-process, never printed, never written to disk. The only message sent goes to
the project's own notification mailbox (app_config.notification_email), i.e. the
same address the "Send test email" button in the admin portal uses.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
BASE = f"https://{REF}.supabase.co"
MGMT = f"https://api.supabase.com/v1/projects/{REF}"

creds = {}
for line in (Path.home() / ".hive-nectar/credentials.env").read_text().splitlines():
    m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
    if m:
        creds[m.group(1)] = m.group(2).strip().strip('"')
PAT = creds["SUPABASE_ACCESS_TOKEN"]


def http(url, method="GET", body=None, headers=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001
        return 0, f"transport error: {e}"


def jget(url, **kw):
    s, b = http(url, **kw)
    try:
        return s, json.loads(b)
    except Exception:  # noqa: BLE001
        return s, b


def q(sql, attempts=5):
    """Management query endpoint, throttle-aware."""
    import time
    for a in range(attempts):
        s, b = http(f"{MGMT}/database/query", "POST", {"query": sql},
                    {"Authorization": f"Bearer {PAT}"})
        if s == 200 or s == 201:
            return b
        if ("Too Many Requests" in str(b) or "429" in str(b)) and a < attempts - 1:
            time.sleep(15 * (a + 1))
            continue
        print(f"FAIL query: {b[:300]}")
        sys.exit(1)
    print("FAIL query: rate limited")
    sys.exit(1)


def rows_as_json(body, key="r"):
    try:
        j = json.loads(body)
    except Exception:  # noqa: BLE001
        return None
    if isinstance(j, list) and j and isinstance(j[0], dict):
        v = j[0].get(key)
        return json.loads(v) if isinstance(v, str) else v
    return None


def mask(addr):
    return re.sub(r"^(.).*(@.*)$", r"\1***\2", str(addr))


def show_ledger(mail_id, sent=None, status=None):
    """Print the outbox row (the pipeline's own source of truth) and judge it."""
    ledger = rows_as_json(q("""
      select jsonb_build_object(
        'kind',                o.kind,
        'status',              o.status,
        'attempts',            o.attempts,
        'provider',            o.provider,
        'provider_message_id', o.provider_message_id,
        'sent_at',             o.sent_at,
        'claimed_at',          o.claimed_at,
        'error',               o.error,
        'to_email',            o.to_email,
        'subject',             o.subject
      ) as r
      from public.mail_outbox o
      where o.id = '%s'::uuid;
    """ % mail_id)) or {}

    print("ledger:")
    for k in ("kind", "status", "attempts", "provider", "provider_message_id",
              "sent_at", "claimed_at", "error", "subject", "to_email"):
        print(f"  {k:20} {ledger.get(k) if ledger else '(row not found)'}")

    if sent is not None:
        print(f"send-mail: HTTP {status} success={sent.get('success')} sent={sent.get('sent')} "
              f"failed={sent.get('failed')} processed={sent.get('processed')}")
        for r in sent.get("results") or []:
            print(f"  row {str(r.get('id'))[:8]}...  status={r.get('status')}  "
                  f"provider_id={r.get('provider_message_id')}  error={r.get('error')}  "
                  f"recorded={r.get('recorded')}")

    ok = (sent is None or bool(sent.get("success"))) \
        and ledger.get("status") == "sent" and bool(ledger.get("provider_message_id"))
    print("=" * 72)
    print(("PASS" if ok else "FAIL") + " live end-to-end: admin session -> queue -> deployed send-mail "
          "-> provider -> ledger records sent + a provider message id")
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------- keys -------
s, keys = jget(f"{MGMT}/api-keys?reveal=true", headers={"Authorization": f"Bearer {PAT}"})
if s != 200 or not isinstance(keys, list):
    print(f"FAIL could not read project keys (HTTP {s})")
    sys.exit(1)
by_name = {k.get("name"): (k.get("api_key") or k.get("value")) for k in keys}
service_key = by_name.get("service_role") or ""
anon_key = by_name.get("anon") or ""
print(f"keys: anon {len(anon_key)} ch, service_role {len(service_key)} ch (values withheld)")

# ------------------------------------------------------------ read-only ------
if "--read" in sys.argv:
    newest = rows_as_json(q("select jsonb_build_object('id', o.id::text) as r "
                            "from public.mail_outbox o order by o.created_at desc limit 1;"))
    mail_id = (newest or {}).get("id")
    if not mail_id:
        print("FAIL no mail_outbox row to read")
        sys.exit(1)
    print(f"read-only: inspecting the newest outbox row {mail_id[:8]}...")
    show_ledger(mail_id)

# ---------------------------------------------------------------- actor ------
who = rows_as_json(q("""
  select jsonb_build_object(
    'uid',   p.id::text,
    'email', a.email
  ) as r
  from public.admin_users a
  join public.profiles p on lower(p.email) = lower(a.email)
  limit 1;
"""))
if not who or not who.get("uid"):
    print("FAIL no administrator account found")
    sys.exit(1)
admin_uid, admin_email = who["uid"], who["email"]
masked = re.sub(r"^(.).*(@.*)$", r"\1***\2", admin_email)
print(f"acting as administrator {masked} ({admin_uid[:8]}...)")

# ------------------------------------------------- one-time admin session -----
s, link = jget(f"{BASE}/auth/v1/admin/generate_link", method="POST",
               body={"type": "magiclink", "email": admin_email},
               headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
token_hash = (link or {}).get("hashed_token") if isinstance(link, dict) else None
if s != 200 or not token_hash:
    print(f"FAIL could not mint a one-time admin session (HTTP {s})")
    sys.exit(1)

s, sess = jget(f"{BASE}/auth/v1/verify", method="POST",
               body={"type": "magiclink", "token_hash": token_hash},
               headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}"})
access = (sess or {}).get("access_token") if isinstance(sess, dict) else None
if s != 200 or not access:
    print(f"FAIL one-time session could not be exchanged (HTTP {s})")
    sys.exit(1)
print(f"session: one-time admin access token minted ({len(access)} ch, withheld)")

# ---------------------------------------------------- queue as that admin ----
admin_hdr = {"apikey": anon_key, "Authorization": f"Bearer {access}"}
s, queued = jget(f"{BASE}/rest/v1/rpc/admin_queue_test_email", method="POST",
                 body={"p_to": None}, headers=admin_hdr)
if s != 200 or not isinstance(queued, dict) or not queued.get("success", True):
    print(f"FAIL admin_queue_test_email refused (HTTP {s}): {str(queued)[:300]}")
    sys.exit(1)
mail_id = queued.get("mail_id") or queued.get("id")
to_email = queued.get("to") or queued.get("to_email") or "?"
print(f"queued: mail_id {str(mail_id)[:8]}... -> {mask(to_email)} "
      f"(status {queued.get('status') or queued.get('delivery_status')})")
if not mail_id:
    print(f"FAIL the queue RPC did not return an id: {queued}")
    sys.exit(1)

# ------------------------------------------- deployed function -> real mail ---
s, sent = jget(f"{BASE}/functions/v1/send-mail", method="POST",
               body={"ids": [str(mail_id)], "limit": 1}, headers=admin_hdr)
if not isinstance(sent, dict):
    print(f"FAIL send-mail returned unreadable body (HTTP {s})")
    sys.exit(1)

# --------------------------------------------- read the ledger back (truth) ---
show_ledger(str(mail_id), sent, s)
