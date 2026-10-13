-- ============================================================================
-- 11 — CRM CORE MODULES, Part 4/4: Support Inbox, notifications,
--                    permission catalogue sync, grants, RLS
-- ============================================================================
begin;

-- ============================================================================
-- SUPPORT INBOX
-- ============================================================================

-- Contact-form enquiries already sit in contact_inquiries. This turns each one
-- into a real ticket with a conversation thread, once. Re-running is safe.
create or replace function public.admin_import_inquiries(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_made int := 0;
  v_inq record;
  v_ticket uuid;
begin
  perform public.assert_admin_can('support.manage');

  for v_inq in
    select i.* from public.contact_inquiries i
     where not exists (select 1 from public.support_tickets t where t.inquiry_id = i.id)
     order by i.created_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    insert into public.support_tickets (subject, requester_id, requester_email, requester_name,
                                        source, inquiry_id, status, priority, category, created_at)
    values (left(coalesce(nullif(v_inq.category, ''), 'Enquiry') || ' — ' ||
                 coalesce(nullif(v_inq.user_name, ''), nullif(v_inq.user_email, ''), 'Member'), 160),
            -- contact_inquiries can point at a profile that has since been
            -- deleted; keep the ticket, drop the dangling member link.
            (select p.id from public.profiles p where p.id = v_inq.user_id),
            v_inq.user_email, v_inq.user_name,
            'contact_form', v_inq.id, 'new', 'normal', v_inq.category, v_inq.created_at)
    returning id into v_ticket;

    insert into public.support_messages (ticket_id, direction, author_email, author_name, body, created_at)
    values (v_ticket, 'inbound', v_inq.user_email, v_inq.user_name, coalesce(v_inq.message, '(no message)'), v_inq.created_at);

    v_made := v_made + 1;
  end loop;

  perform public.log_admin_action('support.import_inquiries', 'support_ticket', null, null,
      jsonb_build_object('imported', v_made), null);

  return jsonb_build_object('success', true, 'imported', v_made);
end;
$$;

create or replace function public.admin_get_tickets(
  p_status text default null,
  p_priority text default null,
  p_assignee uuid default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_counts jsonb;
  v_unassigned int;
  v_overdue int;
begin
  perform public.assert_admin_can('support.read');

  select coalesce(jsonb_agg(x order by x->>'last_activity' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', t.id, 'ticket_no', t.ticket_no, 'subject', t.subject,
               'status', t.status, 'priority', t.priority, 'category', t.category,
               'source', t.source,
               'requester_email', t.requester_email, 'requester_name', t.requester_name,
               'member_id', t.requester_id,
               'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
               'assignee_id', t.assignee_id,
               'assignee_name', trim(both ' ' from concat_ws(' ', a.first_name, a.last_name)),
               'messages', (select count(*) from public.support_messages m where m.ticket_id = t.id),
               'last_message', (select left(m.body, 140) from public.support_messages m
                                 where m.ticket_id = t.id order by m.created_at desc limit 1),
               'last_activity', coalesce(t.last_customer_reply_at, t.updated_at),
               'sla_due_at', t.sla_due_at,
               'overdue', t.sla_due_at is not null and t.sla_due_at < now()
                          and t.status not in ('resolved','closed'),
               'first_response_at', t.first_response_at,
               'created_at', t.created_at, 'updated_at', t.updated_at,
               'merged_into', t.merged_into) as x
        from public.support_tickets t
        left join public.profiles p on p.id = t.requester_id
        left join public.profiles a on a.id = t.assignee_id
       where (p_status is null or t.status = p_status)
         and (p_priority is null or t.priority = p_priority)
         and (p_assignee is null or t.assignee_id = p_assignee)
         and (coalesce(p_search,'') = '' or t.subject ilike '%'||p_search||'%'
              or t.requester_email ilike '%'||p_search||'%'
              or t.requester_name ilike '%'||p_search||'%')
       order by coalesce(t.last_customer_reply_at, t.updated_at) desc
       limit greatest(1, least(coalesce(p_limit,50), 200))
      offset greatest(0, coalesce(p_offset,0))
    ) t2;

  select jsonb_build_object(
           'new', count(*) filter (where status = 'new' and merged_into is null),
           'open', count(*) filter (where status = 'open' and merged_into is null),
           'pending_customer', count(*) filter (where status = 'pending_customer' and merged_into is null),
           'pending_internal', count(*) filter (where status = 'pending_internal' and merged_into is null),
           'resolved', count(*) filter (where status = 'resolved' and merged_into is null),
           'closed', count(*) filter (where status = 'closed' and merged_into is null),
           'total', count(*) filter (where merged_into is null))
    into v_counts
    from public.support_tickets;

  select count(*) into v_unassigned from public.support_tickets
   where assignee_id is null and merged_into is null and status not in ('resolved','closed');
  select count(*) into v_overdue from public.support_tickets
   where sla_due_at is not null and sla_due_at < now() and status not in ('resolved','closed') and merged_into is null;

  return jsonb_build_object('success', true, 'rows', v_rows, 'counts', v_counts,
                            'unassigned', coalesce(v_unassigned,0), 'overdue', coalesce(v_overdue,0));
end;
$$;

create or replace function public.admin_get_ticket(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.support_tickets;
begin
  perform public.assert_admin_can('support.read');

  select * into v_t from public.support_tickets where id = p_id;
  if v_t.id is null then
    return jsonb_build_object('success', false, 'error', 'Ticket not found');
  end if;

  return jsonb_build_object(
    'success', true,
    'ticket', to_jsonb(v_t),
    'member', (select jsonb_build_object('id', p.id,
                 'name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
                 'username', p.username, 'email', p.email, 'member_tier', p.member_tier,
                 'nectar_points', p.nectar_points, 'member_status', p.member_status,
                 'created_at', p.join_date)
               from public.profiles p where p.id = v_t.requester_id),
    'assignee_name', (select trim(both ' ' from concat_ws(' ', p.first_name, p.last_name))
                        from public.profiles p where p.id = v_t.assignee_id),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', m.id, 'direction', m.direction, 'body', m.body,
                   'author_email', m.author_email, 'author_name', m.author_name,
                   'email_status', m.email_status, 'email_error', m.email_error,
                   'attempts', m.attempts, 'sent_at', m.sent_at, 'created_at', m.created_at)
                   order by m.created_at)
                 from public.support_messages m where m.ticket_id = p_id), '[]'::jsonb),
    'member_history', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', t.id, 'ticket_no', t.ticket_no, 'subject', t.subject,
                        'status', t.status, 'created_at', t.created_at) order by t.created_at desc)
                      from public.support_tickets t
                      where t.requester_id = v_t.requester_id and t.id <> p_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_create_ticket(p_ticket jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.support_tickets;
  v_email text := lower(nullif(trim(p_ticket->>'requester_email'), ''));
  v_member public.profiles;
  v_name text := nullif(trim(p_ticket->>'requester_name'), '');
begin
  perform public.assert_admin_can('support.manage');

  if coalesce(trim(p_ticket->>'subject'), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A subject is required');
  end if;
  if coalesce(v_email, '') = '' then
    return jsonb_build_object('success', false, 'error', 'A requester email is required');
  end if;

  select * into v_member from public.profiles where lower(email) = v_email limit 1;

  insert into public.support_tickets (subject, requester_id, requester_email, requester_name, source, status, priority, category)
  values (trim(p_ticket->>'subject'), v_member.id, v_email,
          coalesce(v_name, trim(both ' ' from concat_ws(' ', v_member.first_name, v_member.last_name)), v_email),
          coalesce(nullif(p_ticket->>'source',''), 'crm'),
          coalesce(nullif(p_ticket->>'status',''), 'new'),
          coalesce(nullif(p_ticket->>'priority',''), 'normal'),
          nullif(p_ticket->>'category',''))
  returning * into v_t;

  if coalesce(trim(p_ticket->>'message'), '') <> '' then
    insert into public.support_messages (ticket_id, direction, author_email, author_name, body)
    values (v_t.id, 'inbound', v_email, v_t.requester_name, p_ticket->>'message');
  end if;

  perform public.log_admin_action('support.create', 'support_ticket', v_t.id::text, null,
      jsonb_build_object('subject', v_t.subject, 'requester', v_email), null);

  return jsonb_build_object('success', true, 'ticket_id', v_t.id, 'ticket_no', v_t.ticket_no,
                            'member_linked', v_member.id is not null);
end;
$$;

create or replace function public.admin_update_ticket(p_ticket jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_ticket->>'id','')::uuid;
  v_before public.support_tickets;
  v_after public.support_tickets;
  v_assignee uuid := nullif(p_ticket->>'assignee_id','')::uuid;
  v_sla int;
begin
  perform public.assert_admin_can('support.manage');

  select * into v_before from public.support_tickets where id = v_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Ticket not found');
  end if;

  if nullif(p_ticket->>'status','') is not null
     and (p_ticket->>'status') not in ('new','open','pending_customer','pending_internal','resolved','closed') then
    return jsonb_build_object('success', false, 'error', 'Unknown ticket status');
  end if;

  -- First response target depends on priority, so the SLA clock is set the
  -- moment a ticket is answered or a priority is chosen.
  v_sla := case coalesce(nullif(p_ticket->>'priority',''), v_before.priority)
             when 'urgent' then 4 when 'high' then 8 when 'normal' then 24 else 48 end;

  update public.support_tickets
     set status = coalesce(nullif(p_ticket->>'status',''), status),
         priority = coalesce(nullif(p_ticket->>'priority',''), priority),
         category = coalesce(nullif(p_ticket->>'category',''), category),
         assignee_id = coalesce(v_assignee, assignee_id),
         resolved_at = case when coalesce(nullif(p_ticket->>'status',''), status) = 'resolved'
                            then coalesce(resolved_at, now()) else resolved_at end,
         closed_at = case when coalesce(nullif(p_ticket->>'status',''), status) = 'closed'
                          then coalesce(closed_at, now()) else closed_at end,
         sla_due_at = case when first_response_at is null then coalesce(sla_due_at, created_at + make_interval(hours => v_sla))
                           else sla_due_at end
   where id = v_id
  returning * into v_after;

  perform public.log_admin_action('support.update', 'support_ticket', v_id::text,
      jsonb_build_object('status', v_before.status, 'priority', v_before.priority, 'assignee_id', v_before.assignee_id),
      jsonb_build_object('status', v_after.status, 'priority', v_after.priority, 'assignee_id', v_after.assignee_id),
      nullif(p_ticket->>'note',''));

  return jsonb_build_object('success', true, 'status', v_after.status, 'priority', v_after.priority,
                            'assignee_id', v_after.assignee_id, 'sla_due_at', v_after.sla_due_at);
end;
$$;

-- Reply or internal note. The reply is only recorded as delivered when a mail
-- transport actually exists; otherwise it is stored on the thread and the row
-- says so, so nobody believes a member was emailed when they were not.
create or replace function public.admin_reply_ticket(
  p_ticket_id uuid,
  p_body text,
  p_internal boolean default false,
  p_template_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.support_tickets;
  v_mail boolean;
  v_status text;
  v_msg public.support_messages;
begin
  perform public.assert_admin_can(case when p_internal then 'support.read' else 'support.reply' end);

  if coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A message body is required');
  end if;

  select * into v_t from public.support_tickets where id = p_ticket_id;
  if v_t.id is null then
    return jsonb_build_object('success', false, 'error', 'Ticket not found');
  end if;

  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('send_email','queue_email')) into v_mail;
  v_status := case when p_internal then 'not_attempted'
                   when v_mail then 'queued' else 'not_configured' end;

  insert into public.support_messages (ticket_id, direction, author_id, author_email, author_name,
                                       body, template_id, email_status, email_error, attempts, sent_at)
  values (p_ticket_id,
          case when p_internal then 'note' else 'outbound' end,
          auth.uid(), public.admin_actor_email(),
          (select trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)) from public.profiles p where p.id = auth.uid()),
          p_body, p_template_id, v_status,
          case when p_internal then null
               when v_mail then null
               else 'No mail transport is configured in this project, so the reply was saved to the thread but not emailed.' end,
          case when p_internal then 0 else 1 end,
          null)
  returning * into v_msg;

  if not p_internal then
    update public.support_tickets
       set status = 'pending_customer',
           first_response_at = coalesce(first_response_at, now())
     where id = p_ticket_id;
  end if;

  perform public.log_admin_action(case when p_internal then 'support.note' else 'support.reply' end,
      'support_ticket', p_ticket_id::text, null,
      jsonb_build_object('message_id', v_msg.id, 'email_status', v_status), null);

  return jsonb_build_object('success', true, 'message_id', v_msg.id, 'email_status', v_status,
                            'delivered', v_status = 'sent');
end;
$$;

create or replace function public.admin_set_message_delivery(
  p_message_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.support_messages;
begin
  -- Only a delivery worker (or an admin) may change delivery state.
  perform public.assert_admin_can('support.manage');

  if p_status not in ('not_attempted','not_configured','queued','sent','failed') then
    return jsonb_build_object('success', false, 'error', 'Unknown delivery status');
  end if;

  update public.support_messages
     set email_status = p_status,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         email_error = p_error,
         sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end,
         attempts = attempts + 1
   where id = p_message_id
  returning * into v_msg;

  if v_msg.id is null then
    return jsonb_build_object('success', false, 'error', 'Message not found');
  end if;

  return jsonb_build_object('success', true, 'email_status', v_msg.email_status, 'attempts', v_msg.attempts);
end;
$$;

create or replace function public.admin_merge_ticket(p_target uuid, p_source uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.support_tickets;
  v_s public.support_tickets;
  v_moved int;
begin
  perform public.assert_admin_can('support.manage');

  if p_target = p_source then
    return jsonb_build_object('success', false, 'error', 'Cannot merge a ticket into itself');
  end if;

  select * into v_t from public.support_tickets where id = p_target;
  select * into v_s from public.support_tickets where id = p_source;
  if v_t.id is null or v_s.id is null then
    return jsonb_build_object('success', false, 'error', 'Ticket not found');
  end if;

  update public.support_messages set ticket_id = p_target where ticket_id = p_source;
  get diagnostics v_moved = row_count;

  insert into public.support_messages (ticket_id, direction, author_id, author_email, body)
  values (p_target, 'note', auth.uid(), public.admin_actor_email(),
          format('Merged ticket #%s (%s)%s', v_s.ticket_no, v_s.subject,
                 case when coalesce(trim(p_reason),'') <> '' then ': ' || p_reason else '' end));

  update public.support_tickets
     set merged_into = p_target, status = 'closed', closed_at = now()
   where id = p_source;

  perform public.log_admin_action('support.merge', 'support_ticket', p_target::text,
      jsonb_build_object('source', p_source), jsonb_build_object('moved_messages', v_moved), p_reason);

  return jsonb_build_object('success', true, 'moved_messages', v_moved);
end;
$$;

create or replace function public.admin_get_support_templates()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('support.read');
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category,
           'body', t.body, 'is_active', t.is_active, 'updated_at', t.updated_at) order by t.name), '[]'::jsonb)
    into v_rows
    from public.support_templates t;
  return jsonb_build_object('success', true, 'rows', v_rows);
end;
$$;

create or replace function public.admin_save_support_template(p_template jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_template->>'id','')::uuid;
  v_after public.support_templates;
begin
  perform public.assert_admin_can('support.manage');

  if coalesce(trim(p_template->>'name'), '') = '' or coalesce(trim(p_template->>'body'), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A template name and body are required');
  end if;

  if v_id is null then
    insert into public.support_templates (name, category, body, is_active)
    values (trim(p_template->>'name'), nullif(p_template->>'category',''), p_template->>'body',
            coalesce((p_template->>'is_active')::boolean, true))
    returning * into v_after;
  else
    update public.support_templates
       set name = trim(p_template->>'name'),
           category = nullif(p_template->>'category',''),
           body = p_template->>'body',
           is_active = coalesce((p_template->>'is_active')::boolean, is_active)
     where id = v_id
    returning * into v_after;
    if v_after.id is null then
      return jsonb_build_object('success', false, 'error', 'Template not found');
    end if;
  end if;

  perform public.log_admin_action('support.template_save', 'support_template', v_after.id::text, null,
      jsonb_build_object('name', v_after.name), null);
  return jsonb_build_object('success', true, 'template', to_jsonb(v_after));
end;
$$;

create or replace function public.admin_delete_support_template(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_can('support.manage');
  delete from public.support_templates where id = p_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Template not found');
  end if;
  perform public.log_admin_action('support.template_delete', 'support_template', p_id::text, null, null, null);
  return jsonb_build_object('success', true);
end;
$$;

-- ============================================================================
-- NOTIFICATIONS (admin view of the member outbox)
-- ============================================================================
create or replace function public.admin_get_notifications(p_user_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('member.read');

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', n.id, 'member_id', n.user_id,
               'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
               'member_email', p.email, 'kind', n.kind, 'title', n.title, 'body', n.body,
               'channel', n.channel, 'delivery_status', n.delivery_status,
               'delivery_error', n.delivery_error, 'attempts', n.attempts,
               'read_at', n.read_at, 'created_at', n.created_at, 'related_type', n.related_type,
               'related_id', n.related_id) as x
        from public.admin_notifications n
        left join public.profiles p on p.id = n.user_id
       where p_user_id is null or n.user_id = p_user_id
       order by n.created_at desc
       limit greatest(1, least(coalesce(p_limit,100), 500))
    ) t;

  return jsonb_build_object('success', true, 'rows', v_rows);
end;
$$;

create or replace function public.admin_send_member_notification(
  p_user_id uuid,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_kind text default 'admin.message'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mail boolean;
  v_status text;
  v_id bigint;
begin
  perform public.assert_admin_can('member.write');

  if coalesce(trim(p_title), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A title is required');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('success', false, 'error', 'Member not found');
  end if;

  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('send_email','queue_email')) into v_mail;
  v_status := case when v_mail then 'queued' else 'not_configured' end;

  insert into public.admin_notifications (user_id, kind, title, body, link, channel, delivery_status,
                                          delivery_error, attempts, created_by)
  values (p_user_id, coalesce(nullif(p_kind,''),'admin.message'), p_title, p_body, p_link, 'in_app',
          v_status,
          case when v_mail then null else 'No mail transport is configured, so this stays in-app only.' end,
          0, auth.uid())
  returning id into v_id;

  perform public.log_admin_action('member.notify', 'member', p_user_id::text, null,
      jsonb_build_object('notification_id', v_id, 'delivery', v_status), p_title);

  return jsonb_build_object('success', true, 'notification_id', v_id, 'delivery_status', v_status);
end;
$$;

-- ============================================================================
-- PERMISSION CATALOGUE SYNC
-- ============================================================================
-- New permissions introduced by this migration are appended to the roles that
-- need them. Idempotent (array append of missing keys only).
do $$
declare
  v_map jsonb := '{
    "recognition.read":   ["administrator","fulfilment_manager","member_reviewer","support_agent","analyst"],
    "recognition.manage": ["administrator","fulfilment_manager"],
    "settings.read":      ["administrator","analyst"],
    "review.read":        ["administrator","member_reviewer"],
    "support.template":   ["administrator","support_agent"]
  }'::jsonb;
  v_key text;
  v_roles text[];
begin
  for v_key, v_roles in select key, array(select jsonb_array_elements_text(value)) from jsonb_each(v_map) loop
    update public.admin_roles
       set permissions = (select array(select distinct unnest(permissions || array[v_key])))
     where role_key = any(v_roles)
       and not (v_key = any(permissions));
  end loop;
end $$;

-- ============================================================================
-- GRANTS + RLS
-- ============================================================================
alter table public.member_reviews         enable row level security;
alter table public.member_review_events   enable row level security;
alter table public.nectar_ledger          enable row level security;
alter table public.gift_catalogue         enable row level security;
alter table public.gift_stock_movements   enable row level security;
alter table public.recognitions           enable row level security;
alter table public.recognition_evidence   enable row level security;
alter table public.recognition_events     enable row level security;
alter table public.support_tickets        enable row level security;
alter table public.support_messages       enable row level security;
alter table public.support_templates      enable row level security;
alter table public.admin_notifications    enable row level security;

-- These tables carry personal data and are reachable only through the
-- SECURITY DEFINER functions above. No client role gets direct table access.
revoke all on public.member_reviews, public.member_review_events, public.nectar_ledger,
              public.gift_catalogue, public.gift_stock_movements, public.recognitions,
              public.recognition_evidence, public.recognition_events, public.support_tickets,
              public.support_messages, public.support_templates, public.admin_notifications
  from anon, authenticated;

-- Function-by-function privileges: the new CRM functions are callable by a
-- signed-in session only, and every one of them re-checks the caller's role.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'admin_sync_review_queue','admin_get_review_queue','admin_get_review_item',
         'admin_assign_review','admin_set_review_status','admin_reply_to_member',
         'admin_adjust_nectar','admin_get_nectar_ledger','admin_get_settings',
         'admin_save_setting','admin_delete_setting','admin_get_integration_health',
         'admin_get_gifts','admin_save_gift','admin_set_gift_active','admin_adjust_gift_stock',
         'admin_get_gift_stock_movements','admin_get_recognition_candidates',
         'admin_get_recognitions','admin_get_recognition','admin_nominate_recognition',
         'admin_decide_recognition','admin_advance_recognition','admin_get_recognition_dashboard',
         'admin_import_inquiries','admin_get_tickets','admin_get_ticket','admin_create_ticket',
         'admin_update_ticket','admin_reply_ticket','admin_set_message_delivery',
         'admin_merge_ticket','admin_get_support_templates','admin_save_support_template',
         'admin_delete_support_template','admin_get_notifications','admin_send_member_notification',
         'admin_actor_email')
  loop
    execute format('revoke all on function public.%s from public, anon;', r.sig);
    execute format('grant execute on function public.%s to authenticated;', r.sig);
  end loop;
end $$;

-- Internal helpers are not an API surface. They are called from inside the
-- SECURITY DEFINER functions (as the owner), so no client role needs EXECUTE on
-- them -- and leaving it on lets an anon session probe who is an admin and what
-- a role may do via /rest/v1/rpc. admin_ok() stays executable by authenticated
-- because the admin_roles_read policy evaluates it as the querying role.
revoke all on function public.admin_can(text, uuid)   from public, anon, authenticated;
revoke all on function public.admin_role_of(uuid)     from public, anon, authenticated;
revoke all on function public.admin_ok()              from public, anon;
grant execute on function public.admin_ok() to authenticated;
revoke all on function public.assert_admin_can(text)  from public, anon, authenticated;

-- get_all_config() is read by member pages; it is granted to everyone but never
-- returns a key that looks like a secret.
create or replace function public.get_all_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from public.app_config
   where key !~* '(secret|token|passw|smtp|api_?key|stripe)';
$$;
grant execute on function public.get_all_config() to anon, authenticated;

-- Seed a small starting catalogue so the recognition module is usable on day
-- one. Values are placeholders an admin edits; no member is awarded anything by
-- this migration.
insert into public.gift_catalogue (name, description, sku, stock_quantity, unit_cost, eligibility, is_active)
select * from (values
  ('Hive Seed Packet', 'A packet of pollinator-friendly seeds posted to the member.', 'GIFT-SEEDS', 0, null::numeric, 'Any member with a completed reflection', true),
  ('Meadow Tote Bag', 'Cotton tote with the Hive Nectar mark.', 'GIFT-TOTE', 0, null, 'Members with sustained contribution', true),
  ('Hive+ Year Pin', 'Enamel pin awarded for a year of membership.', 'GIFT-PIN', 0, null, 'Members at Hive+ tier and above', true)
) v
where not exists (select 1 from public.gift_catalogue);

notify pgrst, 'reload schema';

commit;
