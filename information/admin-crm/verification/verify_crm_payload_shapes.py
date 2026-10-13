#!/usr/bin/env python3
"""Verify the CRM read RPCs return the field names the admin UI actually reads.

Why this exists: verify_admin_ui_wiring.py proves every RPC the UI calls exists and is
called with argument names PostgREST accepts. It cannot see the *response*. A UI that
reads `payload.settings` when the function returns `payload.rows` compiles, builds,
passes the wiring verifier and renders an empty screen -- which looks exactly like "no
data". Same failure mode, one level deeper.

Two stages, both against production data, nothing left behind:
  1. call every list/detail RPC the new sections use and assert the keys the UI reads;
  2. for the tables that are empty, insert one fixture row per table *inside a
     transaction that is rolled back*, then assert the row-level keys -- otherwise an
     empty table silently skips the check, which is the failure this verifier exists to
     catch.

Usage:  python3 verify_crm_payload_shapes.py
Exit 0 = every asserted key is present in the live reply.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path("/home/it-guy/Documents/hive nectar/The Meadows react.")
UI = ROOT / "src/admin/sections-crm.jsx"
OLD_UI = ROOT / "src/admin/sections.jsx"
REF = "gxboojbfmpejbjolfmjq"
ENV = Path.home() / ".hive-nectar/credentials.env"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
ADMIN_FALLBACK = "04214ab6-36b8-4e60-bbfc-c2d0764f9cf6"
MEMBER_FALLBACK = "0b336cd0-c4e8-41e3-816b-68a47e824c35"

passes, failures = [], []


def ok(m):
    passes.append(m)


def bad(m):
    failures.append(m)


def load_env():
    out = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r"^([A-Za-z_]+)=(.*)$", line.strip())
        if m and m.group(2).strip():
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def sql(q, timeout=90, attempts=5):
    """Query the management API, backing off when its rate limiter kicks in.

    Without the retry, a `ThrottlerException: Too Many Requests` surfaces as a plain
    error, and can_act() below reads any error as "this identity cannot act" -- so a
    throttle would be misreported as "no administrator with an acting role found".
    """
    token = load_env()["SUPABASE_ACCESS_TOKEN"]
    last = None
    for attempt in range(attempts):
        req = urllib.request.Request(
            API,
            data=json.dumps({"query": q}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode()), None
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode()[:300]}"
        except Exception as e:  # noqa: BLE001
            last = str(e)
        if "Too Many Requests" not in (last or "") and "429" not in (last or ""):
            return None, last
        if attempt < attempts - 1:
            time.sleep(15 * (attempt + 1))
    return None, f"rate limited after {attempts} attempts: {last}"


def first_row(res):
    """The management endpoint has returned [row], [[row]] and [{fn: row}] shapes."""
    if not res:
        return None
    r = res[0]
    if isinstance(r, list):
        r = r[0] if r else None
    if isinstance(r, dict) and len(r) == 1:
        v = next(iter(r.values()))
        if isinstance(v, (dict, list)):
            return v
    return r


def unwrap(res):
    """Pull a jsonb object out of whatever the endpoint wrapped it in."""
    obj = first_row(res)
    while isinstance(obj, list) and obj:
        obj = obj[0]
    return obj if isinstance(obj, dict) else None


def claims(uid):
    return (
        "select set_config('request.jwt.claims', "
        "json_build_object('sub','%s','role','authenticated')::text, true);" % uid
    )


def call_sql(fn):
    """Read one RPC through jsonb_agg so the payload survives the endpoint's wrapping."""
    return f"""begin;
{claims(uid)}
select coalesce(jsonb_agg(x), '[]'::jsonb) from (select {fn}() as x) s;
rollback;"""


# ---------------------------------------------------------------- identities
def can_act(candidate):
    """An allowlisted admin may hold no permission (migration 09 roles): ask the
    database whether this identity can actually act, rather than assuming it can.

    Returns (can_act, error) so the caller can tell "refused" apart from "could not ask".
    """
    _, e = sql(call_sql_body("public.admin_get_my_context()", candidate))
    return e is None, e


def call_sql_body(fn, candidate):
    return f"""begin;
{claims(candidate)}
select coalesce(jsonb_agg(x), '[]'::jsonb) from (select {fn} as x) s;
rollback;"""


candidates = [ADMIN_FALLBACK]
res, err = sql("select id::text from public.admin_users limit 1;")
if not err and res:
    got = first_row(res)
    if isinstance(got, dict) and got.get("id"):
        candidates.append(got["id"])
    elif isinstance(got, str) and got:
        candidates.append(got)

uid = None
refusals, errors = [], []
for cand in candidates:
    acts, e = can_act(cand)
    if acts:
        uid = cand
        break
    (errors if e and "permission denied" not in e.lower() and "42501" not in e else refusals).append(e)
if not uid:
    if errors:
        sys.exit("could not ask the database which administrator can act: " + " | ".join(str(x)[:200] for x in errors))
    sys.exit("no administrator with an acting role found (refused for: %s); cannot probe with admin claims"
             % ", ".join(c[:8] for c in candidates))

member = MEMBER_FALLBACK
res, err = sql("select id::text from public.profiles order by join_date limit 1;")
if not err and res:
    got = first_row(res)
    if isinstance(got, dict) and got.get("id"):
        member = got["id"]
    elif isinstance(got, str) and got:
        member = got
print(f"probing as admin {uid}, member {member}")

# ------------------------------------------------- stage 1: live replies
# Every read the new sections perform, with the keys the JSX reads off the reply.
# `required` = top-level keys; `row_keys` = keys read off the first list element.
PROBES = [
    ("admin_get_review_queue()", ["success", "rows", "counts"],
     ["id", "status", "member_name", "member_email", "source", "created_at"]),
    ("admin_get_settings()", ["success", "rows"], ["key", "value"]),
    ("admin_get_integration_health()", ["success", "health"], []),
    ("admin_get_gifts()", ["success", "rows"],
     ["id", "name", "sku", "stock_quantity", "unit_cost", "is_active"]),
    ("admin_get_recognition_dashboard()",
     ["success", "counts", "spend", "low_stock", "needs_action"], []),
    ("admin_get_recognitions()", ["success", "rows", "counts"],
     ["id", "status", "member_name", "gift_name"]),
    ("admin_get_recognition_candidates()", ["success", "rows"],
     ["member_id", "name", "completed_tasks", "reflections"]),
    ("admin_get_tickets()", ["success", "rows", "counts"],
     ["id", "subject", "status", "priority", "requester_email"]),
    ("admin_get_support_templates()", ["success", "rows"], ["id", "name", "body", "is_active"]),
    ("admin_get_notifications()", ["success", "rows"], ["id", "title", "delivery_status"]),
    ("admin_get_nectar_ledger()", ["success", "rows", "total"],
     ["id", "delta", "reason", "category"]),
]

for call, required, row_keys in PROBES:
    fn = call.split("(")[0]
    res, err = sql(call_sql(fn))
    if err:
        bad(f"{call}: probe failed ({err})")
        continue
    payload = unwrap(res)
    if payload is None:
        bad(f"{call}: reply is not a JSON object")
        continue
    missing = [k for k in required if k not in payload]
    if missing:
        bad(f"{call}: reply lacks {missing}; it has {sorted(payload)}")
        continue
    rows = payload.get("rows")
    if row_keys and rows:
        r0 = rows[0]
        rmiss = [k for k in row_keys if not isinstance(r0, dict) or k not in r0]
        if rmiss:
            bad(f"{call}: rows[0] lacks {rmiss}; it has {sorted(r0) if isinstance(r0, dict) else r0!r}")
            continue
        ok(f"{call}: keys {sorted(payload)}; rows[0] {sorted(r0)}")
    elif row_keys:
        ok(f"{call}: keys {sorted(payload)} (rows empty -- row keys checked in stage 2)")
    else:
        ok(f"{call}: keys {sorted(payload)}")

# ------------------------------------------------- stage 2: row keys with fixtures
# One fixture per listed table, inserted and rolled back in a single transaction, so an
# empty production table cannot hide a missing row field from the UI.
FIXTURE = f"""begin;
{claims(uid)}
insert into public.gift_catalogue (name, sku, description, stock_quantity, unit_cost)
  values ('Shape probe gift', 'PROBE-SHAPE-' || replace(gen_random_uuid()::text, '-', ''),
          'inserted by verify_crm_payload_shapes.py', 3, 1.00);
insert into public.member_reviews (source, source_id, user_id, task_id, status, priority)
  values ('sigma_log', 'probe-shape', '{member}', null, 'new', 'normal');
insert into public.recognitions (user_id, gift_id, status, reason)
  select '{member}', id, 'nominated', 'shape probe'
    from public.gift_catalogue where sku like 'PROBE-SHAPE-%';
insert into public.support_tickets (subject, requester_email, requester_name, status, priority)
  values ('Shape probe ticket', 'probe@example.test', 'Probe', 'new', 'normal');
insert into public.support_templates (name, category, body)
  values ('Shape probe ' || replace(gen_random_uuid()::text, '-', ''), 'probe', 'Body text');
insert into public.admin_notifications (user_id, kind, title, body, channel, delivery_status)
  values ('{member}', 'probe.shape', 'Shape probe', 'Body', 'in_app', 'not_configured');
select jsonb_build_object(
  'gifts', public.admin_get_gifts('PROBE-SHAPE', true),
  'queue', public.admin_get_review_queue(),
  'recognitions', public.admin_get_recognitions(),
  'tickets', public.admin_get_tickets(),
  'templates', public.admin_get_support_templates(),
  'notifications', public.admin_get_notifications()
) as x;
rollback;"""

EXPECT_ROWS = {
    "gifts": ["id", "name", "sku", "stock_quantity", "unit_cost", "is_active"],
    "queue": ["id", "status", "member_name", "member_email", "source", "created_at"],
    "recognitions": ["id", "status", "member_name", "gift_name"],
    "tickets": ["id", "subject", "status", "priority", "requester_email"],
    "templates": ["id", "name", "body", "is_active"],
    "notifications": ["id", "title", "delivery_status"],
}

res, err = sql(FIXTURE, timeout=150)
if err:
    bad(f"fixture stage failed ({err})")
else:
    payloads = unwrap(res)
    if payloads is None:
        bad("fixture stage returned no JSON object")
    else:
        for key, want in EXPECT_ROWS.items():
            p = payloads.get(key)
            if not isinstance(p, dict) or not p.get("rows"):
                bad(f"{key}: fixture read returned no rows "
                    f"({p if not isinstance(p, dict) else sorted(p)})")
                continue
            r0 = p["rows"][0]
            miss = [k for k in want if k not in r0]
            if miss:
                bad(f"{key}: rows[0] lacks {miss}; it has {sorted(r0)}")
            else:
                ok(f"{key}: fixture row carries {want}")

# ------------------------------------------------- does the UI read those names?
src = ""
for p in (UI, OLD_UI):
    if p.exists():
        src += p.read_text(encoding="utf-8")
if not UI.exists():
    bad(f"{UI.name} does not exist -- nothing to cross-check")
else:
    reads = {
        "delivery_status": "outbound message/notification delivery state",
        "stock_quantity": "gift stock",
        "recipient_name": "award delivery address",
        "tracking_number": "shipment",
        "consent": "fulfilment consent",
        "stock_returned": "stock returned on cancel/failure",
        # Not delivery_hint: no such key exists anywhere in the SQL. What matters is
        # that the UI reads the transport truth itself and never dresses a stored-only
        # message up as sent.
        "email_transport": "integration health reads the real mail transport state",
        "NOT emailed": "honest wording shown when nothing was actually delivered",
    }
    for name, why in reads.items():
        if name in src:
            ok(f"UI reads {name} ({why})")
        else:
            bad(f"UI never reads {name} ({why}) -- is the workflow wired?")

print("=" * 72)
for line in passes:
    print("  PASS  " + line)
for line in failures:
    print("  FAIL  " + line)
print("=" * 72)
print(f"  {len(passes)} PASS / {len(failures)} FAIL")
sys.exit(1 if failures else 0)
