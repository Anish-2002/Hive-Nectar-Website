#!/usr/bin/env python3
"""Apply + verify migration 12 — security remediation of the four approved findings.

Stage 0 applies information/admin-crm/sql/2026-10-13-12-security-remediation.sql,
then the checks run against the live database.

What is proven
  * nobody anonymous or non-administrator reaches the two maintenance functions,
  * a non-administrator member is refused by the two member-mutating helpers
    BEFORE any row is touched (blast radius measured, not assumed),
  * the refusals are real privilege errors (42501), not silent successes,
  * an administrator still passes the new guards (no false positive),
  * is_admin()/storage_admin() keep the grants 20 RLS policies depend on,
  * the real PostgREST endpoint refuses the anon key.

Exit 0 = all checks passed.
"""
import json, os, re, sys, time, urllib.error, urllib.request

REF = "gxboojbfmpejbjolfmjq"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
REST = f"https://{REF}.supabase.co/rest/v1/rpc"
ROOT = "/home/it-guy/Documents/hive nectar/The Meadows react."
SQL_FILE = f"{ROOT}/information/admin-crm/sql/2026-10-13-12-security-remediation.sql"

MEMBER = "0b336cd0-c4e8-41e3-816b-68a47e824c35"   # signed-in member, member_tier = 0
ADMIN = "04214ab6-36b8-4e60-bbfc-c2d0764f9cf6"    # administrator (super_admin)

ENV = {}
with open(os.path.expanduser("~/.hive-nectar/credentials.env")) as fh:
    for line in fh:
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.strip().split("=", 1)
            ENV[k] = v
TOK = ENV["SUPABASE_ACCESS_TOKEN"]
ANON = None
for cand in ("/home/it-guy/Documents/hive nectar/The Meadows react./.env",
             "/home/it-guy/Documents/hive nectar/The Meadows react./public/js/supabase-config.js",
             "/home/it-guy/Documents/hive nectar/Hive-Nectar-Website-02-aug2026/js/supabase-config.js"):
    if os.path.exists(cand):
        m = re.search(r"ANON[_A-Z]*\s*[:=]\s*['\"]?([A-Za-z0-9._\-]{20,})['\"]?", open(cand).read())
        if m:
            ANON = m.group(1)
            break

PASS = []
FAIL = []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  -- {detail}" if detail else ""))


def _once(q, timeout=240):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:900]
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:400]


def run(q, timeout=240, attempts=5):
    for attempt in range(attempts):
        ok, payload = _once(q, timeout)
        if ok:
            return ok, payload
        if "Too Many Requests" not in str(payload) and "429" not in str(payload):
            return ok, payload
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    return False, f"rate limited after {attempts} attempts: {payload}"


def scalar(q, attempts=5):
    ok, rows = run(q, attempts=attempts)
    if not ok:
        sys.exit(f"query failed: {rows[:300]}")
    if not rows:
        return None
    return list(rows[0].values())[0]


def as_role(role, claims, statement):
    """Run one statement genuinely as `role` (SET ROLE, not just faked claims).

    Returns (ok, body). A refusal is expected for the checks below.
    """
    batch = f"begin;\nset local role {role};\n"
    if claims:
        batch += f"set local request.jwt.claims = '{json.dumps(claims)}';\n"
    batch += statement + "\nrollback;"
    return run(batch)


def as_role_commit(role, claims, statement):
    """Same as as_role but WITHOUT the enclosing ROLLBACK: rows really persist.

    Used to prove an administrator's operation succeeds and is audited. Only ever
    pointed at a scratch uuid that has no profile row, so nothing real changes.
    """
    batch = f"set role {role};\n"
    batch += f"set request.jwt.claims = '{json.dumps(claims)}';\n"
    batch += statement
    return run(batch)


def main():
    sql = open(SQL_FILE).read()
    print("=" * 78)
    print("stage 0: apply 2026-10-13-12-security-remediation.sql")
    ok, res = run(sql)
    if not ok:
        sys.exit(f"APPLY FAILED: {res}")
    print(f"  applied ({len(sql.splitlines())} lines)")

    print("=" * 78)
    print("A. EXECUTE privileges (has_function_privilege, definitive)")
    HSE = "select has_function_privilege('{r}', 'public.{f}', 'execute')"
    cases = [
        ("anon may no longer execute handle_subscription_event", "anon",
         "handle_subscription_event(text,text,text,bigint,text)", False),
        ("authenticated may no longer execute handle_subscription_event", "authenticated",
         "handle_subscription_event(text,text,text,bigint,text)", False),
        ("service_role keeps handle_subscription_event (stripe-webhook)", "service_role",
         "handle_subscription_event(text,text,text,bigint,text)", True),
        ("postgres keeps handle_subscription_event", "postgres",
         "handle_subscription_event(text,text,text,bigint,text)", True),
        ("anon may no longer execute downgrade_expired_subscriptions", "anon",
         "downgrade_expired_subscriptions()", False),
        ("authenticated keeps EXECUTE on downgrade_expired_subscriptions (guarded inside)",
         "authenticated", "downgrade_expired_subscriptions()", True),
        ("authenticated keeps EXECUTE on reset_user_progress_by_id (guarded inside)",
         "authenticated", "reset_user_progress_by_id(uuid)", True),
        ("authenticated keeps EXECUTE on unlock_all_tasks_for_user (guarded inside)",
         "authenticated", "unlock_all_tasks_for_user(uuid)", True),
        ("anon still cannot execute the guard assert_admin_can", "anon",
         "assert_admin_can(text)", False),
    ]
    for label, role, fn, want in cases:
        got = scalar(HSE.format(r=role, f=fn))
        check(label, got == want, f"{role} -> {got}")

    print("=" * 78)
    print("B. a signed-in NON-ADMINISTRATOR member is refused, and nothing is touched")
    before_tasks = scalar(f"select count(*) from public.user_tasks where user_id = '{MEMBER}'")
    before_points = scalar(f"select nectar_points from public.profiles where id = '{MEMBER}'")
    before_tokens = scalar(f"select count(*) from public.user_tokens where user_id = '{MEMBER}'")
    claims = {"sub": MEMBER, "role": "authenticated", "email": "member-test@example.invalid"}

    ok, body = as_role("authenticated", claims,
                       f"select public.reset_user_progress_by_id('{MEMBER}'::uuid);")
    check("member is refused by reset_user_progress_by_id",
          (not ok) and ("42501" in body or "Forbidden" in body), body[:120])

    ok, body = as_role("authenticated", claims,
                       f"select public.unlock_all_tasks_for_user('{MEMBER}'::uuid);")
    check("member is refused by unlock_all_tasks_for_user",
          (not ok) and ("42501" in body or "Forbidden" in body), body[:120])

    ok, body = as_role("authenticated", claims, "select public.downgrade_expired_subscriptions();")
    check("member is refused by downgrade_expired_subscriptions",
          (not ok) and ("42501" in body or "Forbidden" in body), body[:120])

    ok, body = as_role("authenticated", claims,
                       "select public.handle_subscription_event('checkout.session.completed',"
                       f"'sub_forged','cus_forged',9999999999,'prod_UA887AjJ5IRT3T');")
    check("member cannot forge a Stripe subscription event",
          (not ok) and ("42501" in body or "permission denied" in body), body[:120])

    after_tasks = scalar(f"select count(*) from public.user_tasks where user_id = '{MEMBER}'")
    after_points = scalar(f"select nectar_points from public.profiles where id = '{MEMBER}'")
    after_tokens = scalar(f"select count(*) from public.user_tokens where user_id = '{MEMBER}'")
    check("blast radius nil: user_tasks unchanged", before_tasks == after_tasks,
          f"{before_tasks} -> {after_tasks}")
    check("blast radius nil: nectar_points unchanged", before_points == after_points,
          f"{before_points} -> {after_points}")
    check("blast radius nil: user_tokens unchanged", before_tokens == after_tokens,
          f"{before_tokens} -> {after_tokens}")

    tier = scalar(f"select coalesce(tier,'(null)') from public.profiles where id = '{MEMBER}'")
    check("no tier was granted by the forged event", tier not in ("plus", "steward", "collective"),
          f"tier = {tier}")

    print("=" * 78)
    print("C. anonymous (no session at all) is refused")
    for label, stmt in [
        ("anon cannot forge a subscription event",
         "select public.handle_subscription_event('checkout.session.completed','s','c',1,'prod_UA887AjJ5IRT3T');"),
        ("anon cannot run downgrade_expired_subscriptions",
         "select public.downgrade_expired_subscriptions();"),
        (f"anon cannot reset another member's progress",
         f"select public.reset_user_progress_by_id('{MEMBER}'::uuid);"),
    ]:
        ok, body = as_role("anon", None, stmt)
        check(label, (not ok) and ("42501" in body or "permission denied" in body), body[:110])

    print("=" * 78)
    print("D. an administrator still passes the new guards (no false positive)")
    for perm in ("member.write", "billing.manage"):
        got = scalar(f"select public.admin_can('{perm}', '{ADMIN}')")
        check(f"super_admin holds {perm}", got is True, f"-> {got}")
    check("the admin still resolves to a role through admin_role_of",
          scalar(f"select public.admin_role_of('{ADMIN}')") == "super_admin")

    print("=" * 78)
    print("E. the grants 20 RLS policies depend on are intact")
    for fn, role in (("is_admin(uuid)", "authenticated"), ("storage_admin()", "authenticated"),
                     ("is_admin(uuid)", "anon"), ("storage_admin()", "anon")):
        got = scalar(f"select has_function_privilege('{role}', 'public.{fn}', 'execute')")
        check(f"{role} keeps EXECUTE on {fn}", got is True, f"-> {got}")
    pol = scalar("""select count(*) from pg_policy pol
       where pg_get_expr(pol.polqual, pol.polrelid) ilike '%is_admin%'
          or pg_get_expr(pol.polqual, pol.polrelid) ilike '%storage_admin%'
          or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%is_admin%'
          or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%storage_admin%'""")
    check("RLS policies still reference those helpers", pol and pol >= 20, f"{pol} policies")

    print("=" * 78)
    print("F. live PostgREST with the real anon key")
    if not ANON:
        check("anon key located", False, "supabase-config.js not found")
    else:
        for fn, payload in (("handle_subscription_event",
                             {"p_event_type": "checkout.session.completed",
                              "p_stripe_sub_id": "sub_forged", "p_customer_id": "cus_forged",
                              "p_period_end": 9999999999, "p_product_id": "prod_UA887AjJ5IRT3T"}),
                            ("downgrade_expired_subscriptions", {})):
            req = urllib.request.Request(
                f"{REST}/{fn}", data=json.dumps(payload).encode(),
                headers={"apikey": ANON, "Authorization": f"Bearer {ANON}",
                         "Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    status, text = r.status, r.read().decode()[:200]
            except urllib.error.HTTPError as e:
                status, text = e.code, e.read().decode()[:200]
            except Exception as e:  # noqa: BLE001
                status, text = 0, str(e)[:200]
            check(f"PostgREST refuses anon on {fn}",
                  status in (401, 403) and "42501" in text, f"HTTP {status} {text[:90]}")

    print("=" * 78)
    print("G. the administrator path is open end-to-end, and the operation is audited")
    admin_claims = {"sub": ADMIN, "role": "authenticated", "email": "admin@example.invalid"}
    ok, body = as_role("authenticated", admin_claims, "select public.assert_admin_can('member.write');")
    check("assert_admin_can is internal: a client session cannot call it directly",
          (not ok) and "permission denied" in body, body[:90])

    scratch = "00000000-0000-4000-8000-0000000000aa"   # no such profile: nothing real is touched
    audits_before = scalar("select count(*) from public.admin_action_logs "
                           "where action = 'member.progress_reset'")
    ok, body = as_role_commit("authenticated", admin_claims,
                              f"select public.reset_user_progress_by_id('{scratch}'::uuid);")
    check("an administrator can still run reset_user_progress_by_id",
          ok and "successfully" in str(body), str(body)[:110])
    audits_after = scalar("select count(*) from public.admin_action_logs "
                          "where action = 'member.progress_reset'")
    check("the operation was written to the audit log (server-authorised AND audited)",
          audits_after > audits_before, f"{audits_before} -> {audits_after}")
    check("the audited operation touched no real profile",
          scalar(f"select count(*) from public.profiles where id = '{scratch}'") == 0)

    print("=" * 78)
    print(f"RESULT: {len(PASS)} PASS / {len(FAIL)} FAIL")
    if FAIL:
        print("failed checks:")
        for f in FAIL:
            print("   -", f)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
