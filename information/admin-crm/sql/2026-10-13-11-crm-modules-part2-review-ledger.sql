-- ============================================================================
-- 11 — CRM CORE MODULES, Part 2/4: Member Review Centre + Nectar ledger
--                      + settings store + integration health
-- ============================================================================
begin;

-- ------------------------------------------------------------- small utils --
create or replace function public.admin_actor_email(p_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select email from public.profiles where id = p_user_id), p_user_id::text);
$$;

-- ============================================================================
-- MEMBER REVIEW CENTRE
-- ============================================================================

-- Pull real submissions into the review queue. Idempotent: a submission is
-- never queued twice, and an existing review keeps its status, notes and
-- assignee. Submissions live in task_sigma_logs (per task) and sigma_logs
-- (standalone). Nothing is copied out of those tables.
create or replace function public.admin_sync_review_queue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task int := 0;
  v_solo int := 0;
  v_total int;
begin
  perform public.assert_admin_can('review.read');

  insert into public.member_reviews (source, source_id, user_id, task_id, status)
  select 'task_reflection', l.id::text, l.user_id, l.task_id, 'new'
    from public.task_sigma_logs l
   where l.user_id is not null
  on conflict (source, source_id) do nothing;
  get diagnostics v_task = row_count;

  insert into public.member_reviews (source, source_id, user_id, status)
  select 'sigma_log', l.id::text, l.user_id, 'new'
    from public.sigma_logs l
   where l.user_id is not null
  on conflict (source, source_id) do nothing;
  get diagnostics v_solo = row_count;

  select count(*) into v_total from public.member_reviews;
  return jsonb_build_object('success', true, 'queued_now', v_task + v_solo,
                            'task_reflections', v_task, 'standalone_logs', v_solo,
                            'total_in_queue', v_total);
end;
$$;

-- Queue listing with counts per status, plus the number of tasks that were
-- completed but never submitted (the member-side "Pending" tab).
create or replace function public.admin_get_review_queue(
  p_status   text default null,
  p_source   text default null,
  p_search   text default null,
  p_assignee uuid default null,
  p_limit    integer default 50,
  p_offset   integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_counts jsonb;
  v_pending int;
begin
  perform public.assert_admin_can('review.read');

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', r.id,
               'source', r.source,
               'source_id', r.source_id,
               'status', r.status,
               'priority', r.priority,
               'task_id', r.task_id,
               'member_id', r.user_id,
               'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
               'member_username', p.username,
               'member_email', p.email,
               'member_tier', p.member_tier,
               'assignee_id', r.assignee_id,
               'assignee_name', trim(both ' ' from concat_ws(' ', a.first_name, a.last_name)),
               'reviewer_name', trim(both ' ' from concat_ws(' ', v.first_name, v.last_name)),
               'reviewed_at', r.reviewed_at,
               'created_at', r.created_at,
               'updated_at', r.updated_at,
               'excerpt', left(coalesce(l.define, s.define, ''), 160)
             ) as x
        from public.member_reviews r
        join public.profiles p on p.id = r.user_id
        left join public.profiles a on a.id = r.assignee_id
        left join public.profiles v on v.id = r.reviewer_id
        left join public.task_sigma_logs l on r.source = 'task_reflection' and l.id::text = r.source_id
        left join public.sigma_logs s on r.source = 'sigma_log' and s.id::text = r.source_id
       where (p_status is null or r.status = p_status)
         and (p_source is null or r.source = p_source)
         and (p_assignee is null or r.assignee_id = p_assignee)
         and (coalesce(p_search, '') = '' or
              p.email ilike '%' || p_search || '%' or
              p.username ilike '%' || p_search || '%' or
              concat_ws(' ', p.first_name, p.last_name) ilike '%' || p_search || '%')
       order by r.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) t;

  select jsonb_build_object(
           'new', count(*) filter (where status = 'new'),
           'in_review', count(*) filter (where status = 'in_review'),
           'needs_clarification', count(*) filter (where status = 'needs_clarification'),
           'reviewed', count(*) filter (where status = 'reviewed'),
           'flagged', count(*) filter (where status = 'flagged'),
           'total', count(*))
    into v_counts
    from public.member_reviews;

  -- Completed tasks with no reflection submitted yet (member-side "Pending").
  select count(*) into v_pending
    from public.user_tasks ut
   where ut.completed_at is not null
     and not exists (select 1 from public.task_sigma_logs l where l.task_id = ut.task_id and l.user_id = ut.user_id);

  return jsonb_build_object('success', true, 'rows', v_rows, 'counts', v_counts,
                            'pending_submissions', coalesce(v_pending, 0));
end;
$$;

-- One review in full: the submission content, the member, the task, the history.
create or replace function public.admin_get_review_item(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev public.member_reviews;
  v_out jsonb;
begin
  perform public.assert_admin_can('review.read');

  select * into v_rev from public.member_reviews where id = p_id;
  if v_rev.id is null then
    return jsonb_build_object('success', false, 'error', 'Review not found');
  end if;

  select jsonb_build_object(
    'success', true,
    'review', to_jsonb(v_rev),
    'member', (select jsonb_build_object(
                 'id', p.id, 'email', p.email, 'username', p.username,
                 'first_name', p.first_name, 'last_name', p.last_name,
                 'member_tier', p.member_tier, 'nectar_points', p.nectar_points,
                 'member_status', p.member_status)
               from public.profiles p where p.id = v_rev.user_id),
    'assignee_name', (select trim(both ' ' from concat_ws(' ', p.first_name, p.last_name))
                        from public.profiles p where p.id = v_rev.assignee_id),
    'task', (select jsonb_build_object('id', t.id, 'title', t.task_title, 'theme_id', t.theme_id,
                                       'stage', t.stage, 'nectar_reward', t.nectar_reward)
               from public.tasks t where t.id = v_rev.task_id),
    'submission', case
        when v_rev.source = 'task_reflection' then
          (select jsonb_build_object('id', l.id, 'define', l.define, 'measure', l.measure,
                                     'analysis', l.analysis, 'improve', l.improve,
                                     'control', l.control, 'created_at', l.created_at)
             from public.task_sigma_logs l where l.id::text = v_rev.source_id)
        when v_rev.source = 'sigma_log' then
          (select jsonb_build_object('id', l.id, 'define', l.define, 'measure', l.measure,
                                     'analysis', l.analysis, 'improve', l.improve,
                                     'control', l.control, 'created_at', l.created_at)
             from public.sigma_logs l where l.id::text = v_rev.source_id)
        else null end,
    'history', coalesce((select jsonb_agg(jsonb_build_object(
                          'kind', e.kind, 'actor_name', trim(both ' ' from concat_ws(' ', ap.first_name, ap.last_name)),
                          'actor_email', e.actor_email, 'from_status', e.from_status, 'to_status', e.to_status,
                          'body', e.body, 'created_at', e.created_at) order by e.created_at)
                         from public.member_review_events e
                         left join public.profiles ap on ap.id = e.actor_id
                        where e.review_id = p_id), '[]'::jsonb),
    'open_recognitions', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', r.id, 'status', r.status, 'gift_id', r.gift_id,
                            'gift_name', g.name, 'reason', r.reason, 'created_at', r.created_at))
                           from public.recognitions r
                           join public.gift_catalogue g on g.id = r.gift_id
                          where r.user_id = v_rev.user_id
                            and r.status not in ('rejected','declined','cancelled','completed')), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- Assign (or clear) a reviewer. Assigning moves a 'new' item into 'in_review'.
create or replace function public.admin_assign_review(
  p_id uuid,
  p_assignee uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.member_reviews;
  v_after public.member_reviews;
begin
  perform public.assert_admin_can('review.decide');

  select * into v_before from public.member_reviews where id = p_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Review not found');
  end if;

  update public.member_reviews
     set assignee_id = p_assignee,
         status = case when p_assignee is not null and status = 'new' then 'in_review' else status end
   where id = p_id
  returning * into v_after;

  insert into public.member_review_events (review_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(), 'assign', v_before.status, v_after.status, p_reason);

  perform public.log_admin_action('review.assign', 'member_review', p_id::text,
      jsonb_build_object('assignee_id', v_before.assignee_id), jsonb_build_object('assignee_id', p_assignee), p_reason);

  return jsonb_build_object('success', true, 'status', v_after.status, 'assignee_id', v_after.assignee_id);
end;
$$;

-- Status transitions. Reviewing stamps reviewer + reviewed_at; flagging demands
-- a reason; writing the same status twice is a no-op rather than a fake change.
create or replace function public.admin_set_review_status(
  p_id uuid,
  p_status text,
  p_note text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.member_reviews;
  v_after public.member_reviews;
  v_kind text := 'status';
begin
  perform public.assert_admin_can('review.decide');

  if p_status not in ('new','in_review','needs_clarification','reviewed','flagged') then
    return jsonb_build_object('success', false, 'error', 'Unknown status: ' || coalesce(p_status, 'null'));
  end if;
  if p_status = 'flagged' and coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A reason is required to flag a submission');
  end if;

  select * into v_before from public.member_reviews where id = p_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Review not found');
  end if;
  if v_before.status = p_status and coalesce(p_note, '') = '' then
    return jsonb_build_object('success', false, 'error', 'Already in that status');
  end if;

  if p_status = 'flagged' then v_kind := 'flag'; end if;

  update public.member_reviews
     set status = p_status,
         internal_notes = coalesce(nullif(p_note, ''), internal_notes),
         flagged_reason = case when p_status = 'flagged' then p_reason else flagged_reason end,
         clarification_requested_at = case when p_status = 'needs_clarification' then now() else clarification_requested_at end,
         reviewer_id = case when p_status in ('reviewed','flagged') then auth.uid() else reviewer_id end,
         reviewed_at = case when p_status in ('reviewed','flagged') then now() else reviewed_at end
   where id = p_id
  returning * into v_after;

  insert into public.member_review_events (review_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(), v_kind, v_before.status, v_after.status,
          coalesce(nullif(p_note, ''), p_reason));

  perform public.log_admin_action('review.' || p_status, 'member_review', p_id::text,
      jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status),
      coalesce(nullif(p_note, ''), p_reason));

  return jsonb_build_object('success', true, 'status', v_after.status, 'reviewed_at', v_after.reviewed_at);
end;
$$;

-- Private member response. The text is stored on the review and a notification
-- row is queued for the member; the delivery flag stays honest -- with no mail
-- transport configured it reports 'not_configured' instead of claiming a send.
create or replace function public.admin_reply_to_member(
  p_id uuid,
  p_body text,
  p_channel text default 'in_app'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev public.member_reviews;
  v_mail_ready boolean;
  v_status text;
  v_notif bigint;
begin
  perform public.assert_admin_can('review.decide');

  if coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A reply body is required');
  end if;

  select * into v_rev from public.member_reviews where id = p_id;
  if v_rev.id is null then
    return jsonb_build_object('success', false, 'error', 'Review not found');
  end if;

  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'send_email')
      or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'queue_email')
    into v_mail_ready;
  v_status := case when v_mail_ready then 'queued' else 'not_configured' end;

  insert into public.admin_notifications (user_id, kind, title, body, related_type, related_id,
                                          channel, delivery_status, delivery_error, created_by)
  values (v_rev.user_id, 'review.reply', 'Message from the Hive team', p_body,
          'member_review', p_id::text, 'in_app', v_status,
          case when v_mail_ready then null else 'No mail transport is configured, so this stays in-app only.' end,
          auth.uid())
  returning id into v_notif;

  update public.member_reviews
     set member_response = p_body,
         member_response_at = now(),
         member_response_delivery = case when v_mail_ready then 'queued' else 'stored_only' end
   where id = p_id;

  insert into public.member_review_events (review_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(), 'reply', v_rev.status, v_rev.status, p_body);

  perform public.log_admin_action('review.reply', 'member_review', p_id::text, null,
      jsonb_build_object('notification_id', v_notif, 'delivery', v_status), null);

  return jsonb_build_object('success', true, 'notification_id', v_notif, 'delivery_status', v_status);
end;
$$;

-- ============================================================================
-- NECTAR LEDGER
-- ============================================================================
-- Adjust a member balance AND record it. profiles.nectar_points is the number
-- the game reads, so it is updated in the same transaction as the ledger row.
create or replace function public.admin_adjust_nectar(
  p_user_id uuid,
  p_delta integer,
  p_reason text,
  p_category text default 'correction'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after integer;
begin
  perform public.assert_admin_can('nectar.adjust');

  if p_delta = 0 then
    return jsonb_build_object('success', false, 'error', 'Delta must not be zero');
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A reason is required for every balance change');
  end if;
  if p_category not in ('adjustment','correction','recognition','task','milestone','token','reversal') then
    return jsonb_build_object('success', false, 'error', 'Unknown category: ' || coalesce(p_category,'null'));
  end if;

  select nectar_points into v_before from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Member not found');
  end if;
  v_before := coalesce(v_before, 0);

  if v_before + p_delta < 0 then
    return jsonb_build_object('success', false, 'error',
      format('That would take the balance below zero (current %s, change %s)', v_before, p_delta));
  end if;

  update public.profiles
     set nectar_points = v_before + p_delta
   where id = p_user_id
  returning nectar_points into v_after;

  insert into public.nectar_ledger (user_id, delta, balance_after, reason, category, source, actor_id, actor_email)
  values (p_user_id, p_delta, v_after, p_reason, p_category, 'admin', auth.uid(), public.admin_actor_email());

  perform public.log_admin_action('nectar.adjust', 'member', p_user_id::text,
      jsonb_build_object('nectar_points', v_before),
      jsonb_build_object('nectar_points', v_after, 'delta', p_delta), p_reason);

  return jsonb_build_object('success', true, 'balance_before', v_before, 'balance_after', v_after, 'delta', p_delta);
end;
$$;

create or replace function public.admin_get_nectar_ledger(
  p_user_id uuid default null,
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
  v_total int;
begin
  perform public.assert_admin_can('member.read');

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', n.id, 'member_id', n.user_id,
               'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
               'member_email', p.email,
               'delta', n.delta, 'balance_after', n.balance_after,
               'reason', n.reason, 'category', n.category, 'source', n.source,
               'actor_email', n.actor_email, 'created_at', n.created_at) as x
        from public.nectar_ledger n
        left join public.profiles p on p.id = n.user_id
       where p_user_id is null or n.user_id = p_user_id
       order by n.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 500))
      offset greatest(0, coalesce(p_offset, 0))
    ) t;

  select count(*) into v_total from public.nectar_ledger where p_user_id is null or user_id = p_user_id;

  return jsonb_build_object('success', true, 'rows', v_rows, 'total', v_total);
end;
$$;

-- ============================================================================
-- SETTINGS STORE
-- ============================================================================
-- app_config exists and is read by member pages through get_all_config(), which
-- was missing, so every caller silently fell back to its own default. Provide
-- the reader (plain object key -> value) and admin write paths on top of the
-- same table. No member-visible value is changed by this migration.
create or replace function public.get_all_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.app_config;
$$;

create or replace function public.admin_get_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('settings.read');

  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value) order by key), '[]'::jsonb)
    into v_rows
    from public.app_config;

  return jsonb_build_object('success', true, 'rows', v_rows,
                            'count', coalesce(jsonb_array_length(v_rows), 0));
end;
$$;

create or replace function public.admin_save_setting(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before text;
begin
  perform public.assert_admin_can('settings.write');

  if coalesce(trim(p_key), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A setting key is required');
  end if;

  select value into v_before from public.app_config where key = p_key;

  insert into public.app_config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;

  perform public.log_admin_action('settings.save', 'app_config', p_key,
      jsonb_build_object('value', v_before), jsonb_build_object('value', p_value), null);

  return jsonb_build_object('success', true, 'key', p_key, 'value', p_value);
end;
$$;

create or replace function public.admin_delete_setting(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before text;
begin
  perform public.assert_admin_can('settings.write');

  select value into v_before from public.app_config where key = p_key;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Setting not found');
  end if;

  delete from public.app_config where key = p_key;

  perform public.log_admin_action('settings.delete', 'app_config', p_key,
      jsonb_build_object('value', v_before), null, null);

  return jsonb_build_object('success', true, 'key', p_key);
end;
$$;

-- ============================================================================
-- INTEGRATION HEALTH
-- ============================================================================
-- Answers "is each external dependency actually wired?" from the database, so
-- an admin never has to guess whether email or billing will work.
create or replace function public.admin_get_integration_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email_fn boolean;
  v_tables jsonb;
begin
  perform public.assert_admin_can('health.read');

  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('send_email','queue_email'))
    into v_email_fn;

  select jsonb_build_object(
    'email_transport', jsonb_build_object(
        'ready', v_email_fn,
        'detail', case when v_email_fn then 'A mail function exists in the database.'
                       else 'No mail function in the database: nothing can be emailed from the CRM yet.' end),
    'billing', jsonb_build_object(
        'ready', exists (select 1 from public.subscriptions limit 1)
                 or exists (select 1 from public.profiles where stripe_customer_id is not null limit 1),
        'detail', case when exists (select 1 from public.profiles where stripe_customer_id is not null limit 1)
                       then 'Stripe customers are linked to members.'
                       else 'No member carries a Stripe customer id, so billing views have nothing to show.' end),
    'realtime', jsonb_build_object('ready', true, 'detail', 'Supabase Realtime is available; the CRM polls by default.'),
    'tables', jsonb_build_object(
        'app_config', (select count(*) from public.app_config),
        'member_reviews', (select count(*) from public.member_reviews),
        'recognitions', (select count(*) from public.recognitions),
        'gift_catalogue', (select count(*) from public.gift_catalogue),
        'support_tickets', (select count(*) from public.support_tickets),
        'notifications', (select count(*) from public.admin_notifications),
        'nectar_ledger', (select count(*) from public.nectar_ledger))
  ) into v_tables;

  return jsonb_build_object('success', true, 'health', v_tables);
end;
$$;

commit;
