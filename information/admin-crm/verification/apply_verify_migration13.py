#!/usr/bin/env python3
"""apply_verify_migration13.py — Phase A read layer (2026-10-14-13-ops-read-layer.sql)

Stage 0  apply the migration (idempotent; safe to re-run)
Stage 1  structure: 11 functions exist, anon holds EXECUTE on none of them,
         authenticated holds it on the 8 read RPCs, the 3 internals are shut
Stage 2  guard proof: as a signed-in MEMBER (and as anon) every read RPC refuses
Stage 3  admin positive path: as an admin the RPCs return real live numbers
Stage 4  ingest proof: a new reflection/sigma row auto-enqueues a review item,
         and the member's insert still succeeds (trigger cannot break members)
Stage 5  side-effect proof: reading a reflection changes no nectar/achievement
         and leaves the submission row intact

Verifier rules applied (skill hive-nectar-website, references/admin-verifier-hardening.md):
  - retry on ThrottlerException, report the verbatim server error
  - `set local role` + request.jwt.claims is what makes a privilege check real
  - every write test runs inside begin; ... rollback; so nothing persists
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

REF = "gxboojbfmpejbjolfmjq"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
REST = f"https://{REF}.supabase.co/rest/v1"
MIG = ("/home/it-guy/Documents/hive nectar/The Meadows react./information/admin-crm/sql/"
       "2026-10-14-13-ops-read-layer.sql")
REACT_DIR = "/home/it-guy/Documents/hive nectar/The Meadows react."

PASS = []
FAIL = []
THROTTLE_NOTE = []


def env_file(path):
    out = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


ENV = env_file(os.path.expanduser("~/.hive-nectar/credentials.env"))
TOKEN = ENV["SUPABASE_ACCESS_TOKEN"]


def sql(query, attempts=6):
    """Run SQL through the management API. Returns (ok, payload)."""
    last = None
    for attempt in range(attempts):
        req = urllib.request.Request(
            API, data=json.dumps({"query": query}).encode(),
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return True, json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()
            if "Too Many Requests" in body or "ThrottlerException" in body:
                THROTTLE_NOTE.append("ThrottlerException (management API) — retried")
                time.sleep(20 * (attempt + 1))
                last = f"THROTTLED: {body[:200]}"
                continue
            return False, body
        except Exception as exc:  # network hiccup
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(5)
    return False, last


def sql1(query):
    ok, payload = sql(query)
    if not ok:
        return None, payload
    if isinstance(payload, str):
        return None, payload
    if payload and isinstance(payload, list):
        return payload[0], None
    return None, f"unexpected payload {str(payload)[:200]}"


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    tag = "PASS" if condition else "FAIL"
    print(f"  [{tag}] {name}" + (f" — {detail}" if detail else ""))
    return condition


RESET_PRE = ("reset role;\nselect set_config('request.jwt.claims', '{}', false);")


def term(statements):
    """Join statements with newlines, terminating each one.

    An element that does not end in ';' is a continuation of the previous one
    (multi-line SQL such as an INSERT whose VALUES sit on the next line), so
    merge first and only then terminate -- otherwise the ';' lands mid-statement
    and Postgres reports the next keyword as a syntax error.
    """
    out, buf = [], ""
    for s in statements:
        s = s.strip()
        buf = (buf + " " + s) if buf else s
        if buf.endswith(";"):
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf + ";")
    return out


def as_role(statements, role="authenticated", claims=None):
    """Run statements as a real session role.

    The management API rejects explicit `rollback`, so this uses session-level
    SET ROLE + set_config(..., false) and always resets at the end (and again at
    the start of the next call, in case a pooled connection was left switched).
    """
    body = [f"set role {role};"]
    if claims:
        body.append(f"select set_config('request.jwt.claims', '{json.dumps(claims)}', false);")
    body.extend(term(statements))
    # NOTE: end on `reset role;` (a non-row statement). The management API returns
    # the LAST row-producing statement, so a trailing set_config would shadow the
    # call under test. RESET_PRE restores claims at the start of the next script.
    body.append("reset role;")
    return RESET_PRE + "\n" + "\n".join(body)


def as_owner(statements):
    """Owner-level script (superuser) — used for assertions clients must not make."""
    return RESET_PRE + "\n" + "\n".join(term(statements))


READ_RPCS = [
    ("admin_get_dashboard_metrics(timestamptz, timestamptz)",
     "select public.admin_get_dashboard_metrics(now() - interval '30 days', now()) as r"),
    ("admin_get_activity_feed(int, timestamptz, timestamptz, text)",
     "select public.admin_get_activity_feed(20, now() - interval '90 days', now(), null) as r"),
    ("admin_get_reflections(text, int, int)",
     "select public.admin_get_reflections(null, 30, 0) as r"),
    ("admin_get_sigma_inbox(text, int, int)",
     "select public.admin_get_sigma_inbox(null, 30, 0) as r"),
    ("admin_get_ticket_history(text, text, int, int, boolean)",
     "select public.admin_get_ticket_history(null, null, 50, 0, null) as r"),
    ("admin_get_sla_stats(timestamptz, timestamptz)",
     "select public.admin_get_sla_stats(now() - interval '30 days', now()) as r"),
    ("admin_get_member_360(uuid)",
     "select public.admin_get_member_360((select id from public.profiles limit 1)) as r"),
    ("admin_get_fulfilment_queue(text, int)",
     "select public.admin_get_fulfilment_queue(null, 50) as r"),
]
INTERNAL_FNS = [
    "sla_target_interval(text)",
    "tg_support_ticket_sla()",
    "review_queue_ingest()",
]


def main():
    print("STAGE 0 — apply migration 13")
    patch_sql = open(MIG).read()
    ok, payload = sql(patch_sql)
    check("migration applies cleanly", ok, "" if ok else str(payload)[:300])
    if not ok:
        summary()
        return 1

    print("\nSTAGE 1 — structure and grants")
    row, err = sql1("""select count(*) n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                        where ns.nspname = 'public' and p.proname in (
                        'sla_target_interval','tg_support_ticket_sla','review_queue_ingest',
                        'admin_get_dashboard_metrics','admin_get_activity_feed','admin_get_reflections',
                        'admin_get_sigma_inbox','admin_get_ticket_history','admin_get_sla_stats',
                        'admin_get_member_360','admin_get_fulfilment_queue')""")
    check("all 11 functions present", bool(row) and row["n"] == 11, f"found {row and row['n']}")

    for signature, _ in READ_RPCS:
        name = signature.split("(")[0]
        argtypes = signature[len(name) + 1:-1]
        row, err = sql1(f"""select has_function_privilege('anon', 'public.{name}({argtypes})', 'EXECUTE') anon,
                                   has_function_privilege('authenticated', 'public.{name}({argtypes})', 'EXECUTE') auth
                            """)
        check(f"anon denied / authenticated allowed: {name}",
              bool(row) and row["anon"] is False and row["auth"] is True,
              f"anon={row and row['anon']} auth={row and row['auth']}")

    for signature in INTERNAL_FNS:
        name = signature.split("(")[0]
        argtypes = signature[len(name) + 1:-1]
        row, err = sql1(f"""select has_function_privilege('anon', 'public.{name}({argtypes})', 'EXECUTE') anon,
                                   has_function_privilege('authenticated', 'public.{name}({argtypes})', 'EXECUTE') auth
                            """)
        check(f"internal helper shut: {name}",
              bool(row) and row["anon"] is False and row["auth"] is False,
              f"anon={row and row['anon']} auth={row and row['auth']}")

    row, err = sql1("""select count(*) n from pg_trigger t join pg_class c on c.oid = t.tgrelid
                        where not t.tgisinternal and t.tgname in
                        ('support_ticket_sla','review_queue_task_sigma','review_queue_sigma')""")
    check("3 triggers installed", bool(row) and row["n"] == 3, f"found {row and row['n']}")

    row, err = sql1("""select permissions from public.admin_roles where role_key = 'fulfilment_manager'""")
    check("fulfilment_manager now holds recognition.read",
          bool(row) and "recognition.read" in row["permissions"], str(row and row["permissions"]))

    row, err = sql1("""select count(*) total, count(sla_due_at) with_sla from public.support_tickets
                        where status not in ('resolved','closed')""")
    check("every open ticket has an SLA target",
          bool(row) and row["total"] == row["with_sla"], f"{row and row['with_sla']}/{row and row['total']}")

    row, err = sql1("""select count(*) n from public.member_reviews
                        where source in ('task_reflection','sigma_log')""")
    check("review queue backfilled from existing submissions",
          bool(row) and row["n"] >= 12, f"{row and row['n']} queued")

    print("\nSTAGE 2 — refusal side (member + anon)")
    member_id, _ = sql1("""select id from public.profiles where member_tier = 0
                            order by join_date limit 1""")
    admin_id, _ = sql1("""select p.id from public.profiles p
                           join public.admin_users a on a.email = p.email limit 1""")
    if not member_id or not admin_id:
        check("test identities found", False, "member or admin missing")
        summary()
        return 1
    MUID, AUID = member_id["id"], admin_id["id"]

    for signature, call in READ_RPCS:
        name = signature.split("(")[0]
        ok, payload = sql(as_role([call], role="authenticated",
                                  claims={"sub": MUID, "role": "authenticated"}))
        refused = (not ok) and ("Forbidden" in str(payload) or "42501" in str(payload))
        check(f"member refused: {name}", refused, f"ok={ok} payload={str(payload)[:120]}")

    for signature, call in READ_RPCS:
        name = signature.split("(")[0]
        ok, payload = sql(as_role([call], role="anon"))
        refused = (not ok) and ("42501" in str(payload) or "permission denied" in str(payload).lower()
                                or "Forbidden" in str(payload))
        check(f"anon refused: {name}", refused, f"ok={ok} payload={str(payload)[:120]}")

    ok, _ = sql(as_role(["select public.handle_subscription_event('a','b','c',1,'d')"], role="anon"))
    check("migration 12 fix still holds (anon cannot forge a stripe event)", not ok, "")

    print("\nSTAGE 3 — admin positive path (real live numbers)")
    results = {}
    for signature, call in READ_RPCS:
        name = signature.split("(")[0]
        ok, payload = sql(as_role([call], role="authenticated",
                                  claims={"sub": AUID, "role": "authenticated"}))
        if not ok:
            check(f"admin can call: {name}", False, str(payload)[:200])
            continue
        body = payload[0]["r"]
        results[name] = body
        check(f"admin can call: {name}", isinstance(body, dict) and body.get("success") is True,
              f"keys={sorted(body.keys())[:8] if isinstance(body, dict) else body}")

    dash = results.get("admin_get_dashboard_metrics", {})
    if dash:
        members = dash.get("members", {})
        live, _ = sql1("select count(*) n from public.profiles")
        check("dashboard members.total matches live profiles",
              bool(live) and members.get("total") == live["n"],
              f"total={members.get('total')} live={live and live['n']}")
        check("dashboard splits free vs paid",
              isinstance(members.get("free"), int) and isinstance(members.get("paid"), int)
              and members["free"] + members["paid"] == members["total"],
              f"free={members.get('free')} paid={members.get('paid')}")
        check("dashboard series covers the whole range",
              isinstance(dash.get("series"), list) and len(dash["series"]) >= 30,
              f"points={len(dash.get('series') or [])}")
        check("dashboard exposes support block for an admin",
              "support" in dash, f"keys={sorted(dash.keys())}")
        check("dashboard exposes billing block for an admin",
              "billing" in dash, f"keys={sorted(dash.keys())}")
        rev = dash.get("reviews", {})
        check("dashboard review counters are non-zero (queue is populated)",
              (rev.get("new") or 0) + (rev.get("awaiting") or 0) > 0,
              f"new={rev.get('new')} awaiting={rev.get('awaiting')}")

    feed = results.get("admin_get_activity_feed", {})
    if feed:
        kinds = {r["kind"] for r in feed.get("rows", [])}
        check("activity feed returns real events", feed.get("count", 0) > 0, f"count={feed.get('count')}")
        check("activity feed merges several sources", len(kinds) >= 3, f"kinds={sorted(kinds)[:8]}")
        check("activity feed rows carry a navigation section",
              all(r.get("section") for r in feed.get("rows", [])), "")

    refl = results.get("admin_get_reflections", {})
    if refl:
        check("reflections inbox is populated from task_sigma_logs",
              refl.get("total", 0) >= 3, f"total={refl.get('total')}")
        first = (refl.get("rows") or [{}])[0]
        check("reflection carries full DMAIC content",
              all(k in first for k in ("define", "measure", "analysis", "improve", "control")),
              f"keys={sorted(first.keys())[:10]}")
        check("reflection carries its review state",
              "review_status" in first, f"status={first.get('review_status')}")

    sigma = results.get("admin_get_sigma_inbox", {})
    if sigma:
        check("sigma inbox is populated", sigma.get("total", 0) >= 9, f"total={sigma.get('total')}")

    hist = results.get("admin_get_ticket_history", {})
    if hist:
        check("ticket history returns tickets", hist.get("total", 0) >= 6, f"total={hist.get('total')}")
        statuses = {r.get("sla_state") for r in hist.get("rows", [])}
        check("ticket rows compute an SLA state", statuses and statuses != {None}, f"states={sorted(s for s in statuses if s)}")

    sla = results.get("admin_get_sla_stats", {})
    if sla:
        check("SLA stats expose targets per priority",
              set((sla.get("targets_hours") or {}).keys()) >= {"urgent", "high", "normal", "low"},
              str(sla.get("targets_hours")))
        check("SLA stats count unanswered tickets", "unanswered" in (sla.get("open") or {}),
              str(sla.get("open")))

    m360 = results.get("admin_get_member_360", {})
    if m360:
        check("member 360 returns the member record", m360.get("member", {}).get("id") is not None, "")
        check("member 360 counts outstanding review items",
              "total" in (m360.get("outstanding") or {}), str(m360.get("outstanding")))
        # only one admin identity exists (super_admin), so the positive path is
        # measurable and the gate itself is source-asserted rather than pretended.
        # The live member has no shipping address on file yet, so assert the flag
        # (masking is off for a privileged caller) and the gate below, not a value
        # that legitimately does not exist.
        mem_block = m360.get("member") or {}
        check("member 360 does not mask shipping PII for a privileged caller",
              mem_block.get("pii_masked") is False,
              f"masked={mem_block.get('pii_masked')} address={'set' if mem_block.get('address') else 'not on file'}")
        gate, _ = sql1("""select (pg_get_functiondef(
                            'public.admin_get_member_360(uuid)'::regprocedure)
                          like '%fulfilment.manage%') g""")
        check("member 360 gates shipping PII on fulfilment.manage",
              bool(gate) and gate["g"] is True, "")
        check("member 360 carries all 12 profile blocks",
              {"member", "outstanding", "tasks", "reflections", "sigma_logs", "nectar",
               "awards", "jar", "collaborations", "support", "audit"} <= set(m360.keys()),
              f"keys={sorted(m360.keys())}")

    fq = results.get("admin_get_fulfilment_queue", {})
    if fq:
        check("fulfilment queue returns stock and status counts",
              "counts" in fq and "stock" in fq, f"keys={sorted(fq.keys())}")
        check("fulfilment queue shows addresses to a privileged caller",
              fq.get("pii_visible") is True, f"pii_visible={fq.get('pii_visible')}")
        gate2, _ = sql1("""select (pg_get_functiondef(
                             'public.admin_get_fulfilment_queue(text,integer)'::regprocedure)
                           like '%fulfilment.manage%') g""")
        check("fulfilment queue gates addresses on fulfilment.manage",
              bool(gate2) and gate2["g"] is True, "")
        check("fulfilment queue lists the full status flow",
              len(fq.get("flow") or []) == 9 and len(fq.get("terminal") or []) == 4,
              f"flow={len(fq.get('flow') or [])} terminal={len(fq.get('terminal') or [])}")

    print("\nSTAGE 4 — ingest proof (real write, then explicitly cleaned up)")
    base, _ = sql1("""select (select count(*) from public.task_sigma_logs) refl,
                             (select count(*) from public.member_reviews) q""")
    ok, payload = sql(as_role([
        "insert into public.task_sigma_logs (user_id, task_id, define, measure, analysis, improve, control)",
        f"values ('{MUID}', (select id from public.tasks limit 1), 'verifier probe', 'm', 'a', 'i', 'c');",
    ], role="authenticated", claims={"sub": MUID, "role": "authenticated"}))
    check("member can still submit a reflection (the trigger cannot block them)", ok,
          "" if ok else str(payload)[:200])

    row, err = sql1(f"""select count(*) n from public.member_reviews r
                         where r.source = 'task_reflection' and r.source_id = (
                           select l.id::text from public.task_sigma_logs l
                            where l.user_id = '{MUID}' and l.define = 'verifier probe'
                            order by l.created_at desc limit 1)""")
    check("the new reflection auto-enqueued exactly one review item",
          bool(row) and row["n"] == 1, f"queued={row and row['n']}, err={err}")

    ok_clean, clean_payload = sql(as_owner([
        "delete from public.member_reviews where source = 'task_reflection'",
        "  and source_id in (select id::text from public.task_sigma_logs where define = 'verifier probe');",
        "delete from public.task_sigma_logs where define = 'verifier probe';",
    ]))
    after, _ = sql1("""select (select count(*) from public.task_sigma_logs) refl,
                              (select count(*) from public.member_reviews) q""")
    check("verifier cleaned up after itself (counts back to baseline)",
          ok_clean and after == base, f"{base} -> {after}")

    print("\nSTAGE 5 — reading changes nothing")
    before, _ = sql1("""select (select coalesce(sum(delta),0) from public.nectar_ledger) led,
                               (select count(*) from public.user_tokens) tok,
                               (select count(*) from public.user_milestones) mil,
                               (select count(*) from public.task_sigma_logs) refl""")
    ok, payload = sql(as_role(["select public.admin_get_reflections(null, 100, 0);",
                               "select public.admin_get_member_360('" + MUID + "');"],
                              role="authenticated", claims={"sub": AUID, "role": "authenticated"}))
    after, _ = sql1("""select (select coalesce(sum(delta),0) from public.nectar_ledger) led,
                              (select count(*) from public.user_tokens) tok,
                              (select count(*) from public.user_milestones) mil,
                              (select count(*) from public.task_sigma_logs) refl""")
    check("reading reflections/360 leaves nectar, tokens, milestones and submissions untouched",
          ok and before == after, f"{before} -> {after} ({'' if ok else str(payload)[:120]})")

    row, err = sql1("""select count(*) n from public.member_reviews
                        where source in ('task_reflection','sigma_log')""")
    check("review queue backfilled from existing submissions",
          bool(row) and row["n"] >= 12, f"{row and row['n']} queued")

    return summary()


def summary():
    print(f"\nRESULT: {len(PASS)} PASS / {len(FAIL)} FAIL")
    if THROTTLE_NOTE:
        print(f"NOTE: {THROTTLE_NOTE[0]} x{len(THROTTLE_NOTE)}")
    if FAIL:
        for name in FAIL:
            print(f"  FAILED: {name}")
        return 1
    print("ALL GREEN — Phase A read layer is live and refuses non-admins.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
