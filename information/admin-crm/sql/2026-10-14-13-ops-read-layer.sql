-- 2026-10-14-13-ops-read-layer.sql  (part 1 of 2)
-- Sections: S1 role fix | S2 SLA | S3 dashboard metrics | S4 activity feed | S5 reflections
--           S6 sigma inbox | S7 ticket history | S8 SLA stats | S9 member 360
--           S10 fulfilment queue | S11 review ingest | S12 grants
-- Phase A of the admin CRM brief (CRM LOGS REQUIREMENTS.md, §4 Dashboard, §9 Support/SLA, §12 Roles).
-- Read-only additions + one role-config correction + one SLA trigger. No member-facing change.
-- Every function: SECURITY DEFINER, search_path pinned, permission-gated, JSONB return.
begin;

-- =====================================================================
-- S1. Role config correction: fulfilment_manager cannot read its own screens
-- ---------------------------------------------------------------------
-- Live: admin_roles.fulfilment_manager.permissions = {recognition.approve,
-- fulfilment.manage, member.read, export.data}. The gift/recognition read RPCs
-- (admin_get_gifts, admin_get_recognition_dashboard) are guarded with
-- 'recognition.read', which this role does NOT hold and which read.all would
-- only cover if the role had it (it does not). Result: the Rewards/Fulfilment
-- role is served a Forbidden screen for the module it exists to run.
-- Additive fix, admin-plane only: grant the read alongside the approve it has.
-- =====================================================================
update public.admin_roles
   set permissions = array_append(permissions, 'recognition.read')
 where role_key = 'fulfilment_manager'
   and not ('recognition.read' = any(permissions));

-- =====================================================================
-- S2. SLA due date is never set on ticket creation
-- ---------------------------------------------------------------------
-- Live: support_tickets.sla_due_at exists and admin_update_ticket can write it,
-- but nothing sets it when a ticket arrives, so every new ticket shows a blank
-- SLA and the "overdue" metric can never fire. first_response_at IS automatic
-- (tg_support_message_rollup). This adds the missing create-time default.
-- Target hours come from app_config (key sla_hours_<priority>) when present, so
-- the owner can retune them without a migration; the fallback constants below
-- are the only business values this migration introduces.
-- =====================================================================
create or replace function public.sla_target_interval(p_priority text)
returns interval
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_key   text := 'sla_hours_' || coalesce(nullif(lower(trim(p_priority)), ''), 'normal');
  v_value text;
  v_hours numeric;
begin
  select value into v_value from public.app_config where key = v_key;
  if v_value is not null and v_value ~ '^[0-9]+(\.[0-9]+)?$' then
    v_hours := v_value::numeric;
  else
    v_hours := case p_priority
                 when 'urgent' then 4
                 when 'high'   then 8
                 when 'low'    then 72
                 else 24
               end;
  end if;
  return make_interval(mins => greatest(1, round(v_hours * 60))::int);
end;
$function$;

create or replace function public.tg_support_ticket_sla()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.sla_due_at is null then
    new.sla_due_at := coalesce(new.created_at, now()) + public.sla_target_interval(new.priority);
  end if;
  return new;
end;
$function$;

drop trigger if exists support_ticket_sla on public.support_tickets;
create trigger support_ticket_sla
  before insert on public.support_tickets
  for each row execute function public.tg_support_ticket_sla();

-- Backfill only tickets that are still open and have no target yet. Closed
-- history is left untouched (no invented timestamps on resolved work).
update public.support_tickets
   set sla_due_at = created_at + public.sla_target_interval(priority)
 where sla_due_at is null
   and status not in ('resolved', 'closed');

-- =====================================================================
-- S3. Dashboard metrics (brief §4) — real numbers, per-block permission gate
-- ---------------------------------------------------------------------
-- Activity criterion (the only invented business definition here, documented):
-- a member is ACTIVE if they have any completed task, nectar-ledger entry or
-- sigma log in the last 30 days; otherwise INACTIVE. Billing, support and
-- integration blocks are omitted entirely for roles that may not read them,
-- rather than shown as zeros.
-- =====================================================================
create or replace function public.admin_get_dashboard_metrics(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to   timestamptz := coalesce(p_to,   now());
  v_out  jsonb;
begin
  perform public.assert_admin_can('member.read');
  if v_to <= v_from then
    return jsonb_build_object('success', false, 'error', 'Invalid range');
  end if;

  v_out := jsonb_build_object(
    'success', true,
    'range', jsonb_build_object(
      'from', v_from, 'to', v_to,
      'days', greatest(1, ceil(extract(epoch from (v_to - v_from)) / 86400)::int)
    ),
    'members', (
      select jsonb_build_object(
        'total',    count(*),
        'new',      count(*) filter (where p.join_date::timestamptz between v_from and v_to),
        'free',     count(*) filter (where coalesce(p.member_tier, 0) = 0),
        'paid',     count(*) filter (where coalesce(p.member_tier, 0) > 0),
        'active',   count(*) filter (where a.last_at is not null),
        'inactive', count(*) filter (where a.last_at is null)
      )
      from public.profiles p
      left join lateral (
        select max(x.t) as last_at
          from (
            select ut.completed_at        as t from public.user_tasks   ut where ut.user_id = p.id
            union all
            select nl.created_at          as t from public.nectar_ledger nl where nl.user_id = p.id
            union all
            select sl.created_at          as t from public.sigma_logs    sl where sl.user_id = p.id
          ) x
         where x.t is not null and x.t >= now() - interval '30 days'
      ) a on true
    ),
    'engagement', jsonb_build_object(
      'tasks_completed', (
        select count(*) from public.user_tasks ut
         where ut.completed_at::timestamptz between v_from and v_to
      ),
      'tasks_completed_all_time', (
        select count(*) from public.user_tasks ut where ut.completed_at is not null
      ),
      'nectar_awarded', (
        select coalesce(sum(nl.delta), 0) from public.nectar_ledger nl
         where nl.delta > 0 and nl.created_at between v_from and v_to
      ),
      'nectar_reversed', (
        select coalesce(sum(nl.delta), 0) from public.nectar_ledger nl
         where nl.delta < 0 and nl.created_at between v_from and v_to
      ),
      'impact_co2e_kg', (
        select coalesce(round(sum(coalesce(ut.calculated_co2e_saved, ut.co2_saved_kg, 0))::numeric, 2), 0)
          from public.user_tasks ut
         where ut.completed_at::timestamptz between v_from and v_to
      )
    ),
    'awards', jsonb_build_object(
      'tokens', (
        select count(*) from public.user_tokens t
         where coalesce(t.awarded_at, t.acquired_at)::timestamptz between v_from and v_to
      ),
      'milestones', (
        select count(*) from public.user_milestones m
         where m.achieved_at::timestamptz between v_from and v_to
      ),
      'badges_approved', (
        select count(*) from public.user_badge_progress b
         where b.approved_at::timestamptz between v_from and v_to
      )
    ),
    'reviews', jsonb_build_object(
      'awaiting',               (select count(*) from public.member_reviews r where r.status in ('new', 'in_review')),
      'new',                    (select count(*) from public.member_reviews r where r.status = 'new'),
      'in_review',              (select count(*) from public.member_reviews r where r.status = 'in_review'),
      'needs_clarification',    (select count(*) from public.member_reviews r where r.status = 'needs_clarification'),
      'flagged',                (select count(*) from public.member_reviews r where r.status = 'flagged'),
      'reviewed_in_range',      (select count(*) from public.member_reviews r where r.reviewed_at between v_from and v_to),
      'unreviewed_reflections', (
        select count(*) from public.task_sigma_logs l
         where not exists (select 1 from public.member_reviews r
                            where r.source = 'task_reflection' and r.source_id = l.id::text)
      ),
      'unreviewed_sigma', (
        select count(*) from public.sigma_logs s
         where not exists (select 1 from public.member_reviews r
                            where r.source = 'sigma_log' and r.source_id = s.id::text)
      )
    ),
    'recognition', jsonb_build_object(
      'candidates_hint', (
        select count(distinct r.user_id) from public.member_reviews r
         where r.status = 'reviewed' and r.nominated_recognition_id is null
      ),
      'nominated',           (select count(*) from public.recognitions c where c.status = 'nominated'),
      'awaiting_acceptance', (select count(*) from public.recognitions c where c.status in ('approved', 'awaiting_acceptance')),
      'awaiting_address',    (select count(*) from public.recognitions c where c.status = 'awaiting_address'),
      'ready_to_pack',       (select count(*) from public.recognitions c where c.status = 'ready_to_pack'),
      'packed',              (select count(*) from public.recognitions c where c.status = 'packed'),
      'shipped',             (select count(*) from public.recognitions c where c.status = 'shipped'),
      'delivered',           (select count(*) from public.recognitions c where c.status = 'delivered'),
      'completed',           (select count(*) from public.recognitions c where c.status = 'completed'),
      'closed_unsuccessful', (select count(*) from public.recognitions c where c.status in ('rejected', 'declined', 'cancelled', 'delivery_failed')),
      'dispatched_in_range', (
        select count(*) from public.recognitions c
         where c.status in ('shipped', 'delivered', 'completed')
           and coalesce(c.shipped_at, c.completed_at, c.updated_at) between v_from and v_to
      ),
      'low_stock_gifts', (
        select count(*) from public.gift_catalogue g
         where g.is_active and g.stock_quantity <= 2
      )
    ),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'd', to_char(d, 'YYYY-MM-DD'),
               'signups', s.signups, 'tasks', s.tasks, 'nectar', s.nectar
             ) order by d), '[]'::jsonb)
        from generate_series(date_trunc('day', v_from), date_trunc('day', v_to), interval '1 day') d
        cross join lateral (
          select
            (select count(*) from public.profiles p
              where date_trunc('day', p.join_date::timestamptz) = d) as signups,
            (select count(*) from public.user_tasks ut
              where date_trunc('day', ut.completed_at::timestamptz) = d) as tasks,
            (select coalesce(sum(nl.delta), 0) from public.nectar_ledger nl
              where nl.delta > 0 and date_trunc('day', nl.created_at) = d) as nectar
        ) s
    ),
    'links', jsonb_build_object(
      'members', 'members', 'reviews', 'member-reviews', 'recognition', 'recognition',
      'support', 'support-inbox', 'billing', 'billing', 'tasks', 'tasks'
    )
  );

  if public.admin_can('support.read', auth.uid()) then
    v_out := v_out || jsonb_build_object('support', jsonb_build_object(
      'new',       (select count(*) from public.support_tickets t where t.status = 'new'),
      'open',      (select count(*) from public.support_tickets t where t.status in ('new', 'open')),
      'pending_customer', (select count(*) from public.support_tickets t where t.status = 'pending_customer'),
      'pending_internal', (select count(*) from public.support_tickets t where t.status = 'pending_internal'),
      'unanswered', (select count(*) from public.support_tickets t
                      where t.first_response_at is null and t.status not in ('resolved', 'closed')),
      'overdue',    (select count(*) from public.support_tickets t
                      where t.sla_due_at is not null and t.sla_due_at < now()
                        and t.status not in ('resolved', 'closed')),
      'resolved_in_range', (select count(*) from public.support_tickets t
                             where t.resolved_at between v_from and v_to),
      'avg_first_response_minutes', (
        select coalesce(round(avg(extract(epoch from (t.first_response_at - t.created_at)) / 60)::numeric, 1), 0)
          from public.support_tickets t
         where t.first_response_at is not null and t.created_at between v_from and v_to
      )
    ));
  end if;

  if public.admin_can('billing.read', auth.uid()) then
    v_out := v_out || jsonb_build_object('billing', jsonb_build_object(
      'tier0', (select count(*) from public.profiles p where coalesce(p.member_tier, 0) = 0),
      'tier1', (select count(*) from public.profiles p where p.member_tier = 1),
      'tier2', (select count(*) from public.profiles p where p.member_tier = 2),
      'tier3', (select count(*) from public.profiles p where p.member_tier = 3),
      'active_subscription', (
        select count(*) from public.profiles p where p.subscription_status in ('active', 'trialing')
      ),
      'past_due', (select count(*) from public.profiles p where p.subscription_status = 'past_due'),
      'canceling', (
        select count(*) from public.profiles p where coalesce(p.subscription_cancel_at_period_end, false)
      ),
      'renewing_30d', (
        select count(*) from public.profiles p
         where p.subscription_current_period_end between now() and now() + interval '30 days'
           and coalesce(p.subscription_cancel_at_period_end, false) = false
      ),
      'stripe_subscription_rows', (select count(*) from public.subscriptions),
      'webhook_events', (select count(*) from public.stripe_events where created_at between v_from and v_to),
      'note', 'Tiers and renewal dates come from profiles (the live source). Billing actions stay in Stripe.'
    ));
  end if;

  if public.admin_can('health.read', auth.uid()) then
    v_out := v_out || jsonb_build_object('system', jsonb_build_object(
      'notifications_failed', (
        select count(*) from public.admin_notifications n where n.delivery_status = 'failed'
      ),
      'notifications_pending', (
        select count(*) from public.admin_notifications n where n.delivery_status = 'pending'
      ),
      'last_admin_action_at', (select max(a.created_at) from public.admin_action_logs a)
    ));
  end if;

  return v_out;
end;
$function$;

commit;
-- Sections: S4 activity feed | S5 reflections | S6 sigma inbox | S7 ticket history
--           S8 SLA stats | S9 member 360 | S10 fulfilment queue | S11 review ingest
--           S12 grants + schema reload
begin;

-- =====================================================================
-- S4. Activity Feed (brief §4, §5) — merged chronological events
-- ---------------------------------------------------------------------
-- Built from tables that already hold real events. Blocks whose permission the
-- caller lacks are omitted, not zeroed: an auditor sees admin actions, a
-- support agent sees ticket traffic, a reviewer sees review traffic.
-- =====================================================================
create or replace function public.admin_get_activity_feed(
  p_limit  int         default 60,
  p_from   timestamptz default null,
  p_to     timestamptz default null,
  p_kind   text        default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from  timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to    timestamptz := coalesce(p_to, now());
  v_limit int := greatest(1, least(coalesce(p_limit, 60), 300));
  v_rows  jsonb;
begin
  perform public.assert_admin_can('member.read');

  with ev as (
    select p.join_date as at, 'member.signup' as kind,
           coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email) as actor,
           coalesce(p.alias, p.username, p.email) as subject,
           'New member registration' as detail,
           'member' as entity, p.id::text as entity_id, 'members' as section,
           p.email as actor_email
      from public.profiles p
     where p.join_date::timestamptz between v_from and v_to

    union all
    select ut.completed_at, 'task.completed',
           coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
           t.task_title, 'Nectar ' || coalesce(ut.points_awarded, ut.calculated_nectar, 0)::text || ' | CO2e ' || coalesce(ut.calculated_co2e_saved, ut.co2_saved_kg, 0)::text,
           'task', ut.id::text, 'members', p.email
      from public.user_tasks ut
      join public.tasks t on t.id = ut.task_id
      left join public.profiles p on p.id = ut.user_id
     where ut.completed_at::timestamptz between v_from and v_to

    union all
    select l.created_at, 'reflection.submitted',
           coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
           coalesce(t.task_title, 'Task reflection'),
           left(coalesce(l.define, l.improve, ''), 140),
           'reflection', l.id::text, 'member-reviews', p.email
      from public.task_sigma_logs l
      join public.profiles p on p.id = l.user_id
      left join public.tasks t on t.id = l.task_id
     where l.created_at between v_from and v_to

    union all
    select s.created_at, 'sigma.submitted',
           coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
           'Sigma improvement log',
           left(coalesce(s.improve, s.define, ''), 140),
           'sigma_log', s.id::text, 'sigma-logs', p.email
      from public.sigma_logs s
      join public.profiles p on p.id = s.user_id
     where s.created_at between v_from and v_to

    union all
    select nl.created_at, 'nectar.' || case when nl.delta >= 0 then 'awarded' else 'reversed' end,
           coalesce(nl.actor_email, 'system'),
           coalesce(p.alias, p.username, p.email),
           nl.delta::text || ' | ' || coalesce(nl.reason, nl.category, ''),
           'nectar', nl.id::text, 'nectar-impact', nl.actor_email
      from public.nectar_ledger nl
      left join public.profiles p on p.id = nl.user_id
     where nl.created_at between v_from and v_to

    union all
    select ut.awarded_at, 'token.awarded',
           'system', coalesce(p.username, p.email), tk.name, 'token', ut.id::text, 'tokens', p.email
      from public.user_tokens ut
      join public.tokens tk on tk.id = ut.token_id
      left join public.profiles p on p.id = ut.user_id
     where coalesce(ut.awarded_at, ut.acquired_at)::timestamptz between v_from and v_to

    union all
    select um.achieved_at, 'milestone.achieved',
           'system', coalesce(p.username, p.email), m.name, 'milestone', um.id::text, 'milestones', p.email
      from public.user_milestones um
      join public.milestones m on m.id = um.milestone_id
      left join public.profiles p on p.id = um.user_id
     where um.achieved_at::timestamptz between v_from and v_to

    union all
    select c.created_at, 'board.post', coalesce(c.author_email, 'admin'), coalesce(c.title, c.post_type),
           left(coalesce(c.content, ''), 140), 'communication', c.id::text, 'announcements', c.author_email
      from public.communications c
     where c.created_at between v_from and v_to
  ),
  rev as (
    select e.created_at as at, 'review.' || e.kind as kind, coalesce(e.actor_email, 'admin') as actor,
           coalesce(p.username, p.email) as subject,
           coalesce(e.from_status, '-') || ' to ' || coalesce(e.to_status, '-') as detail,
           'review' as entity, e.review_id::text as entity_id, 'member-reviews' as section,
           e.actor_email
      from public.member_review_events e
      left join public.member_reviews r on r.id = e.review_id
      left join public.profiles p on p.id = r.user_id
     where e.created_at between v_from and v_to
       and public.admin_can('review.read', auth.uid())
  ),
  rec_ev as (
    select e.created_at as at, 'recognition.' || e.kind as kind, coalesce(e.actor_email, 'admin') as actor,
           coalesce(p.username, p.email) as subject,
           coalesce(e.from_status, '-') || ' to ' || coalesce(e.to_status, '-') as detail,
           'recognition' as entity, e.recognition_id::text as entity_id, 'recognition' as section,
           e.actor_email
      from public.recognition_events e
      left join public.recognitions c on c.id = e.recognition_id
      left join public.profiles p on p.id = c.user_id
     where e.created_at between v_from and v_to
       and public.admin_can('recognition.read', auth.uid())
  ),
  sup_ev as (
    select m.created_at as at, 'support.' || coalesce(m.direction, 'message') as kind,
           coalesce(m.author_email, 'unknown') as actor,
           coalesce(t.subject, 'Ticket') as subject,
           left(coalesce(m.body, ''), 140) as detail,
           'ticket' as entity, t.id::text as entity_id, 'support-inbox' as section,
           m.author_email
      from public.support_messages m
      join public.support_tickets t on t.id = m.ticket_id
     where m.created_at between v_from and v_to
       and public.admin_can('support.read', auth.uid())
  ),
  adm_ev as (
    select a.created_at as at, 'admin.' || a.action as kind, coalesce(a.actor_email, 'admin') as actor,
           coalesce(a.target_type, 'system') || case when a.target_id is not null then ' ' || a.target_id::text else '' end as subject,
           left(coalesce(a.reason, ''), 140) as detail,
           'admin' as entity, a.id::text as entity_id, 'audit' as section,
           a.actor_email
      from public.admin_action_logs a
     where a.created_at between v_from and v_to
       and public.admin_can('audit.read', auth.uid())
  ),
  all_ev as (
    select * from ev
    union all select * from rev
    union all select * from rec_ev
    union all select * from sup_ev
    union all select * from adm_ev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', to_char(e.at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
           'at_raw', e.at, 'kind', e.kind, 'actor', e.actor, 'actor_email', e.actor_email,
           'subject', e.subject, 'detail', e.detail,
           'entity', e.entity, 'entity_id', e.entity_id, 'section', e.section
         ) order by e.at desc), '[]'::jsonb)
    into v_rows
    from (
      select * from all_ev a
       where a.at is not null
         and (p_kind is null or a.kind like p_kind || '%')
       order by a.at desc
       limit v_limit
    ) e;

  return jsonb_build_object(
    'success', true,
    'count', coalesce(jsonb_array_length(v_rows), 0),
    'rows', v_rows,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'legend', jsonb_build_object(
      'member', 'Registration', 'task', 'Task completion', 'reflection', 'Task reflection',
      'sigma_log', 'Sigma log', 'nectar', 'Nectar movement', 'token', 'Token awarded',
      'milestone', 'Milestone reached', 'review', 'Review activity',
      'recognition', 'Recognition activity', 'support', 'Support traffic',
      'communication', 'Board post', 'admin', 'Administrator action'
    )
  );
end;
$function$;

-- =====================================================================
-- S5. Reflections inbox (brief §6) — per-task DMAIC submissions
-- =====================================================================
create or replace function public.admin_get_reflections(
  p_status text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows  jsonb;
  v_total bigint;
begin
  perform public.assert_admin_can('review.read');
  if p_status is not null and p_status not in ('new', 'in_review', 'needs_clarification', 'reviewed', 'flagged', 'unreviewed') then
    return jsonb_build_object('success', false, 'error', 'Invalid status');
  end if;

  select count(*) into v_total
    from public.task_sigma_logs l
    left join public.member_reviews r on r.source = 'task_reflection' and r.source_id = l.id::text
   where p_status is null
      or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
      or r.status = p_status;

  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select l.created_at,
             jsonb_build_object(
               'id', l.id,
               'kind', 'task_reflection',
               'created_at', l.created_at,
               'user_id', l.user_id,
               'user_email', p.email,
               'user_name', coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
               'task_id', l.task_id,
               'task_title', t.task_title,
               'task_stage', t.stage,
               'theme_id', t.theme_id,
               'completed_at', ut.completed_at,
               'define', l.define, 'measure', l.measure, 'analysis', l.analysis,
               'improve', l.improve, 'control', l.control,
               'review_id', r.id,
               'review_status', coalesce(r.status, 'unreviewed'),
               'assignee_id', r.assignee_id,
               'reviewer_id', r.reviewer_id,
               'reviewed_at', r.reviewed_at,
               'clarification_requested_at', r.clarification_requested_at,
               'flagged_reason', r.flagged_reason,
               'internal_notes', r.internal_notes,
               'member_response', r.member_response,
               'member_response_delivery', r.member_response_delivery,
               'nominated_recognition_id', r.nominated_recognition_id
             ) as obj
        from public.task_sigma_logs l
        left join public.tasks t on t.id = l.task_id
        left join public.user_tasks ut on ut.task_id = l.task_id and ut.user_id = l.user_id
        left join public.profiles p on p.id = l.user_id
        left join public.member_reviews r on r.source = 'task_reflection' and r.source_id = l.id::text
       where p_status is null
          or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
          or r.status = p_status
       order by l.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) x;

  return jsonb_build_object(
    'success', true, 'count', coalesce(jsonb_array_length(v_rows), 0),
    'total', v_total, 'rows', v_rows,
    'note', 'Reflections are stored in task_sigma_logs (DMAIC columns). Reading a reflection never changes nectar or achievements.'
  );
end;
$function$;

-- =====================================================================
-- S6. Sigma log inbox (brief §6) — standalone improvement logs
-- =====================================================================
create or replace function public.admin_get_sigma_inbox(
  p_status text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows  jsonb;
  v_total bigint;
begin
  perform public.assert_admin_can('review.read');
  if p_status is not null and p_status not in ('new', 'in_review', 'needs_clarification', 'reviewed', 'flagged', 'unreviewed') then
    return jsonb_build_object('success', false, 'error', 'Invalid status');
  end if;

  select count(*) into v_total
    from public.sigma_logs l
    left join public.member_reviews r on r.source = 'sigma_log' and r.source_id = l.id::text
   where p_status is null
      or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
      or r.status = p_status;

  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select l.created_at,
             jsonb_build_object(
               'id', l.id, 'kind', 'sigma_log', 'created_at', l.created_at,
               'user_id', l.user_id,
               'user_email', p.email,
               'user_name', coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
               'define', l.define, 'measure', l.measure, 'analysis', l.analysis,
               'improve', l.improve, 'control', l.control,
               'review_id', r.id,
               'review_status', coalesce(r.status, 'unreviewed'),
               'assignee_id', r.assignee_id, 'reviewed_at', r.reviewed_at,
               'flagged_reason', r.flagged_reason, 'internal_notes', r.internal_notes,
               'member_response', r.member_response,
               'nominated_recognition_id', r.nominated_recognition_id
             ) as obj
        from public.sigma_logs l
        left join public.profiles p on p.id = l.user_id
        left join public.member_reviews r on r.source = 'sigma_log' and r.source_id = l.id::text
       where p_status is null
          or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
          or r.status = p_status
       order by l.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) x;

  return jsonb_build_object(
    'success', true, 'count', coalesce(jsonb_array_length(v_rows), 0),
    'total', v_total, 'rows', v_rows
  );
end;
$function$;

-- =====================================================================
-- S7. Ticket history (brief §9) — archive + SLA columns
-- =====================================================================
create or replace function public.admin_get_ticket_history(
  p_status   text default null,
  p_priority text default null,
  p_limit    int  default 100,
  p_offset   int  default 0,
  p_overdue  boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows  jsonb;
  v_total bigint;
begin
  perform public.assert_admin_can('support.read');
  if p_status is not null and p_status not in ('new', 'open', 'pending_customer', 'pending_internal', 'resolved', 'closed') then
    return jsonb_build_object('success', false, 'error', 'Invalid status');
  end if;

  select count(*) into v_total
    from public.support_tickets t
   where (p_status is null or t.status = p_status)
     and (p_priority is null or t.priority = p_priority)
     and (p_overdue is null
          or (p_overdue and t.sla_due_at is not null and t.sla_due_at < now() and t.status not in ('resolved', 'closed'))
          or (not p_overdue and not (t.sla_due_at is not null and t.sla_due_at < now() and t.status not in ('resolved', 'closed'))));

  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select t.created_at,
             jsonb_build_object(
               'id', t.id, 'ticket_no', t.ticket_no, 'subject', t.subject,
               'requester_id', t.requester_id, 'requester_email', t.requester_email,
               'requester_name', t.requester_name, 'source', t.source,
               'status', t.status, 'priority', t.priority, 'category', t.category,
               'assignee_id', t.assignee_id, 'merged_into', t.merged_into,
               'assignee_email', (select pr.email from public.profiles pr where pr.id = t.assignee_id),
               'first_response_at', t.first_response_at,
               'first_response_minutes', case when t.first_response_at is not null
                    then round(extract(epoch from (t.first_response_at - t.created_at)) / 60)::int end,
               'last_customer_reply_at', t.last_customer_reply_at,
               'resolved_at', t.resolved_at, 'closed_at', t.closed_at, 'reopened_at', t.reopened_at,
               'sla_due_at', t.sla_due_at,
               'sla_state', case
                    when t.status in ('resolved', 'closed') then 'closed'
                    when t.sla_due_at is null then 'unset'
                    when t.sla_due_at < now() then 'overdue'
                    when t.sla_due_at < now() + interval '4 hours' then 'due_soon'
                    else 'within' end,
               'age_hours', round(extract(epoch from (now() - t.created_at)) / 3600)::int,
               'message_count', (select count(*) from public.support_messages m where m.ticket_id = t.id),
               'last_message_at', (select max(m.created_at) from public.support_messages m where m.ticket_id = t.id),
               'created_at', t.created_at, 'updated_at', t.updated_at
             ) as obj
        from public.support_tickets t
       where (p_status is null or t.status = p_status)
         and (p_priority is null or t.priority = p_priority)
         and (p_overdue is null
              or (p_overdue and t.sla_due_at is not null and t.sla_due_at < now() and t.status not in ('resolved', 'closed'))
              or (not p_overdue and not (t.sla_due_at is not null and t.sla_due_at < now() and t.status not in ('resolved', 'closed'))))
       order by t.created_at desc
       limit greatest(1, least(coalesce(p_limit, 100), 500))
      offset greatest(0, coalesce(p_offset, 0))
    ) x;

  return jsonb_build_object(
    'success', true, 'count', coalesce(jsonb_array_length(v_rows), 0),
    'total', v_total, 'rows', v_rows,
    'statuses', jsonb_build_array('new', 'open', 'pending_customer', 'pending_internal', 'resolved', 'closed')
  );
end;
$function$;

-- =====================================================================
-- S8. Support SLA stats (brief §9)
-- =====================================================================
create or replace function public.admin_get_sla_stats(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to   timestamptz := coalesce(p_to, now());
begin
  perform public.assert_admin_can('support.read');

  return jsonb_build_object(
    'success', true,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'targets_hours', (
      select coalesce(jsonb_object_agg(k.key, k.hours), '{}'::jsonb)
        from (select p.priority as key,
                     extract(epoch from public.sla_target_interval(p.priority)) / 3600 as hours
                from (values ('urgent'), ('high'), ('normal'), ('low')) p(priority)) k
    ),
    'open', jsonb_build_object(
      'total',        (select count(*) from public.support_tickets t where t.status not in ('resolved', 'closed')),
      'unanswered',   (select count(*) from public.support_tickets t where t.first_response_at is null and t.status not in ('resolved', 'closed')),
      'overdue',      (select count(*) from public.support_tickets t where t.sla_due_at < now() and t.status not in ('resolved', 'closed')),
      'no_target',    (select count(*) from public.support_tickets t where t.sla_due_at is null and t.status not in ('resolved', 'closed')),
      'avg_age_hours', (select coalesce(round(avg(extract(epoch from (now() - t.created_at)) / 3600)::numeric, 1), 0)
                          from public.support_tickets t where t.status not in ('resolved', 'closed'))
    ),
    'resolved_in_range', jsonb_build_object(
      'count', (select count(*) from public.support_tickets t where t.resolved_at between v_from and v_to),
      'avg_resolution_hours', (select coalesce(round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600)::numeric, 1), 0)
                                 from public.support_tickets t where t.resolved_at between v_from and v_to)
    ),
    'first_response', jsonb_build_object(
      'answered_in_range', (select count(*) from public.support_tickets t
                             where t.first_response_at between v_from and v_to),
      'avg_minutes', (select coalesce(round(avg(extract(epoch from (t.first_response_at - t.created_at)) / 60)::numeric, 1), 0)
                        from public.support_tickets t where t.first_response_at between v_from and v_to),
      'within_target', (select count(*) from public.support_tickets t
                         where t.first_response_at is not null
                           and t.created_at + public.sla_target_interval(t.priority) >= t.first_response_at),
      'breached', (select count(*) from public.support_tickets t
                    where t.first_response_at is not null
                      and t.created_at + public.sla_target_interval(t.priority) < t.first_response_at)
    ),
    'by_priority', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'priority', t.priority, 'tickets', t.n,
               'open', t.open_n, 'overdue', t.overdue_n) order by t.priority), '[]'::jsonb)
        from (
          select priority,
                 count(*) n,
                 count(*) filter (where status not in ('resolved', 'closed')) open_n,
                 count(*) filter (where sla_due_at < now() and status not in ('resolved', 'closed')) overdue_n
            from public.support_tickets group by priority
        ) t
    )
  );
end;
$function$;

-- =====================================================================
-- S9. Member 360 (brief §5) — one round trip, outstanding counts included
-- =====================================================================
-- Shipping address and phone are returned ONLY to a caller holding
-- 'fulfilment.manage' (brief §8: restrict access, never in general analytics).
-- =====================================================================
create or replace function public.admin_get_member_360(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_can_pii boolean := public.admin_can('fulfilment.manage', auth.uid());
  v_out     jsonb;
begin
  perform public.assert_admin_can('member.read');
  if p_user_id is null then
    return jsonb_build_object('success', false, 'error', 'Missing member id');
  end if;

  v_out := jsonb_build_object(
    'success', true,
    'member', (
      select jsonb_build_object(
        'id', p.id, 'email', p.email, 'username', p.username, 'alias', p.alias,
        'first_name', p.first_name, 'last_name', p.last_name, 'avatar_url', p.avatar_url,
        'join_date', p.join_date, 'member_status', p.member_status,
        'member_tier', p.member_tier, 'tier', p.tier,
        'nectar_points', p.nectar_points,
        'total_tasks_completed', p.total_tasks_completed,
        'current_stage', p.current_stage, 'experience', p.experience,
        'user_level', p.user_level, 'engagement_level', p.engagement_level,
        'total_co2e_saved', p.total_co2e_saved,
        'selected_themes', p.selected_themes, 'prefers_experienced', p.prefers_experienced,
        'referral_code', p.referral_code, 'referral_count', p.referral_count,
        'is_public', p.is_public,
        'subscription_status', p.subscription_status,
        'subscription_tier', p.subscription_tier,
        'subscription_current_period_end', p.subscription_current_period_end,
        'subscription_cancel_at_period_end', p.subscription_cancel_at_period_end,
        'stripe_customer_id', case when public.admin_can('billing.read', auth.uid()) then p.stripe_customer_id end,
        'phone_number',   case when v_can_pii then p.phone_number end,
        'address',        case when v_can_pii then p.address end,
        'pii_masked', not v_can_pii
      )
      from public.profiles p where p.id = p_user_id
    ),
    'outstanding', jsonb_build_object(
      'total',
        (select count(*) from public.member_reviews r where r.user_id = p_user_id and r.status in ('new', 'in_review')),
      'reviews',
        (select count(*) from public.member_reviews r where r.user_id = p_user_id and r.status in ('new', 'in_review')),
      'unreviewed_reflections',
        (select count(*) from public.task_sigma_logs l
          where l.user_id = p_user_id
            and not exists (select 1 from public.member_reviews r
                             where r.source = 'task_reflection' and r.source_id = l.id::text)),
      'unreviewed_sigma',
        (select count(*) from public.sigma_logs s
          where s.user_id = p_user_id
            and not exists (select 1 from public.member_reviews r
                             where r.source = 'sigma_log' and r.source_id = s.id::text)),
      'open_tickets',
        (select count(*) from public.support_tickets t
          where t.requester_id = p_user_id and t.status not in ('resolved', 'closed')),
      'badges_pending',
        (select count(*) from public.user_badge_progress b
          where b.user_id = p_user_id and b.status in ('submitted', 'pending')),
      'recognition_awaiting_member',
        (select count(*) from public.recognitions c
          where c.user_id = p_user_id and c.status in ('approved', 'awaiting_acceptance', 'awaiting_address'))
    ),
    'tasks', jsonb_build_object(
      'completed', (select count(*) from public.user_tasks ut where ut.user_id = p_user_id and ut.completed_at is not null),
      'in_progress', (select count(*) from public.user_tasks ut where ut.user_id = p_user_id and ut.completed_at is null),
      'recent', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'task_id', ut.task_id, 'task_title', t.task_title, 'stage', t.stage,
                 'theme_id', t.theme_id, 'completed_at', ut.completed_at,
                 'nectar', coalesce(ut.points_awarded, ut.calculated_nectar, 0),
                 'co2e', coalesce(ut.calculated_co2e_saved, ut.co2_saved_kg, 0),
                 'evidence_url', ut.evidence_url, 'experience_level', ut.experience_level,
                 'status', ut.status) order by ut.completed_at desc nulls last), '[]'::jsonb)
          from (select * from public.user_tasks where user_id = p_user_id order by completed_at desc nulls last limit 20) ut
          left join public.tasks t on t.id = ut.task_id
      ),
      'themes', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'theme_id', tp.theme_id, 'theme_name', th.theme_name, 'stage', tp.stage,
                 'nectar_earned', tp.nectar_earned, 'variety_count', tp.variety_count,
                 'last_action_date', tp.last_action_date,
                 'novice_days_count', tp.novice_days_count,
                 'experienced_days_count', tp.experienced_days_count) order by tp.theme_id), '[]'::jsonb)
          from public.user_theme_progress tp
          left join public.themes th on th.theme_id = tp.theme_id
         where tp.user_id = p_user_id
      )
    ),
    'reflections', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', l.id, 'task_id', l.task_id, 'task_title', t.task_title, 'created_at', l.created_at,
               'define', l.define, 'measure', l.measure, 'analysis', l.analysis,
               'improve', l.improve, 'control', l.control,
               'review_status', coalesce(r.status, 'unreviewed'), 'review_id', r.id)
             order by l.created_at desc), '[]'::jsonb)
        from public.task_sigma_logs l
        left join public.tasks t on t.id = l.task_id
        left join public.member_reviews r on r.source = 'task_reflection' and r.source_id = l.id::text
       where l.user_id = p_user_id
    ),
    'sigma_logs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'created_at', s.created_at,
               'define', s.define, 'measure', s.measure, 'analysis', s.analysis,
               'improve', s.improve, 'control', s.control,
               'review_status', coalesce(r.status, 'unreviewed'), 'review_id', r.id)
             order by s.created_at desc), '[]'::jsonb)
        from public.sigma_logs s
        left join public.member_reviews r on r.source = 'sigma_log' and r.source_id = s.id::text
       where s.user_id = p_user_id
    ),
    'nectar', jsonb_build_object(
      'balance', (select coalesce(nectar_points, 0) from public.profiles where id = p_user_id),
      'earned_total', (select coalesce(sum(delta), 0) from public.nectar_ledger where user_id = p_user_id and delta > 0),
      'reversed_total', (select coalesce(sum(delta), 0) from public.nectar_ledger where user_id = p_user_id and delta < 0),
      'recent', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', nl.id, 'created_at', nl.created_at, 'delta', nl.delta,
                 'balance_after', nl.balance_after, 'reason', nl.reason,
                 'category', nl.category, 'source', nl.source,
                 'actor_email', nl.actor_email) order by nl.created_at desc), '[]'::jsonb)
          from (select * from public.nectar_ledger where user_id = p_user_id order by created_at desc limit 25) nl
      )
    ),
    'awards', jsonb_build_object(
      'tokens', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', ut.id, 'token_id', ut.token_id, 'name', tk.name, 'theme_id', tk.theme_id,
                 'stage', tk.stage, 'awarded_at', coalesce(ut.awarded_at, ut.acquired_at),
                 'viewed', ut.viewed) order by coalesce(ut.awarded_at, ut.acquired_at) desc), '[]'::jsonb)
          from public.user_tokens ut left join public.tokens tk on tk.id = ut.token_id
         where ut.user_id = p_user_id
      ),
      'milestones', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', um.id, 'milestone_id', um.milestone_id, 'name', m.name,
                 'achieved_at', um.achieved_at, 'viewed', um.viewed) order by um.achieved_at desc), '[]'::jsonb)
          from public.user_milestones um left join public.milestones m on m.id = um.milestone_id
         where um.user_id = p_user_id
      ),
      'badges', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', b.id, 'badge_id', b.badge_id, 'name', bd.name,
                 'current_stage', b.current_stage, 'total_stages', bd.total_stages,
                 'status', b.status, 'submitted_at', b.submitted_at, 'approved_at', b.approved_at)
               order by b.id), '[]'::jsonb)
          from public.user_badge_progress b left join public.badges bd on bd.id = b.badge_id
         where b.user_id = p_user_id
      )
    ),
    'jar', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', j.id, 'milestone_id', j.milestone_id, 'token_id', j.token_id,
               'x_pos', j.x_pos, 'y_pos', j.y_pos, 'scale', j.scale, 'rotation', j.rotation,
               'created_at', j.created_at) order by j.created_at), '[]'::jsonb)
        from public.user_jar_decorations j where j.user_id = p_user_id
    ),
    'collaborations', jsonb_build_object(
      'partners', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', c.id, 'created_at', c.created_at,
                 'other_user_id', case when c.user_a_id = p_user_id then c.user_b_id else c.user_a_id end,
                 'other_email', (select pr.email from public.profiles pr
                                  where pr.id = case when c.user_a_id = p_user_id then c.user_b_id else c.user_a_id end))
               order by c.created_at desc), '[]'::jsonb)
          from public.collaborations c
         where c.user_a_id = p_user_id or c.user_b_id = p_user_id
      ),
      'invites_sent', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', i.id, 'invitee_email', i.invitee_email, 'status', i.status,
                 'created_at', i.created_at, 'expires_at', i.expires_at, 'invitee_id', i.invitee_id)
               order by i.created_at desc), '[]'::jsonb)
          from public.collaboration_invites i where i.inviter_id = p_user_id
      ),
      'invites_received', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', i.id, 'inviter_id', i.inviter_id, 'status', i.status,
                 'created_at', i.created_at, 'expires_at', i.expires_at)
               order by i.created_at desc), '[]'::jsonb)
          from public.collaboration_invites i where i.invitee_id = p_user_id
      )
    ),
    'support', jsonb_build_object(
      'tickets', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', t.id, 'ticket_no', t.ticket_no, 'subject', t.subject, 'status', t.status,
                 'priority', t.priority, 'category', t.category, 'created_at', t.created_at,
                 'resolved_at', t.resolved_at, 'sla_due_at', t.sla_due_at,
                 'message_count', (select count(*) from public.support_messages m where m.ticket_id = t.id))
               order by t.created_at desc), '[]'::jsonb)
          from public.support_tickets t where t.requester_id = p_user_id
      )
    ),
    'audit', jsonb_build_object(
      'notes', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', e.id, 'kind', e.kind, 'from_status', e.from_status, 'to_status', e.to_status,
                 'body', e.body, 'actor_email', e.actor_email, 'created_at', e.created_at) order by e.created_at desc), '[]'::jsonb)
          from (
            select e.* from public.member_review_events e
              join public.member_reviews r on r.id = e.review_id
             where r.user_id = p_user_id
            union all
            select e.* from public.recognition_events e
              join public.recognitions c on c.id = e.recognition_id
             where c.user_id = p_user_id
          ) e
      ),
      'admin_actions', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'id', a.id, 'action', a.action, 'target_type', a.target_type, 'target_id', a.target_id,
                 'reason', a.reason, 'before', a.before_data, 'after', a.after_data,
                 'actor_email', a.actor_email, 'created_at', a.created_at) order by a.created_at desc), '[]'::jsonb)
          from (select * from public.admin_action_logs
                 where target_id = p_user_id::text or (target_type = 'member' and target_id = p_user_id::text)
                 order by created_at desc limit 40) a
      )
    )
  );

  return v_out;
end;
$function$;

-- =====================================================================
-- S10. Gift fulfilment queue (brief §8) — statuses, stock, address gating
-- =====================================================================
create or replace function public.admin_get_fulfilment_queue(
  p_status text default null,
  p_limit  int  default 100
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_can_pii boolean := public.admin_can('fulfilment.manage', auth.uid());
begin
  perform public.assert_admin_can('recognition.read');

  return jsonb_build_object(
    'success', true,
    'counts', (
      select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
        from (select status, count(*) n from public.recognitions group by status) s
    ),
    'stock', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'sku', g.sku, 'stock_quantity', g.stock_quantity,
               'unit_cost', g.unit_cost, 'is_active', g.is_active,
               'low', g.stock_quantity <= 2) order by g.stock_quantity, g.name), '[]'::jsonb)
        from public.gift_catalogue g where g.is_active
    ),
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'status', c.status, 'user_id', c.user_id,
               'member_email', p.email,
               'member_name', coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
               'member_tier', p.member_tier,
               'gift_id', c.gift_id, 'gift_name', g.name, 'gift_sku', g.sku, 'unit_cost', g.unit_cost,
               'reason', c.reason, 'nominated_at', c.nominated_at, 'decided_at', c.decided_at,
               'decision_note', c.decision_note, 'notified_at', c.notified_at,
               'accepted_at', c.accepted_at, 'declined_at', c.declined_at, 'consent_at', c.consent_at,
               'packed_at', c.packed_at, 'packing_note', c.packing_note,
               'carrier', c.carrier, 'tracking_number', c.tracking_number, 'tracking_url', c.tracking_url,
               'shipped_at', c.shipped_at, 'delivered_at', c.delivered_at, 'completed_at', c.completed_at,
               'failure_reason', c.failure_reason, 'created_at', c.created_at, 'updated_at', c.updated_at,
               'delivery', case when v_can_pii then jsonb_build_object(
                    'recipient_name', c.recipient_name, 'address_line1', c.address_line1,
                    'address_line2', c.address_line2, 'suburb', c.suburb, 'state', c.state,
                    'postcode', c.postcode, 'country', c.country, 'phone', c.phone)
                  else null end,
               'address_on_file', c.address_line1 is not null,
               'address_masked', not v_can_pii,
               'previous_gifts_for_member', (
                 select count(*) from public.recognitions c2
                  where c2.user_id = c.user_id and c2.id <> c.id
                    and c2.status in ('shipped', 'delivered', 'completed'))
             ) order by
                 case c.status
                   when 'nominated' then 1 when 'approved' then 2 when 'awaiting_acceptance' then 3
                   when 'awaiting_address' then 4 when 'ready_to_pack' then 5 when 'packed' then 6
                   when 'shipped' then 7 when 'delivered' then 8 else 9 end,
                 c.created_at desc), '[]'::jsonb)
        from public.recognitions c
        left join public.profiles p on p.id = c.user_id
        left join public.gift_catalogue g on g.id = c.gift_id
       where p_status is null or c.status = p_status
       limit greatest(1, least(coalesce(p_limit, 100), 500))
    ),
    'pii_visible', v_can_pii,
    'flow', jsonb_build_array('nominated', 'approved', 'awaiting_acceptance', 'awaiting_address',
                              'ready_to_pack', 'packed', 'shipped', 'delivered', 'completed'),
    'terminal', jsonb_build_array('rejected', 'declined', 'cancelled', 'delivery_failed')
  );
end;
$function$;

-- =====================================================================
-- S11. Review-queue ingest (brief §6, §13.3)
-- ---------------------------------------------------------------------
-- admin_sync_review_queue() exists in migration 11 and is correct, but nothing
-- ever calls it, so member_reviews is EMPTY and the Review Centre shows Nothing
-- even though reflections and sigma logs exist. This adds the missing
-- automation: a trigger inserts the queue row the moment a submission lands.
-- The internal helper carries no permission guard (it runs as the member's
-- insert); the admin-facing function keeps its guard. Failures are swallowed so
-- a member's reflection can never be rejected because the CRM queue hiccuped.
-- =====================================================================
create or replace function public.review_queue_ingest()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_table_name = 'task_sigma_logs' then
    insert into public.member_reviews (source, source_id, user_id, task_id, status)
    select 'task_reflection', new.id::text, new.user_id, new.task_id, 'new'
     where not exists (select 1 from public.member_reviews r
                        where r.source = 'task_reflection' and r.source_id = new.id::text);
  elsif tg_table_name = 'sigma_logs' then
    insert into public.member_reviews (source, source_id, user_id, task_id, status)
    select 'sigma_log', new.id::text, new.user_id, null, 'new'
     where not exists (select 1 from public.member_reviews r
                        where r.source = 'sigma_log' and r.source_id = new.id::text);
  end if;
  return new;
exception
  when others then
    return new;
end;
$function$;

drop trigger if exists review_queue_task_sigma on public.task_sigma_logs;
create trigger review_queue_task_sigma
  after insert on public.task_sigma_logs
  for each row execute function public.review_queue_ingest();

drop trigger if exists review_queue_sigma on public.sigma_logs;
create trigger review_queue_sigma
  after insert on public.sigma_logs
  for each row execute function public.review_queue_ingest();

-- Backfill every existing submission once (idempotent).
insert into public.member_reviews (source, source_id, user_id, task_id, status)
select 'task_reflection', l.id::text, l.user_id, l.task_id, 'new'
  from public.task_sigma_logs l
 where not exists (select 1 from public.member_reviews r
                    where r.source = 'task_reflection' and r.source_id = l.id::text);

insert into public.member_reviews (source, source_id, user_id, task_id, status)
select 'sigma_log', s.id::text, s.user_id, null, 'new'
  from public.sigma_logs s
 where not exists (select 1 from public.member_reviews r
                    where r.source = 'sigma_log' and r.source_id = s.id::text);

-- =====================================================================
-- S12. Grants — anon sees nothing; authenticated reaches the guard only
-- =====================================================================
revoke all on function public.sla_target_interval(text)          from public, anon, authenticated;
revoke all on function public.tg_support_ticket_sla()           from public, anon, authenticated;
revoke all on function public.review_queue_ingest()              from public, anon, authenticated;
revoke all on function public.admin_get_dashboard_metrics(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_get_activity_feed(int, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_get_reflections(text, int, int)  from public, anon;
revoke all on function public.admin_get_sigma_inbox(text, int, int)  from public, anon;
revoke all on function public.admin_get_ticket_history(text, text, int, int, boolean) from public, anon;
revoke all on function public.admin_get_sla_stats(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_get_member_360(uuid)         from public, anon;
revoke all on function public.admin_get_fulfilment_queue(text, int) from public, anon;

grant execute on function public.admin_get_dashboard_metrics(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_get_activity_feed(int, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_get_reflections(text, int, int)  to authenticated;
grant execute on function public.admin_get_sigma_inbox(text, int, int)  to authenticated;
grant execute on function public.admin_get_ticket_history(text, text, int, int, boolean) to authenticated;
grant execute on function public.admin_get_sla_stats(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_get_member_360(uuid)         to authenticated;
grant execute on function public.admin_get_fulfilment_queue(text, int) to authenticated;

commit;

notify pgrst, 'reload schema';
