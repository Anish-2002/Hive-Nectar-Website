#!/usr/bin/env python3
"""Apply + verify migration 09 (admin roles, invitations, audit log).
Read-only outside its own rolled-back transaction. Prints PASS/FAIL counts."""
import json
import time, os, sys, urllib.request, urllib.error
from pathlib import Path

REF = "gxboojbfmpejbjolfmjq"
ADMIN_UID = "04214ab6-36b8-4e60-bbfc-c2d0764f9cf6"
TEST_UID = "0b336cd0-c4e8-41e3-816b-68a47e824c35"
MIG = Path("/home/it-guy/Documents/hive nectar/The Meadows react./information/admin-crm/sql/2026-10-13-09-admin-roles-audit-invitations.sql")

creds = {}
for line in Path(os.path.expanduser("~/.hive-nectar/credentials.env")).read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip().strip('"').strip("'")
TOK = creds["SUPABASE_ACCESS_TOKEN"]

PASS = FAIL = 0
def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"PASS  {name}")
    else:
        FAIL += 1; print(f"FAIL  {name}  {extra}")

def _once(q, timeout=180):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:900]
    except Exception as e:
        return False, str(e)[:400]


def run(q, timeout=180, attempts=5):
    """Retry wrapper: the management API rate-limits bursts of queries with
    `ThrottlerException: Too Many Requests`, which must not be reported as a check
    failure or as an administrator that cannot act."""
    last = None
    for attempt in range(attempts):
        ok, payload = _once(q, timeout)
        if ok:
            return ok, payload
        last = str(payload)
        if "Too Many Requests" not in last and "429" not in last:
            return ok, payload
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    return False, f"rate limited after {attempts} attempts: {last}"


def claims(uid):
    return "select set_config('request.jwt.claims', json_build_object('sub','%s','role','authenticated')::text, true);" % uid

# ---------------------------------------------------------------- stage A ---
print("== stage A: apply migration 09 ==")
ok, data = run(MIG.read_text())
check("migration applied without error", ok, str(data)[:400])
if not ok:
    sys.exit(1)

# ---------------------------------------------------------------- stage B ---
print("== stage B: structure ==")
ok, rows = run("""
select jsonb_build_object(
 'tables', (select count(*) from information_schema.tables where table_schema='public'
            and table_name in ('admin_roles','admin_team_members','admin_invitations','admin_action_logs')),
 'rls_on', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relname in ('admin_roles','admin_team_members','admin_invitations','admin_action_logs')
            and c.relrowsecurity),
 'roles', (select count(*) from public.admin_roles),
 'seeded_team', (select count(*) from public.admin_team_members),
 'admin_is_super', (select count(*) from public.admin_team_members where user_id='%s' and role_key='super_admin'),
 'funcs', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
           and p.proname in ('admin_role_of','admin_can','assert_admin_can','log_admin_action','tg_audit_admin_tables',
             'admin_get_team_overview','admin_invite_admin','admin_revoke_invitation','admin_accept_invitation',
             'admin_get_my_pending_invitations','admin_set_team_role','admin_set_team_status','admin_get_action_logs',
             'admin_get_audit_actions','admin_get_my_context','admin_log_action')),
 'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
              where not t.tgisinternal and c.relname in ('admin_team_members','admin_invitations')),
 'anon_cannot_invite', not has_function_privilege('anon','public.admin_invite_admin(text,text,text)','execute'),
 'anon_cannot_read_team', not has_function_privilege('anon','public.admin_get_team_overview()','execute'),
 'anon_cannot_read_audit', not has_function_privilege('anon','public.admin_get_action_logs(integer,text,uuid,text,text,text)','execute'),
 'auth_can_invite', has_function_privilege('authenticated','public.admin_invite_admin(text,text,text)','execute'),
 'auth_can_accept', has_function_privilege('authenticated','public.admin_accept_invitation(text)','execute'),
 'auth_cannot_raw_log', not has_function_privilege('authenticated','public.log_admin_action(text,text,text,jsonb,jsonb,text)','execute')
) as r
""" % ADMIN_UID)
if not ok:
    check("stage B queries ran", False, str(rows)[:500]); sys.exit(1)
d = rows[0]["r"] if isinstance(rows, list) and rows and "r" in rows[0] else rows
if isinstance(d, list): d = d[0]
check("4 new tables exist", d["tables"] == 4, d)
check("RLS enabled on all 4", d["rls_on"] == 4, d)
check("7 roles seeded", d["roles"] == 7, d["roles"])
check("existing admin seeded onto the team", d["seeded_team"] >= 1 and d["admin_is_super"] == 1, d)
check("16 functions present", d["funcs"] == 16, d["funcs"])
check("audit triggers installed", d["triggers"] == 2, d["triggers"])
check("anon cannot call invite", d["anon_cannot_invite"], d)
check("anon cannot call team overview", d["anon_cannot_read_team"], d)
check("anon cannot call audit log", d["anon_cannot_read_audit"], d)
check("authenticated can call invite", d["auth_can_invite"], d)
check("authenticated can call accept", d["auth_can_accept"], d)
check("raw log_admin_action not exposed", d["auth_cannot_raw_log"], d)

# ---------------------------------------------------------------- stage C ---
print("== stage C: invitation + role lifecycle (rolled back) ==")
ok, rows = run("""
select email from public.profiles where id = '%s'
""" % TEST_UID)
invitee_email = rows[0]["email"] if ok and rows else ""
check("test member profile found for the lifecycle probe", bool(invitee_email), invitee_email)
if invitee_email:
    sql = """
begin;
create temp table probe_out(step text, res jsonb) on commit drop;
grant all on probe_out to authenticated;
set local role authenticated;
{claims_admin}
do $do$
declare
  tok text; inv jsonb; declare2 jsonb; acc jsonb; chg jsonb; rev jsonb; logs jsonb; ctx jsonb;
  sup_now text; sup_ok boolean; audit_denied boolean; note_ok jsonb;
begin
  inv := public.admin_invite_admin('{invitee}', 'support_agent', 'verify run');
  insert into probe_out values ('invite', inv);
  tok := inv->>'token';

  -- an administrator may not accept somebody else's invitation
  insert into probe_out values ('accept_wrong_user',
    public.admin_accept_invitation(tok));

  -- the invited member accepts
  perform set_config('request.jwt.claims', json_build_object('sub','{test}','role','authenticated')::text, true);
  acc := public.admin_accept_invitation(tok);
  insert into probe_out values ('accept', acc);
  insert into probe_out values ('my_pending', public.admin_get_my_pending_invitations());

  -- back to the administrator
  perform set_config('request.jwt.claims', json_build_object('sub','{admin}','role','authenticated')::text, true);
  chg := public.admin_set_team_role('{test}', 'member_reviewer', 'verify run');
  insert into probe_out values ('role_change', chg);

  -- last Super Admin protection
  insert into probe_out values ('demote_last_super', public.admin_set_team_role('{admin}', 'analyst', 'should fail'));
  insert into probe_out values ('suspend_last_super', public.admin_set_team_status('{admin}', 'suspended', 'should fail'));
  insert into probe_out values ('suspend_self', public.admin_set_team_status('{admin}', 'suspended', 'should fail'));

  -- audit trail is readable and populated
  logs := public.admin_get_action_logs(50);
  insert into probe_out values ('audit', jsonb_build_object('count', logs->>'count',
        'actions', (select jsonb_agg(distinct x->>'action') from jsonb_array_elements(logs->'rows') x)));
  insert into probe_out values ('audit_filters', public.admin_get_audit_actions());
  note_ok := public.admin_log_action('verify.manual_note', 'admin_team_members', '{test}', 'probe note');
  insert into probe_out values ('manual_note', note_ok);

  -- permissions of a Member Reviewer
  perform set_config('request.jwt.claims', json_build_object('sub','{test}','role','authenticated')::text, true);
  insert into probe_out values ('reviewer_can_review', jsonb_build_object('v', public.admin_can('review.decide')));
  insert into probe_out values ('reviewer_cannot_manage_team', jsonb_build_object('v', public.admin_can('team.manage')));
  begin
    perform public.admin_get_action_logs(5);
    audit_denied := false;
  exception when others then
    audit_denied := true;
  end;
  insert into probe_out values ('reviewer_audit_denied', jsonb_build_object('v', audit_denied));

  -- revoke path: a fresh invitation can be revoked, an accepted one cannot
  perform set_config('request.jwt.claims', json_build_object('sub','{admin}','role','authenticated')::text, true);
  declare2 := public.admin_invite_admin('probe.revoke@example.com', 'analyst', 'verify run');
  rev := public.admin_revoke_invitation((declare2->>'invitation_id')::uuid, 'verify run');
  insert into probe_out values ('revoke', rev);
  insert into probe_out values ('revoke_after_accept', public.admin_revoke_invitation((inv->>'invitation_id')::uuid, 'should fail'));
  insert into probe_out values ('team_overview', jsonb_build_object(
      'members', jsonb_array_length(public.admin_get_team_overview()->'members'),
      'invitations', jsonb_array_length(public.admin_get_team_overview()->'invitations'),
      'roles', jsonb_array_length(public.admin_get_team_overview()->'roles')));
end $do$;
select jsonb_object_agg(step, res) as out from probe_out;
rollback;
""".format(claims_admin=claims(ADMIN_UID), invitee=invitee_email, admin=ADMIN_UID, test=TEST_UID)
    ok, rows = run(sql)
    if not ok:
        check("lifecycle block ran", False, str(rows)[:700])
    else:
        out = rows[0]["out"] if isinstance(rows, list) and rows and "out" in rows[0] else rows
        if isinstance(out, list): out = out[0]
        def g(k): return out.get(k) if isinstance(out, dict) else None
        check("invitation created", bool(g("invite") and g("invite",).get("success")) if g("invite") else False, g("invite"))
        check("token + accept_url returned once", bool(g("invite") and (g("invite").get("token") or "").__len__() == 64
              and g("invite").get("accept_url", "").startswith("/admin?invite=")), g("invite"))
        check("wrong signed-in user cannot accept", bool(g("accept_wrong_user") and
              g("accept_wrong_user").get("success") is False), g("accept_wrong_user"))
        check("invited member accepts -> role granted", bool(g("accept") and g("accept").get("success")
              and g("accept").get("role_key") == "support_agent"), g("accept"))
        check("pending list empties after acceptance", g("my_pending") == [], g("my_pending"))
        check("role change applied", bool(g("role_change") and g("role_change").get("success")
              and g("role_change").get("role_key") == "member_reviewer"), g("role_change"))
        check("last Super Admin cannot be demoted", bool(g("demote_last_super") and not g("demote_last_super").get("success")), g("demote_last_super"))
        check("last Super Admin cannot be suspended", bool(g("suspend_last_super") and not g("suspend_last_super").get("success")), g("suspend_last_super"))
        check("admin cannot suspend self", bool(g("suspend_self") and not g("suspend_self").get("success")), g("suspend_self"))
        audit = g("audit") or {}
        check("audit log populated", bool(audit.get("count")) and int(audit.get("count", 0)) >= 5, audit)
        acts = set(audit.get("actions") or [])
        check("invite + role + status changes all audited",
              {"team.invite_created", "team.invite_accepted", "team.role_changed"} <= acts, acts)
        check("manual note written through admin_log_action",
              bool(g("manual_note") and g("manual_note").get("success")), g("manual_note"))
        check("reviewer holds review.decide", bool(g("reviewer_can_review") and g("reviewer_can_review").get("v")), g("reviewer_can_review"))
        check("reviewer lacks team.manage", bool(g("reviewer_cannot_manage_team") and g("reviewer_cannot_manage_team").get("v") is False), g("reviewer_cannot_manage_team"))
        check("audit read denied to reviewer (RPC raises)", bool(g("reviewer_audit_denied") and g("reviewer_audit_denied").get("v")), g("reviewer_audit_denied"))
        check("invitation revoke works", bool(g("revoke") and g("revoke").get("success")), g("revoke"))
        check("accepted invitation cannot be revoked", bool(g("revoke_after_accept")
              and g("revoke_after_accept").get("success") is False), g("revoke_after_accept"))
        ov = g("team_overview") or {}
        check("team overview returns members/roles/invitations",
              (ov.get("members", 0) >= 1 and ov.get("roles", 0) == 7 and ov.get("invitations", 0) >= 1), ov)

# ---------------------------------------------------------------- stage D ---
print("== stage D: negative access control ==")
ok, res = run("begin; set local role anon; select public.admin_get_team_overview(); rollback;")
check("anon call to team overview refused", (not ok) and ("permission denied" in str(res).lower() or "42501" in str(res)), str(res)[:200])

ok, res = run("begin; set local role anon; select count(*) as c from public.admin_action_logs; rollback;")
rows = res if ok else []
cnt = rows[0]["c"] if ok and isinstance(rows, list) and rows else None
check("anon sees zero audit rows through RLS", (ok and cnt == 0), str(res)[:200])

ok, res = run("begin; set local role anon; select count(*) as c from public.admin_team_members; rollback;")
cnt = res[0]["c"] if ok and isinstance(res, list) and res else None
check("anon sees zero team rows through RLS", (ok and cnt == 0), str(res)[:200])

ok, res = run("begin; set local role authenticated; " + claims(TEST_UID) +
              " select public.admin_get_action_logs(5); rollback;")
check("non-admin member cannot read the audit log", (not ok) and ("42501" in str(res) or "Forbidden" in str(res) or "permission" in str(res).lower()), str(res)[:200])

ok, res = run("begin; set local role authenticated; " + claims(TEST_UID) +
              " select public.admin_invite_admin('x@y.com','analyst',null); rollback;")
check("non-admin member cannot invite", (not ok) and ("42501" in str(res) or "Forbidden" in str(res)), str(res)[:200])

# ---------------------------------------------------------------- stage D2 --
print("== stage D2: 'read.all' must not satisfy write permissions ==")
sql = """
begin;
insert into public.admin_team_members (user_id, role_key, notes)
values ('{test}', 'analyst', 'verify run')
on conflict (user_id) do update set role_key = 'analyst';
{claims}
select jsonb_build_object(
  'analyst_read_all',      public.admin_can('read.all'),
  'analyst_member_read',   public.admin_can('member.read'),
  'analyst_billing_read',  public.admin_can('billing.read'),
  'analyst_manage_team',   public.admin_can('team.manage'),
  'analyst_write_member',  public.admin_can('member.write'),
  'analyst_nectar_adjust', public.admin_can('nectar.adjust'),
  'analyst_settings',      public.admin_can('settings.write'));
rollback;
""".format(test=TEST_UID, claims=claims(TEST_UID))
ok, rows = run(sql)
if not ok:
    check("analyst permission probe ran", False, str(rows)[:400])
else:
    d = rows[0] if isinstance(rows, list) and rows else rows
    if isinstance(d, list):
        d = d[0] if d else {}
    if isinstance(d, dict) and set(d) == {"jsonb_build_object"}:
        d = d["jsonb_build_object"] or {}
    check("analyst keeps read.all", d.get("analyst_read_all") is True, str(d)[:300])
    check("read.all satisfies member.read", d.get("analyst_member_read") is True, str(d)[:300])
    check("explicit billing.read still held", d.get("analyst_billing_read") is True, str(d)[:300])
    check("read.all does NOT grant team.manage", d.get("analyst_manage_team") is False, str(d)[:300])
    check("read.all does NOT grant member.write", d.get("analyst_write_member") is False, str(d)[:300])
    check("read.all does NOT grant nectar.adjust", d.get("analyst_nectar_adjust") is False, str(d)[:300])
    check("read.all does NOT grant settings.write", d.get("analyst_settings") is False, str(d)[:300])

ok, rows = run("begin; {claims} select jsonb_build_object('super_team', public.admin_can('team.manage'), "
               "'super_settings', public.admin_can('settings.write')); rollback;".format(claims=claims(ADMIN_UID)))
d = (rows[0] if isinstance(rows, list) and rows else rows) if ok else {}
if isinstance(d, list):
    d = d[0] if d else {}
if isinstance(d, dict) and set(d) == {"jsonb_build_object"}:
    d = d["jsonb_build_object"] or {}
check("Super Admin still holds every write permission",
      d.get("super_team") is True and d.get("super_settings") is True, str(d)[:300])

# ---------------------------------------------------------------- stage E ---
print("== stage E: no residue ==")
ok, rows = run("select jsonb_build_object('team', (select count(*) from public.admin_team_members), 'inv', (select count(*) from public.admin_invitations), 'test_member', (select count(*) from public.admin_team_members where user_id='%s')) as r" % TEST_UID)
if ok:
    d = rows[0]["r"] if isinstance(rows, list) and rows and "r" in rows[0] else rows
    if isinstance(d, list): d = d[0]
    check("rolled-back probe left no team/invitation rows", d["team"] == 1 and d["inv"] == 0 and d["test_member"] == 0, d)
else:
    check("stage E query ran", False, str(rows)[:300])

print(f"\nRESULT  {PASS} PASS / {FAIL} FAIL")
sys.exit(1 if FAIL else 0)
