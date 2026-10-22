#!/usr/bin/env python3
"""
apply_verify_migration11.py -- apply migration 11 and prove it works.

The CRM brief says a screen that does nothing is unacceptable, so this script
does not check "the file is syntactically fine". It calls every function the new
modules expose, with real data from the live database, and asserts what came
back -- including the refusals (out of stock, backwards transition, duplicate
award, overdraft, missing reason).

All functional work runs inside one transaction that is rolled back at the end,
so the production database is left exactly as it was found. The only permanent
change is the migration itself plus its three seed catalogue rows.

Usage:  python3 information/admin-crm/verification/apply_verify_migration11.py
Exit:   0 = all checks passed, 1 = at least one failed.
"""
import json
import time
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
MIG = HERE.parent / "sql" / "2026-10-13-11-crm-modules.sql"
MIG09 = HERE.parent / "sql" / "2026-10-13-09-admin-roles-audit-invitations.sql"

ADMIN_UID = "04214ab6-36b8-4e60-bbfc-c2d0764f9cf6"
TEST_UID = "0b336cd0-c4e8-41e3-816b-68a47e824c35"

PASS = 0
FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {label}")
    else:
        FAIL += 1
        print(f"FAIL  {label}  <<< {str(detail)[:600]}")


def creds():
    env = {}
    path = Path(os.path.expanduser("~/.hive-nectar/credentials.env"))
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    env.setdefault("SUPABASE_PROJECT_REF", "gxboojbfmpejbjolfmjq")
    return env


ENV = creds()
REF = ENV.get("SUPABASE_PROJECT_REF", "gxboojbfmpejbjolfmjq")
PAT = ENV.get("SUPABASE_ACCESS_TOKEN")


def _once(query, timeout=240):
    """Run SQL through the management API. Returns (ok, json|error-text)."""

    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        method="POST",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return False, e.read().decode()[:1500]
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def first_row(res):
    """The management API returns [row], [[row]] or [{'jsonb_build_object': row}]."""
    if isinstance(res, dict):
        return res
    if isinstance(res, list):
        if not res:
            return {}
        row = res[0]
        if isinstance(row, list):
            row = row[0] if row else {}
        if isinstance(row, dict) and len(row) == 1:
            only = next(iter(row.values()))
            if isinstance(only, dict):
                return only
        return row
    return res


def claims(uid):
    return ("select set_config('request.jwt.claims', "
            "json_build_object('sub','%s','role','authenticated')::text, true);" % uid)


def run(query, timeout=240, attempts=5):
    """Retry wrapper: the management API rate-limits bursts of queries with
    `ThrottlerException: Too Many Requests`, which must not be reported as a check
    failure or as an administrator that cannot act."""
    last = None
    for attempt in range(attempts):
        ok, payload = _once(query, timeout)
        if ok:
            return ok, payload
        last = str(payload)
        if "Too Many Requests" not in last and "429" not in last:
            return ok, payload
        if attempt < attempts - 1:
            time.sleep(20 * (attempt + 1))
    return False, f"rate limited after {attempts} attempts: {last}"


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


print("== stage 0: apply migration 09 (fixed read.all) + migration 11 ==")
for path in (MIG09, MIG):
    if not path.exists():
        check(f"{path.name} present", False, path)
        continue
    ok, res = run(path.read_text(), timeout=300)
    check(f"applied {path.name}", ok, res)

# ---------------------------------------------------------------- stage A ---
print("== stage A: catalogue of what now exists ==")
ok, res = run("""
select jsonb_build_object(
  'tables', (select jsonb_agg(t order by t) from (select tablename t from pg_tables where schemaname='public'
     and tablename in ('member_reviews','member_review_events','nectar_ledger','gift_catalogue',
                       'gift_stock_movements','recognitions','recognition_evidence','recognition_events',
                       'support_tickets','support_messages','support_templates','admin_notifications')) z),
  'rls_missing', (select coalesce(jsonb_agg(c.relname), '[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
       and c.relname in ('member_reviews','member_review_events','nectar_ledger','gift_catalogue',
                         'gift_stock_movements','recognitions','recognition_evidence','recognition_events',
                         'support_tickets','support_messages','support_templates','admin_notifications')),
  'fn_total', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'admin\\_%'),
  'fn_new', (select jsonb_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in ('admin_sync_review_queue','admin_get_review_queue','admin_get_review_item',
       'admin_assign_review','admin_set_review_status','admin_reply_to_member','admin_adjust_nectar','admin_get_nectar_ledger',
       'admin_get_settings','admin_save_setting','admin_delete_setting','admin_get_integration_health','admin_get_gifts',
       'admin_save_gift','admin_set_gift_active','admin_adjust_gift_stock','admin_get_gift_stock_movements',
       'admin_get_recognition_candidates','admin_get_recognitions','admin_get_recognition','admin_nominate_recognition',
       'admin_decide_recognition','admin_advance_recognition','admin_get_recognition_dashboard','admin_import_inquiries',
       'admin_get_tickets','admin_get_ticket','admin_create_ticket','admin_update_ticket','admin_reply_ticket',
       'admin_set_message_delivery','admin_merge_ticket','admin_get_support_templates','admin_save_support_template',
       'admin_delete_support_template','admin_get_notifications','admin_send_member_notification')),
  'anon_reachable', (select coalesce(jsonb_agg(p.proname), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'admin\\_%' and has_function_privilege('anon', p.oid, 'execute')),
  'auth_missing', (select coalesce(jsonb_agg(p.proname), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname in ('admin_get_review_queue','admin_get_tickets','admin_advance_recognition',
       'admin_save_gift','admin_send_member_notification')
       and not has_function_privilege('authenticated', p.oid, 'execute')),
  'get_all_config_anon', (select has_function_privilege('anon', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='get_all_config'),
  'gifts', (select count(*) from public.gift_catalogue),
  'roles_with_new_perms', (select count(*) from public.admin_roles where permissions && array['recognition.manage','review.read','settings.read'])
) as r
""")
d = first_row(res) if ok else {}
check("stage A query ran", ok, res)
check("all twelve new tables exist", len(d.get("tables") or []) == 12, d.get("tables"))
check("row level security on every new table", (d.get("rls_missing") or []) == [], d.get("rls_missing"))
check("all 37 new functions exist", len(d.get("fn_new") or []) == 37, len(d.get("fn_new") or []))
check("no admin_* function is anon-reachable", (d.get("anon_reachable") or []) == [], d.get("anon_reachable"))
check("new functions callable by a signed-in session", (d.get("auth_missing") or []) == [], d.get("auth_missing"))
check("get_all_config() exists and is anon-readable", d.get("get_all_config_anon") is True, d.get("get_all_config_anon"))
check("gift catalogue seeded", (d.get("gifts") or 0) >= 3, d.get("gifts"))
check("new permissions present in the role catalogue", (d.get("roles_with_new_perm") or d.get("roles_with_new_perms") or 0) >= 3,
      d.get("roles_with_new_perms"))

# pre-run snapshot for the residue check
ok, res = run("""select jsonb_build_object(
  'member_reviews',(select count(*) from public.member_reviews),
  'recognitions',(select count(*) from public.recognitions),
  'support_tickets',(select count(*) from public.support_tickets),
  'notifications',(select count(*) from public.admin_notifications),
  'nectar_ledger',(select count(*) from public.nectar_ledger),
  'gifts',(select count(*) from public.gift_catalogue)) as r""")
BEFORE = first_row(res) if ok else {}
check("pre-run snapshot taken", ok and bool(BEFORE), res)

# ---------------------------------------------------------------- stage B ---
print("== stage B: every new function called with real data (rolled back) ==")

FUNC_SQL = """
begin;

-- The RPCs authorise from the JWT claims, so the probe has to present the
-- primary administrator's session exactly like the browser does.
select set_config('request.jwt.claims',
                  json_build_object('sub','%(admin)s','role','authenticated')::text, true);

create temp table probe_out (step text primary key, res jsonb) on commit drop;

insert into public.support_templates (name, category, body)
values ('Closed ticket acknowledgement', 'closing',
        'Thanks for getting in touch -- we have closed this ticket. Reply any time to reopen it.')
on conflict (name) do nothing;

do $do$
declare
  r1 jsonb; r2 jsonb; item jsonb; d jsonb; c jsonb;
  v_review uuid; v_gift_a uuid; v_gift_b uuid; v_rec uuid; v_rec2 uuid; v_rec3 uuid;
  v_ticket uuid; v_mid uuid; v_t2 uuid; v_tpl uuid;
  v_addr jsonb := jsonb_build_object('address_line1','12 Wattle St','suburb','Fitzroy','state','VIC',
                                     'postcode','3065','country','Australia','consent',true,
                                     'recipient_name','Probe Member');
  procedure_probe text;
begin
  -- ---------------------------------------------------------- review centre
  insert into probe_out values ('sync', public.admin_sync_review_queue());
  insert into probe_out values ('queue', public.admin_get_review_queue(null, null, null, null, 5, 0));
  insert into probe_out values ('queue_reviewed', public.admin_get_review_queue('reviewed', null, null, null, 5, 0));

  select id into v_review from public.member_reviews order by created_at limit 1;
  insert into probe_out values ('has_queue_rows', jsonb_build_object('id', v_review));

  if v_review is not null then
    insert into probe_out values ('item', public.admin_get_review_item(v_review));
    insert into probe_out values ('status_in_review', public.admin_set_review_status(v_review, 'in_review', 'taking a look'));
    insert into probe_out values ('status_unknown', public.admin_set_review_status(v_review, 'banana', null));
    insert into probe_out values ('flag_no_reason', public.admin_set_review_status(v_review, 'flagged', null));
    insert into probe_out values ('flag_with_reason', public.admin_set_review_status(v_review, 'flagged', 'looks copied', 'duplicate wording'));
    insert into probe_out values ('assign', public.admin_assign_review(v_review, '%(admin)s', 'mine now'));
    insert into probe_out values ('assign_unknown', public.admin_assign_review(gen_random_uuid(), '%(admin)s', null));
    insert into probe_out values ('reply', public.admin_reply_to_member(v_review, 'Thanks for the write-up -- the detail on measurement is exactly what we hoped for.'));
    insert into probe_out values ('reply_blank', public.admin_reply_to_member(v_review, '   '));
    insert into probe_out values ('item_after', public.admin_get_review_item(v_review));
  end if;

  -- ---------------------------------------------------------- nectar ledger
  insert into probe_out values ('nectar_add', public.admin_adjust_nectar('%(test)s', 5, 'Probe: goodwill credit', 'adjustment'));
  insert into probe_out values ('nectar_zero', public.admin_adjust_nectar('%(test)s', 0, 'nothing'));
  insert into probe_out values ('nectar_no_reason', public.admin_adjust_nectar('%(test)s', 1, '  '));
  insert into probe_out values ('nectar_bad_category', public.admin_adjust_nectar('%(test)s', 1, 'why not', 'bribes'));
  insert into probe_out values ('nectar_overdraft', public.admin_adjust_nectar('%(test)s', -999999, 'probe overdraft'));
  insert into probe_out values ('nectar_ledger', public.admin_get_nectar_ledger('%(test)s', 10, 0));

  -- ---------------------------------------------------------- settings
  insert into probe_out values ('settings_list', public.admin_get_settings());
  insert into probe_out values ('settings_save', public.admin_save_setting('probe_setting', 'probe-value'));
  insert into probe_out values ('settings_after', public.admin_get_settings());
  insert into probe_out values ('settings_delete', public.admin_delete_setting('probe_setting'));
  insert into probe_out values ('settings_delete_missing', public.admin_delete_setting('probe_setting'));
  insert into probe_out values ('health', public.admin_get_integration_health());
  insert into probe_out values ('public_config', jsonb_build_object('cfg', public.get_all_config()));

  -- ---------------------------------------------------------- gift catalogue
  insert into probe_out values ('gift_a', public.admin_save_gift(jsonb_build_object(
      'name','Probe Gift A','description','created by the verifier','sku','PROBE-A','stock_quantity',2,
      'unit_cost',12.5,'eligibility','probe only','is_active',true)));
  select (res->'gift'->>'id')::uuid into v_gift_a from probe_out where step='gift_a';

  insert into probe_out values ('gift_b', public.admin_save_gift(jsonb_build_object(
      'name','Probe Gift B','sku','PROBE-B','stock_quantity',1,'is_active',true)));
  select (res->'gift'->>'id')::uuid into v_gift_b from probe_out where step='gift_b';

  insert into probe_out values ('gift_no_name', public.admin_save_gift(jsonb_build_object('name','  ','stock_quantity',1)));
  insert into probe_out values ('gift_negative_stock', public.admin_save_gift(jsonb_build_object('name','Bad','stock_quantity',-4)));
  insert into probe_out values ('gift_list', public.admin_get_gifts('Probe', true));
  insert into probe_out values ('gift_stock_out', public.admin_adjust_gift_stock(v_gift_a, -3, 'correction', 'too many'));
  insert into probe_out values ('gift_stock_down', public.admin_adjust_gift_stock(v_gift_a, -1, 'correction', 'one out'));
  insert into probe_out values ('gift_movements', public.admin_get_gift_stock_movements(v_gift_a, 10));
  insert into probe_out values ('gift_deactivate', public.admin_set_gift_active(v_gift_b, false));
  insert into probe_out values ('gift_reactivate', public.admin_set_gift_active(v_gift_b, true));

  -- ---------------------------------------------------------- recognition
  insert into probe_out values ('candidates', public.admin_get_recognition_candidates(5));
  insert into probe_out values ('nominate', public.admin_nominate_recognition('%(test)s', v_gift_a,
      'Three well-documented reflections in a row.', jsonb_build_array(jsonb_build_object('kind','note','note','probe evidence')),
      v_review));
  select (res->>'recognition_id')::uuid into v_rec from probe_out where step='nominate';
  insert into probe_out values ('nominate_duplicate', public.admin_nominate_recognition('%(test)s', v_gift_a, 'again'));
  insert into probe_out values ('nominate_no_reason', public.admin_nominate_recognition('%(test)s', v_gift_b, '   '));
  insert into probe_out values ('nominate_unknown_member', public.admin_nominate_recognition(gen_random_uuid(), v_gift_b, 'ghost'));
  insert into probe_out values ('decide_reject_needs_reason', public.admin_decide_recognition(v_rec, 'reject', ''));
  insert into probe_out values ('decide_approve', public.admin_decide_recognition(v_rec, 'approve', 'Well deserved.'));
  insert into probe_out values ('decide_twice', public.admin_decide_recognition(v_rec, 'approve', 'again'));
  insert into probe_out values ('advance_accept', public.admin_advance_recognition(v_rec, 'awaiting_address', jsonb_build_object('accepted', true)));
  insert into probe_out values ('advance_no_address', public.admin_advance_recognition(v_rec, 'ready_to_pack', '{}'::jsonb));
  insert into probe_out values ('advance_ready', public.admin_advance_recognition(v_rec, 'ready_to_pack', %(addr)s));
  insert into probe_out values ('advance_packed', public.admin_advance_recognition(v_rec, 'packed', jsonb_build_object('packing_note','double wrap')));
  insert into probe_out values ('advance_shipped_no_tracking', public.admin_advance_recognition(v_rec, 'shipped', '{}'::jsonb));
  insert into probe_out values ('advance_shipped', public.admin_advance_recognition(v_rec, 'shipped',
      jsonb_build_object('carrier','Australia Post','tracking_number','AP123456789','tracking_url','https://auspost.com.au/track/AP123456789')));
  insert into probe_out values ('advance_backwards', public.admin_advance_recognition(v_rec, 'packed', '{}'::jsonb));
  insert into probe_out values ('advance_delivered', public.admin_advance_recognition(v_rec, 'delivered', '{}'::jsonb));
  insert into probe_out values ('advance_completed', public.admin_advance_recognition(v_rec, 'completed', jsonb_build_object('note','closed out')));
  insert into probe_out values ('advance_after_close', public.admin_advance_recognition(v_rec, 'delivered', '{}'::jsonb));
  insert into probe_out values ('recognition_detail', public.admin_get_recognition(v_rec));
  insert into probe_out values ('movements_after_flow', public.admin_get_gift_stock_movements(v_gift_a, 20));

  -- second award, cancelled after stock was allocated -> stock must come back
  insert into probe_out values ('nominate2', public.admin_nominate_recognition('%(test)s', v_gift_b, 'Second award for the cancel path.'));
  select (res->>'recognition_id')::uuid into v_rec2 from probe_out where step='nominate2';
  insert into probe_out values ('approve2', public.admin_decide_recognition(v_rec2, 'approve', null));
  insert into probe_out values ('accept2', public.admin_advance_recognition(v_rec2, 'awaiting_address', jsonb_build_object('accepted', true)));
  insert into probe_out values ('ready2', public.admin_advance_recognition(v_rec2, 'ready_to_pack', %(addr)s));
  insert into probe_out values ('stock_after_alloc', jsonb_build_object('stock', (select stock_quantity from public.gift_catalogue where id = v_gift_b)));
  insert into probe_out values ('cancel2_no_reason', public.admin_advance_recognition(v_rec2, 'cancelled', '{}'::jsonb));
  insert into probe_out values ('cancel2', public.admin_advance_recognition(v_rec2, 'cancelled', jsonb_build_object('reason','member changed address, will re-send later')));
  insert into probe_out values ('stock_after_return', jsonb_build_object('stock', (select stock_quantity from public.gift_catalogue where id = v_gift_b)));

  -- third award, declined by the member
  insert into probe_out values ('nominate3', public.admin_nominate_recognition('%(test)s', v_gift_b, 'Third award for the decline path.'));
  select (res->>'recognition_id')::uuid into v_rec3 from probe_out where step='nominate3';
  insert into probe_out values ('approve3', public.admin_decide_recognition(v_rec3, 'approve', null));
  insert into probe_out values ('decline_wrong_stage', public.admin_advance_recognition(v_rec3, 'delivered', jsonb_build_object('reason','x')));
  insert into probe_out values ('decline3', public.admin_advance_recognition(v_rec3, 'declined', jsonb_build_object('reason','Member declined: prefers to stay anonymous.')));

  insert into probe_out values ('recognition_list', public.admin_get_recognitions(null, null, 20, 0));
  insert into probe_out values ('recognition_list_completed', public.admin_get_recognitions('completed', null, 20, 0));
  insert into probe_out values ('dashboard', public.admin_get_recognition_dashboard());

  -- ---------------------------------------------------------- support inbox
  insert into probe_out values ('import', public.admin_import_inquiries(50));
  insert into probe_out values ('import_again', public.admin_import_inquiries(50));
  -- The importer skips inquiries already linked to a ticket, so a second run legitimately
  -- imports 0. Prove the inbox holds them either way: no enquiry may be left unlinked.
  insert into probe_out values ('unlinked', (select jsonb_build_object('n', count(*))
    from public.contact_inquiries i
   where not exists (select 1 from public.support_tickets t where t.inquiry_id = i.id)));
  insert into probe_out values ('tickets', public.admin_get_tickets(null, null, null, null, 20, 0));
  insert into probe_out values ('create_ticket', public.admin_create_ticket(jsonb_build_object(
      'subject','Probe: hive lid will not close','requester_email','probe.ticket@example.com',
      'requester_name','Probe Caller','message','Called in about a stuck lid.','priority','high','category','Support')));
  select (res->>'ticket_id')::uuid into v_ticket from probe_out where step='create_ticket';
  insert into probe_out values ('create_ticket_no_subject', public.admin_create_ticket(jsonb_build_object('requester_email','a@b.com')));
  insert into probe_out values ('create_ticket_no_email', public.admin_create_ticket(jsonb_build_object('subject','x')));
  insert into probe_out values ('ticket_detail', public.admin_get_ticket(v_ticket));
  insert into probe_out values ('ticket_update', public.admin_update_ticket(jsonb_build_object(
      'id', v_ticket, 'status','open','priority','urgent','category','Fulfilment','assignee_id','%(admin)s','note','assigned to me')));
  insert into probe_out values ('ticket_bad_status', public.admin_update_ticket(jsonb_build_object('id', v_ticket, 'status','whenever')));
  insert into probe_out values ('ticket_unknown', public.admin_update_ticket(jsonb_build_object('id', gen_random_uuid(), 'status','open')));
  insert into probe_out values ('reply_internal', public.admin_reply_ticket(v_ticket, 'Internal: check the mould batch.', true, null));
  insert into probe_out values ('reply_customer', public.admin_reply_ticket(v_ticket, 'Thanks for calling -- we are sending a replacement lid.'));
  select (res->>'message_id')::uuid into v_mid from probe_out where step='reply_customer';
  insert into probe_out values ('ticket_reply_blank', public.admin_reply_ticket(v_ticket, '   '));
  insert into probe_out values ('delivery_sent', public.admin_set_message_delivery(v_mid, 'sent', 'brevo-probe-1', null));
  insert into probe_out values ('delivery_bad', public.admin_set_message_delivery(v_mid, 'teleported', null, null));
  insert into probe_out values ('ticket_after_reply', public.admin_get_ticket(v_ticket));
  insert into probe_out values ('ticket_stats', jsonb_build_object(
      'counts', (public.admin_get_tickets(null,null,null,null,1,0)->'counts'),
      'unassigned', (public.admin_get_tickets(null,null,null,null,1,0)->'unassigned'),
      'overdue', (public.admin_get_tickets(null,null,null,null,1,0)->'overdue')));

  -- merge path
  insert into probe_out values ('create_ticket_2', public.admin_create_ticket(jsonb_build_object(
      'subject','Probe: duplicate of the lid ticket','requester_email','probe.ticket@example.com','message','same thing again')));
  select (res->>'ticket_id')::uuid into v_t2 from probe_out where step='create_ticket_2';
  insert into probe_out values ('merge_self', public.admin_merge_ticket(v_ticket, v_ticket, 'nope'));
  insert into probe_out values ('merge', public.admin_merge_ticket(v_ticket, v_t2, 'same issue, same member'));
  insert into probe_out values ('ticket_after_merge', public.admin_get_ticket(v_ticket));

  insert into probe_out values ('templates', public.admin_get_support_templates());
  insert into probe_out values ('template_save', public.admin_save_support_template(jsonb_build_object(
      'name','Probe template','category','probe','body','Hi there, thanks for reaching out.')));
  select (res->'template'->>'id')::uuid into v_tpl from probe_out where step='template_save';
  insert into probe_out values ('template_update', public.admin_save_support_template(jsonb_build_object(
      'id', v_tpl, 'name','Probe template','category','probe','body','Hi there, thanks for reaching out. (edited)')));
  insert into probe_out values ('template_no_body', public.admin_save_support_template(jsonb_build_object('name','empty','body',' ')));
  insert into probe_out values ('template_delete', public.admin_delete_support_template(v_tpl));
  insert into probe_out values ('template_delete_missing', public.admin_delete_support_template(v_tpl));

  -- ---------------------------------------------------------- notifications
  insert into probe_out values ('notify_member', public.admin_send_member_notification('%(test)s',
      'About your submission', 'The Hive team looked at your reflection.', '/the-meadow.html', 'admin.message'));
  insert into probe_out values ('notify_unknown', public.admin_send_member_notification(gen_random_uuid(), 'hi'));
  insert into probe_out values ('notify_no_title', public.admin_send_member_notification('%(test)s', '   '));
  insert into probe_out values ('notifications', public.admin_get_notifications('%(test)s', 20));

  -- ---------------------------------------------------------- row counts
  insert into probe_out values ('counts', jsonb_build_object(
      'member_reviews', (select count(*) from public.member_reviews),
      'review_events', (select count(*) from public.member_review_events),
      'nectar_ledger', (select count(*) from public.nectar_ledger),
      'gifts', (select count(*) from public.gift_catalogue),
      'stock_movements', (select count(*) from public.gift_stock_movements),
      'recognitions', (select count(*) from public.recognitions),
      'recognition_events', (select count(*) from public.recognition_events),
      'evidence', (select count(*) from public.recognition_evidence),
      'tickets', (select count(*) from public.support_tickets),
      'messages', (select count(*) from public.support_messages),
      'notifications', (select count(*) from public.admin_notifications),
      'public_config_keys', (select count(*) from jsonb_object_keys(public.get_all_config())),
      'audit_rows', (select count(*) from public.admin_action_logs)));
end $do$;

select jsonb_object_agg(step, coalesce(res, 'null'::jsonb)) as out from probe_out;
rollback;
"""
ADDR_JSON = ("jsonb_build_object('recipient_name','Probe Recipient',"
             "'address_line1','1 Probe Street','address_line2','Unit 4',"
             "'suburb','Probeville','state','VIC','postcode','3000',"
             "'country','Australia','phone','0400000000','consent',true)")
FUNC_SQL = (FUNC_SQL.replace("%(admin)s", ADMIN_UID)
                   .replace("%(test)s", TEST_UID)
                   .replace("%(addr)s", ADDR_JSON))

ok, res = run(FUNC_SQL, timeout=300)
if not ok:
    check("functional block ran", False, res)
    out = {}
else:
    out = first_row(res)
    if not isinstance(out, dict):
        out = {}
    check("functional block ran", bool(out), str(res)[:400])

if out:
    def g(k):
        v = out.get(k)
        return v if isinstance(v, dict) else {}

    def txtv(k):
        v = out.get(k)
        return v if isinstance(v, str) else ""

    # -- review centre
    check("queue sync pulled real submissions", g("sync").get("success") is True and (g("sync").get("total_in_queue") or 0) >= 1, g("sync"))
    q = g("queue")
    check("queue lists rows with per-status counts", q.get("success") is True and isinstance(q.get("rows"), list) and len(q["rows"]) >= 1
          and isinstance(q.get("counts"), dict), {k: q.get(k) for k in ("success", "counts")})
    check("queue reports pending submissions (completed, not yet written)",
          isinstance(q.get("pending_submissions"), int), q.get("pending_submissions"))
    check("queue filters by status", g("queue_reviewed").get("success") is True, g("queue_reviewed"))
    it = g("item")
    check("review detail returns member, submission and history",
          it.get("success") is True and isinstance(it.get("member"), dict) and isinstance(it.get("history"), list), list(it.keys())[:8])
    check("submission body is the real DMAIC content",
          isinstance(it.get("submission"), dict) and any(it["submission"].get(k) for k in ("define", "measure", "analysis", "improve", "control")),
          str(it.get("submission"))[:200])
    check("status moves to in_review", g("status_in_review").get("success") is True, g("status_in_review"))
    check("unknown status refused", g("status_unknown").get("success") is False, g("status_unknown"))
    check("flagging without a reason refused", g("flag_no_reason").get("success") is False, g("flag_no_reason"))
    check("flagging with a reason works", g("flag_with_reason").get("success") is True, g("flag_with_reason"))
    check("assignment recorded", g("assign").get("success") is True and g("assign").get("assignee_id") == ADMIN_UID, g("assign"))
    check("assigning an unknown review refused", g("assign_unknown").get("success") is False, g("assign_unknown"))
    rep = g("reply")
    check("member reply stored with an honest delivery status",
          rep.get("success") is True and rep.get("delivery_status") in ("queued", "not_configured")
          and rep.get("notification_id") is not None, rep)
    check("blank reply refused", g("reply_blank").get("success") is False, g("reply_blank"))
    ia = g("item_after")
    check("reply and status are visible on the record afterwards",
          ia.get("success") is True and (ia.get("review") or {}).get("member_response")
          and (ia.get("review") or {}).get("status") == "flagged", str(ia.get("review"))[:200])
    check("history grew with note, status, reply and recognition events",
          len((ia.get("history") or [])) >= 4, len(ia.get("history") or []))

    # -- ledger
    na = g("nectar_add")
    check("nectar adjustment writes the balance and the ledger",
          na.get("success") is True and na.get("balance_after") == (na.get("balance_before") or 0) + 5, na)
    check("zero change refused", g("nectar_zero").get("success") is False, g("nectar_zero"))
    check("reasonless change refused", g("nectar_no_reason").get("success") is False, g("nectar_no_reason"))
    check("unknown category refused", g("nectar_bad_category").get("success") is False, g("nectar_bad_category"))
    check("overdraft refused", g("nectar_overdraft").get("success") is False, g("nectar_overdraft"))
    check("ledger list returns the entry", len((g("nectar_ledger").get("rows") or [])) >= 1
          and (g("nectar_ledger").get("rows") or [{}])[0].get("delta") == 5, g("nectar_ledger").get("total"))

    # -- settings
    check("settings list reads app_config", g("settings_list").get("success") is True
          and (g("settings_list").get("count") or 0) >= 3, g("settings_list").get("count"))
    check("setting saved", g("settings_save").get("success") is True, g("settings_save"))
    check("saved setting is readable back",
          any(r.get("key") == "probe_setting" and r.get("value") == "probe-value"
              for r in (g("settings_after").get("rows") or [])), str(g("settings_after"))[:200])
    check("setting deleted", g("settings_delete").get("success") is True, g("settings_delete"))
    check("deleting a missing setting refused", g("settings_delete_missing").get("success") is False, g("settings_delete_missing"))
    h = g("health").get("health") or {}
    # Migration 11's own property: the health read answers with a structured
    # dependency block. Assert THAT shape, not a shape some later migration
    # invented - this script's stage 0 REPLAYS the migration-11 file, which
    # redefines admin_get_integration_health and therefore restores the
    # migration-11 body. Asserting the migration 14/16 transport here would test
    # a state this script has just undone; verify_mail_live_state.py owns that
    # assertion and runs after 14/15/16 are re-applied (see run_admin_gate.sh).
    deps = ("billing", "realtime")
    check("integration health returns a structured block",
          isinstance(h, dict) and set(deps) <= set(h)
          and all(isinstance((h.get(k) or {}).get("ready"), bool) for k in deps)
          and all(bool(str((h.get(k) or {}).get("detail") or "").strip()) for k in deps)
          and isinstance(h.get("tables"), dict) and len(h.get("tables")) >= 5,
          str(h)[:300])
    cfg = (g("public_config").get("cfg") or {})
    check("get_all_config returns usable keys and no secrets",
          "site_url" in cfg and not any(k for k in cfg if any(s in k.lower() for s in ("secret", "token", "passw", "smtp"))),
          str(list(cfg.keys()))[:200])

    # -- gifts
    ga, gb = g("gift_a"), g("gift_b")
    check("gift created with stock", ga.get("success") is True and (ga.get("gift") or {}).get("stock_quantity") == 2, ga)
    check("second gift created", gb.get("success") is True, gb)
    check("nameless gift refused", g("gift_no_name").get("success") is False, g("gift_no_name"))
    check("negative stock refused", g("gift_negative_stock").get("success") is False, g("gift_negative_stock"))
    check("catalogue search finds it", any(r.get("sku") == "PROBE-A" for r in (g("gift_list").get("rows") or [])), g("gift_list").get("rows"))
    check("stock below zero refused", g("gift_stock_out").get("success") is False, g("gift_stock_out"))
    check("stock decremented", g("gift_stock_down").get("success") is True and g("gift_stock_down").get("stock_quantity") == 1, g("gift_stock_down"))
    mv = g("movements_after_flow").get("rows") or []
    kinds = {m.get("kind") for m in mv}
    check("stock movements explain the number",
          {"initial", "correction", "allocation"} <= kinds, mv)
    check("gift can be deactivated and reactivated",
          g("gift_deactivate").get("success") is True and g("gift_deactivate").get("is_active") is False
          and g("gift_reactivate").get("is_active") is True, g("gift_deactivate"))

    # -- recognition lifecycle
    check("candidate list built from real activity", g("candidates").get("success") is True
          and isinstance(g("candidates").get("rows"), list), g("candidates").get("rows"))
    nom = g("nominate")
    check("nomination created", nom.get("success") is True and nom.get("status") == "nominated", nom)
    check("duplicate live award refused", g("nominate_duplicate").get("success") is False, g("nominate_duplicate"))
    check("reasonless nomination refused", g("nominate_no_reason").get("success") is False, g("nominate_no_reason"))
    check("unknown member refused", g("nominate_unknown_member").get("success") is False, g("nominate_unknown_member"))
    check("rejection without a reason refused", g("decide_reject_needs_reason").get("success") is False, g("decide_reject_needs_reason"))
    app = g("decide_approve")
    check("approval notifies the member and records delivery honestly",
          app.get("success") is True and app.get("status") == "awaiting_acceptance"
          and app.get("delivery_status") in ("queued", "not_configured"), app)
    check("a decided nomination cannot be decided again", g("decide_twice").get("success") is False, g("decide_twice"))
    check("member acceptance recorded", g("advance_accept").get("success") is True, g("advance_accept"))
    check("packing without an address refused", g("advance_no_address").get("success") is False, g("advance_no_address"))
    check("address + consent accepted", g("advance_ready").get("success") is True, g("advance_ready"))
    check("packed", g("advance_packed").get("success") is True, g("advance_packed"))
    check("shipping without tracking refused", g("advance_shipped_no_tracking").get("success") is False, g("advance_shipped_no_tracking"))
    check("shipped with carrier + tracking", g("advance_shipped").get("success") is True, g("advance_shipped"))
    check("backwards transition refused", g("advance_backwards").get("success") is False, g("advance_backwards"))
    check("delivered", g("advance_delivered").get("success") is True, g("advance_delivered"))
    check("completed", g("advance_completed").get("success") is True, g("advance_completed"))
    check("a closed award cannot move again", g("advance_after_close").get("success") is False, g("advance_after_close"))
    det = g("recognition_detail")
    check("award detail carries member, gift, evidence, events and stock",
          det.get("success") is True and isinstance(det.get("member"), dict) and isinstance(det.get("gift"), dict)
          and len(det.get("events") or []) >= 6 and len(det.get("evidence") or []) >= 1, list(det.keys())[:9])
    check("cancel without a reason refused", g("cancel2_no_reason").get("success") is False, g("cancel2_no_reason"))
    check("stock allocated when packing started", (g("stock_after_alloc").get("stock") == 0), g("stock_after_alloc"))
    c2 = g("cancel2")
    check("cancelling returns the allocated stock",
          c2.get("success") is True and c2.get("stock_returned") is True
          and g("stock_after_return").get("stock") == 1, (c2, g("stock_after_return")))
    check("later steps refused after a decline path starts", g("decline_wrong_stage").get("success") is False, g("decline_wrong_stage"))
    check("member decline recorded", g("decline3").get("success") is True and g("decline3").get("status") == "declined", g("decline3"))
    rl = g("recognition_list")
    check("awards list carries counts for all thirteen statuses",
          rl.get("success") is True and len((rl.get("counts") or {})) == 14, rl.get("counts"))
    check("awards filter by status", g("recognition_list_completed").get("success") is True
          and (g("recognition_list_completed").get("counts") or {}).get("completed") == 1, g("recognition_list_completed").get("counts"))
    dash = g("dashboard")
    sp = dash.get("spend") or {}
    check("dashboard reports pipeline, spend and low stock",
          dash.get("success") is True and (dash.get("counts") or {}).get("total") == 3
          and (dash.get("counts") or {}).get("completed") == 1
          and (dash.get("counts") or {}).get("closed_unsent") == 2
          and sp.get("awarded_count") == 1 and sp.get("delivered") == 12.5
          and any(gg.get("sku") == "PROBE-B" for gg in (dash.get("low_stock") or [])),
          {k: dash.get(k) for k in ("counts", "spend")})

    # -- support
    imp = g("import")
    unlinked = g("unlinked")
    check("contact enquiries imported into the inbox",
          imp.get("success") is True
          and ((imp.get("imported") or 0) >= 1 or (unlinked or {}).get("n") == 0),
          {"import": imp, "unlinked": unlinked})
    check("re-importing imports nothing twice", (g("import_again").get("imported") or 0) == 0, g("import_again"))
    tl = g("tickets")
    check("ticket list returns rows with counts, unassigned and overdue",
          tl.get("success") is True and len((tl.get("rows") or [])) >= 6 and isinstance(tl.get("counts"), dict)
          and isinstance(tl.get("unassigned"), int) and isinstance(tl.get("overdue"), int), list((tl.get("counts") or {}).items()))
    ct = g("create_ticket")
    check("ticket created with a ticket number", ct.get("success") is True and ct.get("ticket_no") is not None, ct)
    check("ticket without a subject refused", g("create_ticket_no_subject").get("success") is False, g("create_ticket_no_subject"))
    check("ticket without an email refused", g("create_ticket_no_email").get("success") is False, g("create_ticket_no_email"))
    td = g("ticket_detail")
    check("ticket detail returns the thread and the member's other tickets",
          td.get("success") is True and len(td.get("messages") or []) >= 1 and isinstance(td.get("member_history"), list), list(td.keys())[:7])
    tu = g("ticket_update")
    check("ticket assignment + priority set an SLA due time",
          tu.get("success") is True and tu.get("assignee_id") == ADMIN_UID and tu.get("sla_due_at"), tu)
    check("unknown ticket status refused", g("ticket_bad_status").get("success") is False, g("ticket_bad_status"))
    check("updating an unknown ticket refused", g("ticket_unknown").get("success") is False, g("ticket_unknown"))
    check("internal note stored as a note, not a send",
          g("reply_internal").get("success") is True and g("reply_internal").get("email_status") == "not_attempted", g("reply_internal"))
    rc = g("reply_customer")
    check("customer reply stored with an honest delivery status",
          rc.get("success") is True and rc.get("email_status") in ("queued", "not_configured")
          and rc.get("delivered") is False, rc)
    check("blank reply refused", g("ticket_reply_blank").get("success") is False, g("ticket_reply_blank"))
    check("delivery state can be updated by a worker", g("delivery_sent").get("success") is True
          and g("delivery_sent").get("email_status") == "sent", g("delivery_sent"))
    check("unknown delivery status refused", g("delivery_bad").get("success") is False, g("delivery_bad"))
    tar = g("ticket_after_reply")
    msgs = tar.get("messages") or []
    check("thread shows outbound, note and sent state",
          len(msgs) == 3 and any(m.get("direction") == "note" for m in msgs)
          and any(m.get("email_status") == "sent" for m in msgs), msgs)
    check("ticket is pending customer after a reply",
          (tar.get("ticket") or {}).get("status") == "pending_customer", (tar.get("ticket") or {}).get("status"))
    check("merging a ticket into itself refused", g("merge_self").get("success") is False, g("merge_self"))
    mg = g("merge")
    check("merge moves the messages and closes the duplicate",
          mg.get("success") is True and (mg.get("moved_messages") or 0) >= 1, mg)
    check("support counts feed the dashboard",
          isinstance(g("ticket_stats").get("counts"), dict), g("ticket_stats"))
    check("templates listed", len((g("templates").get("rows") or [])) >= 1, g("templates"))
    check("template created and edited", g("template_save").get("success") is True
          and "edited" in ((g("template_update").get("template") or {}).get("body") or ""), g("template_update"))
    check("template without a body refused", g("template_no_body").get("success") is False, g("template_no_body"))
    check("template deleted", g("template_delete").get("success") is True and g("template_delete_missing").get("success") is False,
          (g("template_delete"), g("template_delete_missing")))

    # -- notifications
    nm = g("notify_member")
    check("member notification queued with honest delivery",
          nm.get("success") is True and nm.get("delivery_status") in ("queued", "not_configured"), nm)
    check("notifying an unknown member refused", g("notify_unknown").get("success") is False, g("notify_unknown"))
    check("untitled notification refused", g("notify_no_title").get("success") is False, g("notify_no_title"))
    check("notification feed lists the queued rows", len((g("notifications").get("rows") or [])) >= 1, g("notifications"))

    # -- what actually landed in the tables
    c = g("counts")
    check("submissions became review rows", (c.get("member_reviews") or 0) >= 12, c.get("member_reviews"))
    check("review history rows written", (c.get("review_events") or 0) >= 4, c.get("review_events"))
    check("ledger rows written", (c.get("nectar_ledger") or 0) >= 1, c.get("nectar_ledger"))
    check("stock movements written", (c.get("stock_movements") or 0) >= 3, c.get("stock_movements"))
    check("three awards recorded with events and evidence",
          (c.get("recognitions") or 0) == 3 and (c.get("recognition_events") or 0) >= 12
          and (c.get("evidence") or 0) >= 1, c)
    check("seven real tickets with threads",
          (c.get("tickets") or 0) >= 7 and (c.get("messages") or 0) >= 4, c)
    check("notifications written for reply, approval and admin message",
          (c.get("notifications") or 0) >= 3, c.get("notifications"))
    check("admin actions were audited end to end", (c.get("audit_rows") or 0) >= 10, c.get("audit_rows"))
    check("get_all_config returns the public keys", (c.get("public_config_keys") or 0) >= 2, c.get("public_config_keys"))

print("== stage C: permission boundaries on the new surface ==")
for role, sql in (
    ("fulfilment_manager", "select jsonb_build_object('advance', public.admin_can('fulfilment.manage'), 'settings', public.admin_can('settings.write'), 'recognition', public.admin_can('recognition.approve'))"),
    ("support_agent", "select jsonb_build_object('reply', public.admin_can('support.reply'), 'manage', public.admin_can('support.manage'))"),
    ("member_reviewer", "select jsonb_build_object('review', public.admin_can('review.decide'), 'nectar', public.admin_can('nectar.adjust'))"),
):
    ok, res = run("begin; insert into public.admin_team_members (user_id, role_key) values ('%s','%s') "
                  "on conflict (user_id) do update set role_key = '%s'; %s %s; rollback;"
                  % (TEST_UID, role, role, claims(TEST_UID), sql))
    d = first_row(res) if ok else {}
    if role == "fulfilment_manager":
        check("fulfilment manager can run fulfilment but not change settings",
              d.get("advance") is True and d.get("settings") is False and d.get("recognition") is True, d)
    if role == "support_agent":
        check("support agent can reply but cannot administer the inbox",
              d.get("reply") is True and d.get("manage") is False, d)
    if role == "member_reviewer":
        check("member reviewer can decide reviews but cannot touch nectar",
              d.get("review") is True and d.get("nectar") is False, d)

ok, res = run("begin; set local role authenticated; %s select public.admin_get_review_queue(); rollback;" % claims(TEST_UID))
check("a member who is not an admin cannot read the review queue",
      (not ok) and ("42501" in str(res) or "Forbidden" in str(res) or "permission" in str(res).lower()), str(res)[:200])

ok, res = run("begin; set local role authenticated; %s select public.admin_get_tickets(); rollback;" % claims(TEST_UID))
check("a member who is not an admin cannot read the support inbox",
      (not ok) and ("42501" in str(res) or "Forbidden" in str(res) or "permission" in str(res).lower()), str(res)[:200])

ok, res = run("begin; set local role authenticated; %s select public.admin_advance_recognition(gen_random_uuid(),'packed'); rollback;" % claims(TEST_UID))
check("a member who is not an admin cannot move a gift award",
      (not ok) and ("42501" in str(res) or "Forbidden" in str(res) or "permission" in str(res).lower()), str(res)[:200])

ok, res = run("begin; set local role anon; select public.admin_get_tickets(); rollback;")
check("anon cannot even reach the inbox function", (not ok) and ("permission denied" in str(res).lower() or "42501" in str(res)), str(res)[:200])

ok, res = run("begin; set local role anon; select public.admin_role_of('::".replace("::", "") + ADMIN_UID + "'::uuid); rollback;")
check("anon cannot probe who is an admin", (not ok) and ("permission denied" in str(res).lower() or "42501" in str(res)), str(res)[:200])

ok, res = run("begin; set local role anon; select public.admin_can('team.manage', '%s'::uuid); rollback;" % ADMIN_UID)
check("anon cannot probe what a role may do", (not ok) and ("permission denied" in str(res).lower() or "42501" in str(res)), str(res)[:200])

for table in ("member_reviews", "nectar_ledger", "recognitions", "support_tickets", "support_messages",
              "admin_notifications", "gift_catalogue", "recognition_evidence"):
    ok, res = run("begin; set local role anon; select count(*) as c from public.%s; rollback;" % table)
    c = None
    if ok and isinstance(res, list) and res:
        row = res[0]
        c = row.get("c") if isinstance(row, dict) else None
    check(f"anon reads zero rows from {table}", (not ok) or c == 0, str(res)[:160])

ok, res = run("begin; set local role authenticated; %s select count(*) as c from public.support_tickets; rollback;" % claims(TEST_UID))
c = res[0].get("c") if ok and isinstance(res, list) and res and isinstance(res[0], dict) else None
check("a signed-in member reads zero rows from the inbox tables", (not ok) or c == 0, str(res)[:160])

ok, res = run("select jsonb_build_object('keys', (select count(*) from jsonb_object_keys(public.get_all_config()))) as r")
check("get_all_config still answers for the public site", ok and first_row(res).get("keys") is not None, res)

print("== stage D: no residue -- the run rolled itself back ==")
ok, res = run("""select jsonb_build_object(
  'member_reviews',(select count(*) from public.member_reviews),
  'recognitions',(select count(*) from public.recognitions),
  'support_tickets',(select count(*) from public.support_tickets),
  'notifications',(select count(*) from public.admin_notifications),
  'nectar_ledger',(select count(*) from public.nectar_ledger),
  'gifts',(select count(*) from public.gift_catalogue)) as r""")
AFTER = first_row(res) if ok else {}
check("live row counts unchanged by the verification run", BEFORE == AFTER, f"before={BEFORE} after={AFTER}")
check("catalogue still holds only the seeded items", (AFTER.get("gifts") or 0) == 3, AFTER.get("gifts"))
check("no probe member left behind", run("select count(*) as c from public.admin_team_members where user_id='%s' and role_key <> 'analyst'" % TEST_UID)[1]
      in ([{"c": 0}], [[{"c": 0}]]), "")

print(f"\nRESULT  {PASS} PASS / {FAIL} FAIL")
print("\nNOTICE  stage 0 replayed migration 11, which redefines four functions the")
print("        mail work replaced. The live mail paths and the integration-health")
print("        block are therefore back to the migration-11 bodies. Re-apply the")
print("        mail migrations before using the CRM:")
print("          /usr/bin/python3 information/admin-crm/verification/reapply_mail_migrations.py")
print("        The gate (run_admin_gate.sh) does this automatically and then runs")
print("        probe_mail_paths.py + verify_mail_live_state.py, which fail loudly")
print("        if the reset is left in place.")
sys.exit(1 if FAIL else 0)
