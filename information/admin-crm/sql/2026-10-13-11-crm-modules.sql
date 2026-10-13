-- ============================================================================
-- 11 — CRM CORE MODULES, Part 1/4: tables
-- Member Review Centre, Nectar ledger, Recognition & Gift Fulfilment,
-- Support Inbox, central notifications.
-- ============================================================================
-- Additive: every table here is new. Nothing existing is altered and no
-- member-facing behaviour changes. Every table is RPC-only (RLS on, no client
-- policies) because each of these holds personal data -- submissions, shipping
-- addresses, support conversations -- that must not be readable with an anon or
-- a member session.

begin;

-- ============================================================================
-- 1. MEMBER REVIEW CENTRE
-- ============================================================================
-- One row per member submission that an administrator may have to look at.
-- submissions themselves stay where they are (task_sigma_logs / sigma_logs /
-- user_tasks evidence); this table is the review state machine on top of them,
-- so the original content is never copied, moved or edited.
create table if not exists public.member_reviews (
    id             uuid primary key default gen_random_uuid(),
    source         text not null check (source in ('task_reflection','sigma_log','task_evidence','badge_submission','milestone')),
    source_id      text not null,
    user_id        uuid not null references public.profiles(id) on delete cascade,
    task_id        uuid,
    status         text not null default 'new'
                   check (status in ('new','in_review','needs_clarification','reviewed','flagged')),
    priority       text not null default 'normal' check (priority in ('low','normal','high')),
    assignee_id    uuid references public.profiles(id) on delete set null,
    reviewer_id    uuid references public.profiles(id) on delete set null,
    reviewed_at    timestamptz,
    clarification_requested_at timestamptz,
    flagged_reason text,
    internal_notes text,
    member_response text,
    member_response_at timestamptz,
    member_response_delivery text not null default 'stored_only'
                   check (member_response_delivery in ('stored_only','queued','sent','failed')),
    nominated_recognition_id uuid,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (source, source_id)
);
create index if not exists member_reviews_status_idx on public.member_reviews (status, created_at desc);
create index if not exists member_reviews_user_idx   on public.member_reviews (user_id, created_at desc);
create index if not exists member_reviews_assign_idx on public.member_reviews (assignee_id, status);

-- Append-only history: every status change, note, reply and assignment.
create table if not exists public.member_review_events (
    id          bigserial primary key,
    review_id   uuid not null references public.member_reviews(id) on delete cascade,
    actor_id    uuid references public.profiles(id) on delete set null,
    actor_email text,
    kind        text not null check (kind in ('created','status','note','reply','assign','flag','recognition')),
    from_status text,
    to_status   text,
    body        text,
    created_at  timestamptz not null default now()
);
create index if not exists member_review_events_review_idx on public.member_review_events (review_id, created_at);

-- Triggers keep updated_at honest and write the audit trail for the review state.
create or replace function public.tg_review_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists review_touch on public.member_reviews;
create trigger review_touch before update on public.member_reviews
  for each row execute function public.tg_review_touch();

-- ============================================================================
-- 2. NECTAR LEDGER
-- ============================================================================
-- A forward-only ledger. Historical nectar was never recorded as transactions,
-- so the ledger starts empty and records from now on; nothing here invents
-- history. profiles.nectar_points stays the live balance the game already uses.
create table if not exists public.nectar_ledger (
    id            bigserial primary key,
    user_id       uuid not null references public.profiles(id) on delete cascade,
    delta         integer not null,
    balance_after integer not null,
    reason        text not null,
    category      text not null default 'adjustment'
                  check (category in ('adjustment','correction','recognition','task','milestone','token','reversal')),
    source        text not null default 'admin',
    actor_id      uuid references public.profiles(id) on delete set null,
    actor_email   text,
    created_at    timestamptz not null default now()
);
create index if not exists nectar_ledger_user_idx on public.nectar_ledger (user_id, created_at desc);

-- ============================================================================
-- 3. RECOGNITION & PHYSICAL GIFT FULFILMENT
-- ============================================================================
create table if not exists public.gift_catalogue (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    description   text,
    sku           text unique,
    image_url     text,
    stock_quantity integer not null default 0 check (stock_quantity >= 0),
    unit_cost     numeric(10,2) check (unit_cost is null or unit_cost >= 0),
    eligibility   text,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists gift_catalogue_active_idx on public.gift_catalogue (is_active, name);

-- Every stock change, so a miscalculation is always explainable.
create table if not exists public.gift_stock_movements (
    id             bigserial primary key,
    gift_id        uuid not null references public.gift_catalogue(id) on delete cascade,
    delta          integer not null,
    stock_after    integer not null,
    kind           text not null check (kind in ('initial','restock','allocation','return','correction')),
    recognition_id uuid,
    note           text,
    actor_id       uuid references public.profiles(id) on delete set null,
    actor_email    text,
    created_at     timestamptz not null default now()
);
create index if not exists gift_stock_movements_gift_idx on public.gift_stock_movements (gift_id, created_at desc);
-- One allocation per recognition: a retry cannot decrement stock twice.
create unique index if not exists gift_stock_one_allocation_per_recognition
    on public.gift_stock_movements (recognition_id) where kind = 'allocation';

create table if not exists public.recognitions (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references public.profiles(id) on delete cascade,
    gift_id        uuid not null references public.gift_catalogue(id),
    status         text not null default 'nominated'
                   check (status in ('nominated','approved','awaiting_acceptance','awaiting_address',
                                     'ready_to_pack','packed','shipped','delivered','completed',
                                     'rejected','declined','cancelled','delivery_failed')),
    reason         text not null,
    nominated_by   uuid references public.profiles(id) on delete set null,
    nominated_at   timestamptz not null default now(),
    decided_by     uuid references public.profiles(id) on delete set null,
    decided_at     timestamptz,
    decision_note  text,
    notified_at    timestamptz,
    accepted_at    timestamptz,
    declined_at    timestamptz,
    decline_reason text,
    -- Delivery details are collected only after the member accepts.
    consent_at     timestamptz,
    recipient_name text,
    address_line1  text,
    address_line2  text,
    suburb         text,
    state          text,
    postcode       text,
    country        text,
    phone          text,
    packing_note   text,
    packed_by      uuid references public.profiles(id) on delete set null,
    packed_at      timestamptz,
    carrier        text,
    tracking_number text,
    tracking_url   text,
    shipped_at     timestamptz,
    delivered_at   timestamptz,
    completed_at   timestamptz,
    failure_reason text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create index if not exists recognitions_status_idx on public.recognitions (status, created_at desc);
create index if not exists recognitions_user_idx   on public.recognitions (user_id, created_at desc);
-- A member cannot hold two live awards of the same gift.
create unique index if not exists recognitions_one_live_per_gift
    on public.recognitions (user_id, gift_id)
    where status not in ('rejected','declined','cancelled','delivery_failed');

create table if not exists public.recognition_evidence (
    id            bigserial primary key,
    recognition_id uuid not null references public.recognitions(id) on delete cascade,
    kind          text not null check (kind in ('reflection','sigma_log','task','milestone','token','note')),
    ref_id        text,
    note          text,
    added_by      uuid references public.profiles(id) on delete set null,
    created_at    timestamptz not null default now()
);
create index if not exists recognition_evidence_idx on public.recognition_evidence (recognition_id);

create or replace function public.tg_recognitions_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists recognitions_touch on public.recognitions;
create trigger recognitions_touch before update on public.recognitions
  for each row execute function public.tg_recognitions_touch();

drop trigger if exists gift_catalogue_touch on public.gift_catalogue;
create trigger gift_catalogue_touch before update on public.gift_catalogue
  for each row execute function public.tg_recognitions_touch();

-- ============================================================================
-- 4. SUPPORT INBOX
-- ============================================================================
create table if not exists public.support_tickets (
    id            uuid primary key default gen_random_uuid(),
    ticket_no     bigserial unique,
    subject       text not null,
    requester_id  uuid references public.profiles(id) on delete set null,
    requester_email text,
    requester_name  text,
    source        text not null default 'crm'
                  check (source in ('contact_form','crm','email','pollenpop','gift','other')),
    inquiry_id    uuid references public.contact_inquiries(id) on delete set null,
    status        text not null default 'new'
                  check (status in ('new','open','pending_customer','pending_internal','resolved','closed')),
    priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
    category      text,
    assignee_id   uuid references public.profiles(id) on delete set null,
    merged_into   uuid references public.support_tickets(id) on delete set null,
    first_response_at timestamptz,
    last_customer_reply_at timestamptz,
    resolved_at   timestamptz,
    closed_at     timestamptz,
    reopened_at   timestamptz,
    sla_due_at    timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists support_tickets_status_idx on public.support_tickets (status, updated_at desc);
create index if not exists support_tickets_inquiry_idx on public.support_tickets (inquiry_id);
create unique index if not exists support_tickets_inquiry_unique
    on public.support_tickets (inquiry_id) where inquiry_id is not null;

create table if not exists public.support_messages (
    id            uuid primary key default gen_random_uuid(),
    ticket_id     uuid not null references public.support_tickets(id) on delete cascade,
    direction     text not null check (direction in ('inbound','outbound','note')),
    author_id     uuid references public.profiles(id) on delete set null,
    author_email  text,
    author_name   text,
    body          text not null,
    template_id   uuid,
    -- A reply is only ever marked 'sent' when a transport confirmed it.
    email_status  text not null default 'not_attempted'
                  check (email_status in ('not_attempted','not_configured','queued','sent','failed')),
    email_error   text,
    provider_message_id text,
    attempts      integer not null default 0,
    sent_at       timestamptz,
    created_at    timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

create table if not exists public.support_templates (
    id          uuid primary key default gen_random_uuid(),
    name        text not null unique,
    category    text,
    body        text not null,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create or replace function public.tg_support_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists support_tickets_touch on public.support_tickets;
create trigger support_tickets_touch before update on public.support_tickets
  for each row execute function public.tg_support_touch();

drop trigger if exists support_templates_touch on public.support_templates;
create trigger support_templates_touch before update on public.support_templates
  for each row execute function public.tg_support_touch();

-- Inbound replies land on the existing ticket: a customer answering a resolved
-- ticket reopens it instead of opening a second thread.
create or replace function public.tg_support_message_rollup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'inbound' then
    update public.support_tickets
       set last_customer_reply_at = new.created_at,
           status = case when status in ('resolved','closed') then 'open' else status end,
           reopened_at = case when status in ('resolved','closed') then now() else reopened_at end
     where id = new.ticket_id;
  elsif new.direction = 'outbound' then
    update public.support_tickets
       set first_response_at = coalesce(first_response_at, new.created_at)
     where id = new.ticket_id;
  end if;
  return new;
end;
$$;

drop trigger if exists support_message_rollup on public.support_messages;
create trigger support_message_rollup after insert on public.support_messages
  for each row execute function public.tg_support_message_rollup();

-- ============================================================================
-- 5. CENTRAL NOTIFICATIONS (outbox for member-visible events)
-- ============================================================================
-- Delivery state is explicit: with no mail transport configured nothing may be
-- reported as sent.
create table if not exists public.admin_notifications (
    id            bigserial primary key,
    user_id       uuid not null references public.profiles(id) on delete cascade,
    kind          text not null,
    title         text not null,
    body          text,
    link          text,
    related_type  text,
    related_id    text,
    channel       text not null default 'in_app' check (channel in ('in_app','email')),
    delivery_status text not null default 'not_configured'
                  check (delivery_status in ('not_configured','queued','sent','failed','read')),
    delivery_error text,
    attempts      integer not null default 0,
    read_at       timestamptz,
    created_by    uuid references public.profiles(id) on delete set null,
    created_at    timestamptz not null default now()
);
create index if not exists admin_notifications_user_idx on public.admin_notifications (user_id, created_at desc);

commit;
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
-- ============================================================================
-- 11 — CRM CORE MODULES, Part 3/4: Recognition & Physical Gift Fulfilment
-- ============================================================================
begin;

-- History for a recognition: nomination, decision, every fulfilment step.
create table if not exists public.recognition_events (
    id             bigserial primary key,
    recognition_id uuid not null references public.recognitions(id) on delete cascade,
    actor_id       uuid references public.profiles(id) on delete set null,
    actor_email    text,
    kind           text not null check (kind in ('nominated','approved','rejected','notified','accepted','declined','address','allocated','packed','shipped','delivered','completed','failed','cancelled','note')),
    from_status    text,
    to_status      text,
    body           text,
    created_at     timestamptz not null default now()
);
create index if not exists recognition_events_idx on public.recognition_events (recognition_id, created_at);

-- ---------------------------------------------------------------- catalogue --
create or replace function public.admin_get_gifts(
  p_search text default null,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('recognition.read');

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'description', g.description, 'sku', g.sku,
           'image_url', g.image_url, 'stock_quantity', g.stock_quantity,
           'unit_cost', g.unit_cost, 'eligibility', g.eligibility, 'is_active', g.is_active,
           'allocated', (select count(*) from public.recognitions r
                          where r.gift_id = g.id and r.status in ('ready_to_pack','packed','shipped','delivered','completed')),
           'open_awards', (select count(*) from public.recognitions r
                            where r.gift_id = g.id and r.status not in ('rejected','declined','cancelled','completed','delivery_failed')),
           'created_at', g.created_at, 'updated_at', g.updated_at) order by g.name), '[]'::jsonb)
    into v_rows
    from public.gift_catalogue g
   where (p_include_inactive or g.is_active)
     and (coalesce(p_search,'') = '' or g.name ilike '%'||p_search||'%' or g.sku ilike '%'||p_search||'%');

  return jsonb_build_object('success', true, 'rows', v_rows);
end;
$$;

create or replace function public.admin_save_gift(p_gift jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_gift->>'id','')::uuid;
  v_stock integer := coalesce(nullif(p_gift->>'stock_quantity','')::integer, 0);
  v_before public.gift_catalogue;
  v_after public.gift_catalogue;
begin
  perform public.assert_admin_can('recognition.manage');

  if coalesce(trim(p_gift->>'name'), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A gift name is required');
  end if;
  if v_stock < 0 then
    return jsonb_build_object('success', false, 'error', 'Stock cannot be negative');
  end if;
  if nullif(p_gift->>'unit_cost','') is not null and (p_gift->>'unit_cost')::numeric < 0 then
    return jsonb_build_object('success', false, 'error', 'Unit cost cannot be negative');
  end if;

  if v_id is null then
    insert into public.gift_catalogue (name, description, sku, image_url, stock_quantity, unit_cost, eligibility, is_active)
    values (trim(p_gift->>'name'), nullif(p_gift->>'description',''), nullif(p_gift->>'sku',''),
            nullif(p_gift->>'image_url',''), v_stock,
            nullif(p_gift->>'unit_cost','')::numeric, nullif(p_gift->>'eligibility',''),
            coalesce((p_gift->>'is_active')::boolean, true))
    returning * into v_after;

    insert into public.gift_stock_movements (gift_id, delta, stock_after, kind, note, actor_id, actor_email)
    values (v_after.id, v_after.stock_quantity, v_after.stock_quantity, 'initial', 'Catalogue item created',
            auth.uid(), public.admin_actor_email());

    perform public.log_admin_action('gift.create', 'gift', v_after.id::text, null, to_jsonb(v_after), null);
    return jsonb_build_object('success', true, 'created', true, 'gift', to_jsonb(v_after));
  end if;

  select * into v_before from public.gift_catalogue where id = v_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Gift not found');
  end if;

  update public.gift_catalogue
     set name = trim(p_gift->>'name'),
         description = nullif(p_gift->>'description',''),
         sku = nullif(p_gift->>'sku',''),
         image_url = nullif(p_gift->>'image_url',''),
         stock_quantity = v_stock,
         unit_cost = nullif(p_gift->>'unit_cost','')::numeric,
         eligibility = nullif(p_gift->>'eligibility',''),
         is_active = coalesce((p_gift->>'is_active')::boolean, is_active)
   where id = v_id
  returning * into v_after;

  -- A stock edit made here is still a stock movement, so the ledger of stock
  -- always explains the number on screen.
  if v_stock <> v_before.stock_quantity then
    insert into public.gift_stock_movements (gift_id, delta, stock_after, kind, note, actor_id, actor_email)
    values (v_id, v_stock - v_before.stock_quantity, v_stock,
            case when v_stock > v_before.stock_quantity then 'restock' else 'correction' end,
            'Edited from the catalogue screen', auth.uid(), public.admin_actor_email());
  end if;

  perform public.log_admin_action('gift.update', 'gift', v_id::text, to_jsonb(v_before), to_jsonb(v_after), null);
  return jsonb_build_object('success', true, 'created', false, 'gift', to_jsonb(v_after));
end;
$$;

create or replace function public.admin_set_gift_active(p_id uuid, p_is_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.gift_catalogue;
  v_after public.gift_catalogue;
begin
  perform public.assert_admin_can('recognition.manage');

  select * into v_before from public.gift_catalogue where id = p_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Gift not found');
  end if;

  update public.gift_catalogue set is_active = p_is_active where id = p_id returning * into v_after;
  perform public.log_admin_action('gift.set_active', 'gift', p_id::text,
      jsonb_build_object('is_active', v_before.is_active), jsonb_build_object('is_active', p_is_active), null);
  return jsonb_build_object('success', true, 'is_active', v_after.is_active);
end;
$$;

create or replace function public.admin_adjust_gift_stock(
  p_gift_id uuid,
  p_delta integer,
  p_kind text default 'restock',
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after public.gift_catalogue;
  v_new integer;
begin
  perform public.assert_admin_can('recognition.manage');

  if p_delta = 0 then
    return jsonb_build_object('success', false, 'error', 'Stock change must not be zero');
  end if;
  if p_kind not in ('initial','restock','allocation','return','correction') then
    return jsonb_build_object('success', false, 'error', 'Unknown stock movement kind');
  end if;

  select * into v_after from public.gift_catalogue where id = p_gift_id;
  if v_after.id is null then
    return jsonb_build_object('success', false, 'error', 'Gift not found');
  end if;

  v_new := v_after.stock_quantity + p_delta;
  if v_new < 0 then
    return jsonb_build_object('success', false, 'error',
      format('Only %s in stock', v_after.stock_quantity));
  end if;

  update public.gift_catalogue set stock_quantity = v_new where id = p_gift_id returning * into v_after;

  insert into public.gift_stock_movements (gift_id, delta, stock_after, kind, note, actor_id, actor_email)
  values (p_gift_id, p_delta, v_new, p_kind, p_note, auth.uid(), public.admin_actor_email());

  perform public.log_admin_action('gift.stock', 'gift', p_gift_id::text,
      jsonb_build_object('stock_quantity', v_new - p_delta),
      jsonb_build_object('stock_quantity', v_new, 'delta', p_delta), p_note);

  return jsonb_build_object('success', true, 'stock_quantity', v_new);
end;
$$;

create or replace function public.admin_get_gift_stock_movements(p_gift_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('recognition.read');

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'delta', m.delta, 'stock_after', m.stock_after, 'kind', m.kind,
           'note', m.note, 'recognition_id', m.recognition_id,
           'actor_email', m.actor_email, 'created_at', m.created_at) order by m.created_at desc), '[]'::jsonb)
    into v_rows
    from (select * from public.gift_stock_movements where gift_id = p_gift_id
           order by created_at desc limit greatest(1, least(coalesce(p_limit,50), 200))) m;

  return jsonb_build_object('success', true, 'rows', v_rows);
end;
$$;

-- ============================================================================
-- NOMINATION, DECISION, FULFILMENT
-- ============================================================================
create or replace function public.admin_get_recognition_candidates(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.assert_admin_can('recognition.read');

  -- Ranked from real activity: completed tasks and reflections in the last 90
  -- days. Members already holding a live award are excluded so the list is a
  -- "who might deserve something next" list, not a repeat-award list.
  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', c.id, 'name', trim(both ' ' from concat_ws(' ', c.first_name, c.last_name)),
           'username', c.username, 'email', c.email, 'member_tier', c.member_tier,
           'nectar_points', c.nectar_points, 'completed_tasks', c.completed_tasks,
           'reflections', c.reflections, 'last_activity', c.last_activity) order by c.reflections desc, c.completed_tasks desc), '[]'::jsonb)
    into v_rows
    from (
      select p.id, p.first_name, p.last_name, p.username, p.email, p.member_tier, p.nectar_points,
             (select count(*) from public.user_tasks ut where ut.user_id = p.id and ut.completed_at is not null) as completed_tasks,
             (select count(*) from public.task_sigma_logs l
               where l.user_id = p.id and l.created_at > now() - interval '90 days') as reflections,
             (select max(l.created_at) from public.task_sigma_logs l where l.user_id = p.id) as last_activity
        from public.profiles p
       where not exists (select 1 from public.recognitions r
                          where r.user_id = p.id
                            and r.status not in ('rejected','declined','cancelled','completed','delivery_failed'))
       limit greatest(1, least(coalesce(p_limit, 25), 100))
    ) c
   where c.reflections > 0 or c.completed_tasks > 0;

  return jsonb_build_object('success', true, 'rows', v_rows);
end;
$$;

create or replace function public.admin_get_recognitions(
  p_status text default null,
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
begin
  perform public.assert_admin_can('recognition.read');

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', r.id, 'status', r.status, 'reason', r.reason,
               'member_id', r.user_id,
               'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
               'member_username', p.username, 'member_email', p.email,
               'gift_id', r.gift_id, 'gift_name', g.name, 'gift_sku', g.sku,
               'unit_cost', g.unit_cost,
               'nominated_at', r.nominated_at, 'decided_at', r.decided_at,
               'shipped_at', r.shipped_at, 'delivered_at', r.delivered_at,
               'completed_at', r.completed_at, 'created_at', r.created_at,
               'carrier', r.carrier, 'tracking_number', r.tracking_number,
               'has_address', coalesce(r.address_line1, '') <> ''
             ) as x
        from public.recognitions r
        join public.profiles p on p.id = r.user_id
        join public.gift_catalogue g on g.id = r.gift_id
       where (p_status is null or r.status = p_status)
         and (coalesce(p_search,'') = '' or p.email ilike '%'||p_search||'%'
              or p.username ilike '%'||p_search||'%'
              or concat_ws(' ', p.first_name, p.last_name) ilike '%'||p_search||'%'
              or g.name ilike '%'||p_search||'%')
       order by r.created_at desc
       limit greatest(1, least(coalesce(p_limit,50), 200))
      offset greatest(0, coalesce(p_offset,0))
    ) t;

  select jsonb_build_object(
           'nominated', count(*) filter (where status = 'nominated'),
           'approved', count(*) filter (where status = 'approved'),
           'awaiting_acceptance', count(*) filter (where status = 'awaiting_acceptance'),
           'awaiting_address', count(*) filter (where status = 'awaiting_address'),
           'ready_to_pack', count(*) filter (where status = 'ready_to_pack'),
           'packed', count(*) filter (where status = 'packed'),
           'shipped', count(*) filter (where status = 'shipped'),
           'delivered', count(*) filter (where status = 'delivered'),
           'completed', count(*) filter (where status = 'completed'),
           'rejected', count(*) filter (where status = 'rejected'),
           'declined', count(*) filter (where status = 'declined'),
           'cancelled', count(*) filter (where status = 'cancelled'),
           'delivery_failed', count(*) filter (where status = 'delivery_failed'),
           'total', count(*))
    into v_counts
    from public.recognitions;

  return jsonb_build_object('success', true, 'rows', v_rows, 'counts', v_counts);
end;
$$;

create or replace function public.admin_get_recognition(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.recognitions;
begin
  perform public.assert_admin_can('recognition.read');

  select * into v_rec from public.recognitions where id = p_id;
  if v_rec.id is null then
    return jsonb_build_object('success', false, 'error', 'Recognition not found');
  end if;

  return jsonb_build_object(
    'success', true,
    'recognition', to_jsonb(v_rec),
    'member', (select jsonb_build_object('id', p.id, 'name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
                  'username', p.username, 'email', p.email, 'member_tier', p.member_tier,
                  'nectar_points', p.nectar_points, 'phone_number', p.phone_number, 'address', p.address)
                 from public.profiles p where p.id = v_rec.user_id),
    'gift', (select to_jsonb(g) from public.gift_catalogue g where g.id = v_rec.gift_id),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'ref_id', e.ref_id,
                        'note', e.note, 'created_at', e.created_at) order by e.created_at)
                        from public.recognition_evidence e where e.recognition_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', v.kind, 'from_status', v.from_status,
                       'to_status', v.to_status, 'body', v.body, 'actor_email', v.actor_email,
                       'created_at', v.created_at) order by v.created_at)
                        from public.recognition_events v where v.recognition_id = p_id), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(jsonb_build_object('delta', m.delta, 'kind', m.kind,
                      'stock_after', m.stock_after, 'created_at', m.created_at))
                       from public.gift_stock_movements m where m.recognition_id = p_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_nominate_recognition(
  p_user_id uuid,
  p_gift_id uuid,
  p_reason text,
  p_evidence jsonb default null,
  p_review_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.recognitions;
  v_member public.profiles;
  v_gift public.gift_catalogue;
  v_ev jsonb;
begin
  perform public.assert_admin_can('recognition.approve');

  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A nomination reason is required');
  end if;

  select * into v_member from public.profiles where id = p_user_id;
  if v_member.id is null then
    return jsonb_build_object('success', false, 'error', 'Member not found');
  end if;

  select * into v_gift from public.gift_catalogue where id = p_gift_id;
  if v_gift.id is null then
    return jsonb_build_object('success', false, 'error', 'Gift not found');
  end if;
  if not v_gift.is_active then
    return jsonb_build_object('success', false, 'error', 'That gift is not active');
  end if;

  if exists (select 1 from public.recognitions r where r.user_id = p_user_id and r.gift_id = p_gift_id
              and r.status not in ('rejected','declined','cancelled','delivery_failed')) then
    return jsonb_build_object('success', false, 'error', 'This member already has a live award of that gift');
  end if;

  insert into public.recognitions (user_id, gift_id, status, reason, nominated_by, nominated_at)
  values (p_user_id, p_gift_id, 'nominated', p_reason, auth.uid(), now())
  returning * into v_rec;

  insert into public.recognition_events (recognition_id, actor_id, actor_email, kind, to_status, body)
  values (v_rec.id, auth.uid(), public.admin_actor_email(), 'nominated', 'nominated', p_reason);

  if p_evidence is not null and jsonb_typeof(p_evidence) = 'array' then
    for v_ev in select * from jsonb_array_elements(p_evidence) loop
      if coalesce(v_ev->>'kind','') in ('reflection','sigma_log','task','milestone','token','note') then
        insert into public.recognition_evidence (recognition_id, kind, ref_id, note, added_by)
        values (v_rec.id, v_ev->>'kind', nullif(v_ev->>'ref_id',''), nullif(v_ev->>'note',''), auth.uid());
      end if;
    end loop;
  end if;

  if p_review_id is not null then
    update public.member_reviews
       set nominated_recognition_id = v_rec.id, status = 'reviewed',
           reviewer_id = coalesce(reviewer_id, auth.uid()),
           reviewed_at = coalesce(reviewed_at, now())
     where id = p_review_id;
    insert into public.member_review_events (review_id, actor_id, actor_email, kind, to_status, body)
    values (p_review_id, auth.uid(), public.admin_actor_email(), 'recognition',
            (select status from public.member_reviews where id = p_review_id),
            'Recognition nominated: ' || v_gift.name);
  end if;

  perform public.log_admin_action('recognition.nominate', 'recognition', v_rec.id::text, null,
      jsonb_build_object('member_id', p_user_id, 'gift_id', p_gift_id), p_reason);

  return jsonb_build_object('success', true, 'recognition_id', v_rec.id, 'status', v_rec.status);
end;
$$;

create or replace function public.admin_decide_recognition(
  p_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.recognitions;
  v_after public.recognitions;
  v_new text;
  v_notif bigint;
  v_mail boolean;
begin
  perform public.assert_admin_can('recognition.approve');

  if p_decision not in ('approve','reject') then
    return jsonb_build_object('success', false, 'error', 'Decision must be approve or reject');
  end if;
  if p_decision = 'reject' and coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A reason is required to reject a nomination');
  end if;

  select * into v_before from public.recognitions where id = p_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Recognition not found');
  end if;
  if v_before.status <> 'nominated' then
    return jsonb_build_object('success', false, 'error', 'Only a nominated recognition can be decided (currently ' || v_before.status || ')');
  end if;

  if p_decision = 'reject' then
    update public.recognitions
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = p_reason
     where id = p_id returning * into v_after;
    insert into public.recognition_events (recognition_id, actor_id, actor_email, kind, from_status, to_status, body)
    values (p_id, auth.uid(), public.admin_actor_email(), 'rejected', 'nominated', 'rejected', p_reason);
    perform public.log_admin_action('recognition.reject', 'recognition', p_id::text,
        jsonb_build_object('status','nominated'), jsonb_build_object('status','rejected'), p_reason);
    return jsonb_build_object('success', true, 'status', 'rejected');
  end if;

  -- Approved: notify the member that a gift is waiting for them to accept.
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('send_email','queue_email')) into v_mail;

  update public.recognitions
     set status = 'awaiting_acceptance', decided_by = auth.uid(), decided_at = now(),
         decision_note = p_reason, notified_at = now()
   where id = p_id returning * into v_after;

  insert into public.admin_notifications (user_id, kind, title, body, related_type, related_id, channel,
                                          delivery_status, delivery_error, created_by)
  values (v_after.user_id, 'recognition.approved', 'A gift is waiting for you',
          'The Hive team would like to send you something. Open your profile to accept it.',
          'recognition', p_id::text, 'in_app',
          case when v_mail then 'queued' else 'not_configured' end,
          case when v_mail then null else 'No mail transport is configured, so this stays in-app only.' end,
          auth.uid())
  returning id into v_notif;

  insert into public.recognition_events (recognition_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(), 'notified', 'nominated', 'awaiting_acceptance',
          coalesce(nullif(p_reason,''), 'Nomination approved'));

  perform public.log_admin_action('recognition.approve', 'recognition', p_id::text,
      jsonb_build_object('status','nominated'), jsonb_build_object('status','awaiting_acceptance'), p_reason);

  return jsonb_build_object('success', true, 'status', 'awaiting_acceptance', 'notification_id', v_notif,
                            'delivery_status', case when v_mail then 'queued' else 'not_configured' end);
end;
$$;

-- The fulfilment machine. One entry point for every move so each step carries
-- its own validation, its own history row and, where money/stock is involved,
-- its own stock movement.
create or replace function public.admin_advance_recognition(
  p_id uuid,
  p_status text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.recognitions;
  v_after public.recognitions;
  v_rank_before int;
  v_rank_after int;
  v_gift public.gift_catalogue;
  v_allocated boolean;
  v_returned boolean;
  v_stock int;
  v_reason text;
begin
  perform public.assert_admin_can('fulfilment.manage');

  if p_status not in ('awaiting_acceptance','awaiting_address','ready_to_pack','packed','shipped',
                      'delivered','completed','declined','cancelled','delivery_failed') then
    return jsonb_build_object('success', false, 'error', 'Unknown target status: ' || coalesce(p_status,'null'));
  end if;

  select * into v_before from public.recognitions where id = p_id;
  if v_before.id is null then
    return jsonb_build_object('success', false, 'error', 'Recognition not found');
  end if;
  if v_before.status in ('rejected','declined','cancelled','completed') then
    return jsonb_build_object('success', false, 'error', 'This recognition is closed (' || v_before.status || ')');
  end if;

  v_rank_before := case v_before.status
    when 'awaiting_acceptance' then 1 when 'awaiting_address' then 2 when 'ready_to_pack' then 3
    when 'packed' then 4 when 'shipped' then 5 when 'delivered' then 6 when 'completed' then 7
    when 'approved' then 1 else 0 end;
  v_rank_after := case p_status
    when 'awaiting_acceptance' then 1 when 'awaiting_address' then 2 when 'ready_to_pack' then 3
    when 'packed' then 4 when 'shipped' then 5 when 'delivered' then 6 when 'completed' then 7 else 0 end;

  -- Terminal branches.
  if p_status in ('cancelled','delivery_failed','declined') then
    v_reason := coalesce(nullif(p_payload->>'reason',''), nullif(p_payload->>'failure_reason',''));
    if coalesce(trim(v_reason), '') = '' then
      return jsonb_build_object('success', false, 'error', 'A reason is required for ' || p_status);
    end if;
    if p_status = 'declined' and v_before.status <> 'awaiting_acceptance' then
      return jsonb_build_object('success', false, 'error', 'A gift can only be declined while it is awaiting acceptance');
    end if;
    if p_status = 'delivery_failed' and v_rank_before < 4 then
      return jsonb_build_object('success', false, 'error', 'A delivery cannot fail before the parcel is packed');
    end if;
    if p_status = 'cancelled' and v_rank_before >= 4 then
      return jsonb_build_object('success', false, 'error', 'A packed parcel must be closed as delivery_failed, not cancelled');
    end if;

    -- Give stock back if this recognition had consumed any.
    select exists (select 1 from public.gift_stock_movements m
                    where m.recognition_id = p_id and m.kind = 'allocation') into v_allocated;
    select exists (select 1 from public.gift_stock_movements m
                    where m.recognition_id = p_id and m.kind = 'return') into v_returned;
    if v_allocated and not v_returned then
      update public.gift_catalogue set stock_quantity = stock_quantity + 1 where id = v_before.gift_id
      returning stock_quantity into v_stock;
      insert into public.gift_stock_movements (gift_id, delta, stock_after, kind, recognition_id, note, actor_id, actor_email)
      values (v_before.gift_id, 1, v_stock, 'return', p_id, 'Award closed: ' || p_status, auth.uid(), public.admin_actor_email());
    end if;

    update public.recognitions
       set status = p_status,
           declined_at = case when p_status = 'declined' then now() else declined_at end,
           decline_reason = case when p_status = 'declined' then v_reason else decline_reason end,
           failure_reason = case when p_status = 'delivery_failed' then v_reason else failure_reason end,
           decision_note = case when p_status = 'cancelled' then v_reason else decision_note end
     where id = p_id returning * into v_after;

    insert into public.recognition_events (recognition_id, actor_id, actor_email, kind, from_status, to_status, body)
    values (p_id, auth.uid(), public.admin_actor_email(),
            case p_status when 'declined' then 'declined' when 'cancelled' then 'cancelled' else 'failed' end,
            v_before.status, p_status, v_reason);

    perform public.log_admin_action('recognition.' || p_status, 'recognition', p_id::text,
        jsonb_build_object('status', v_before.status), jsonb_build_object('status', p_status), v_reason);

    return jsonb_build_object('success', true, 'status', p_status, 'stock_returned', v_allocated and not v_returned);
  end if;

  -- Forward moves. Skipping forward is allowed (an approval can jump straight to
  -- ready_to_pack when the address is already on file) but never backwards, so
  -- a parcel cannot be un-shipped by accident.
  if v_rank_after <= v_rank_before then
    return jsonb_build_object('success', false, 'error', 'Cannot move backwards from ' || v_before.status || ' to ' || p_status);
  end if;

  if p_status = 'awaiting_address' then
    if not coalesce((p_payload->>'accepted')::boolean, false) and v_before.accepted_at is null then
      return jsonb_build_object('success', false, 'error', 'The member must accept before an address is collected');
    end if;
  end if;

  if p_status in ('ready_to_pack','packed','shipped','delivered','completed') then
    if coalesce(trim(coalesce(p_payload->>'address_line1', v_before.address_line1)), '') = '' then
      return jsonb_build_object('success', false, 'error', 'A delivery address is required before this step');
    end if;
    -- Consent can be recorded on this same call (the admin ticks the box after
    -- the member agrees on the phone or by email) or on an earlier one.
    if coalesce(trim(coalesce(p_payload->>'consent_at', v_before.consent_at::text, '')), '') = ''
       and coalesce(lower(p_payload->>'consent'), '') not in ('true','t','yes','1','on') then
      return jsonb_build_object('success', false, 'error', 'Member consent to share delivery details is required');
    end if;
  end if;

  if p_status = 'ready_to_pack' then
    perform public.assert_admin_can('fulfilment.manage');
    select * into v_gift from public.gift_catalogue where id = v_before.gift_id;
    if v_gift.stock_quantity < 1 then
      return jsonb_build_object('success', false, 'error',
        format('No stock left for %s. Restock before packing this award.', v_gift.name));
    end if;
  end if;

  if p_status = 'shipped' and (coalesce(trim(p_payload->>'carrier'), v_before.carrier, '') = ''
                               or coalesce(trim(p_payload->>'tracking_number'), v_before.tracking_number, '') = '') then
    return jsonb_build_object('success', false, 'error', 'Carrier and tracking number are required to mark a parcel shipped');
  end if;

  update public.recognitions
     set status = p_status,
         accepted_at = case when p_status = 'awaiting_address' then coalesce(accepted_at, now()) else accepted_at end,
         consent_at = case when lower(coalesce(p_payload->>'consent','')) in ('true','t','yes','1','on')
                             or p_payload ? 'consent_at'
                           then coalesce(consent_at, now()) else consent_at end,
         recipient_name = coalesce(nullif(p_payload->>'recipient_name',''), recipient_name),
         address_line1 = coalesce(nullif(p_payload->>'address_line1',''), address_line1),
         address_line2 = coalesce(nullif(p_payload->>'address_line2',''), address_line2),
         suburb = coalesce(nullif(p_payload->>'suburb',''), suburb),
         state = coalesce(nullif(p_payload->>'state',''), state),
         postcode = coalesce(nullif(p_payload->>'postcode',''), postcode),
         country = coalesce(nullif(p_payload->>'country',''), country),
         phone = coalesce(nullif(p_payload->>'phone',''), phone),
         packing_note = coalesce(nullif(p_payload->>'packing_note',''), packing_note),
         packed_by = case when p_status = 'packed' then auth.uid() else packed_by end,
         packed_at = case when p_status = 'packed' then coalesce(packed_at, now()) else packed_at end,
         carrier = coalesce(nullif(p_payload->>'carrier',''), carrier),
         tracking_number = coalesce(nullif(p_payload->>'tracking_number',''), tracking_number),
         tracking_url = coalesce(nullif(p_payload->>'tracking_url',''), tracking_url),
         shipped_at = case when p_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end,
         delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
         completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else completed_at end
   where id = p_id
  returning * into v_after;

  -- Allocate stock exactly once, when the award stops being a plan and starts
  -- being a parcel to pack.
  if p_status in ('ready_to_pack','packed','shipped','delivered','completed') then
    select exists (select 1 from public.gift_stock_movements m
                    where m.recognition_id = p_id and m.kind = 'allocation') into v_allocated;
    if not v_allocated then
      select stock_quantity into v_stock from public.gift_catalogue where id = v_after.gift_id for update;
      if v_stock < 1 then
        return jsonb_build_object('success', false, 'error', 'No stock left for that gift');
      end if;
      update public.gift_catalogue set stock_quantity = v_stock - 1 where id = v_after.gift_id
      returning stock_quantity into v_stock;
      insert into public.gift_stock_movements (gift_id, delta, stock_after, kind, recognition_id, note, actor_id, actor_email)
      values (v_after.gift_id, -1, v_stock, 'allocation', p_id, 'Allocated to award', auth.uid(), public.admin_actor_email());
    end if;
  end if;

  insert into public.recognition_events (recognition_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(),
          case p_status when 'awaiting_address' then 'accepted' when 'ready_to_pack' then 'address'
                        when 'packed' then 'packed' when 'shipped' then 'shipped'
                        when 'delivered' then 'delivered' else 'note' end,
          v_before.status, p_status, coalesce(nullif(p_payload->>'note',''), nullif(p_payload->>'packing_note','')));

  perform public.log_admin_action('recognition.' || p_status, 'recognition', p_id::text,
      jsonb_build_object('status', v_before.status), jsonb_build_object('status', p_status), null);

  return jsonb_build_object('success', true, 'status', v_after.status);
end;
$$;

-- ============================================================================
-- RECOGNITION DASHBOARD
-- ============================================================================
create or replace function public.admin_get_recognition_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb;
  v_spend jsonb;
  v_low_stock jsonb;
  v_ready jsonb;
begin
  perform public.assert_admin_can('recognition.read');

  select jsonb_build_object(
           'awaiting_decision', count(*) filter (where status = 'nominated'),
           'in_progress', count(*) filter (where status in ('approved','awaiting_acceptance','awaiting_address','ready_to_pack','packed','shipped')),
           'awaiting_member', count(*) filter (where status in ('awaiting_acceptance','awaiting_address')),
           'to_pack', count(*) filter (where status = 'ready_to_pack'),
           'in_transit', count(*) filter (where status = 'shipped'),
           'delivered', count(*) filter (where status = 'delivered'),
           'completed', count(*) filter (where status = 'completed'),
           'closed_unsent', count(*) filter (where status in ('rejected','declined','cancelled','delivery_failed')),
           'total', count(*))
    into v_counts
    from public.recognitions;

  select jsonb_build_object(
           'committed', coalesce(sum(g.unit_cost) filter (where r.status in ('ready_to_pack','packed','shipped','delivered','completed')), 0),
           'delivered', coalesce(sum(g.unit_cost) filter (where r.status in ('delivered','completed')), 0),
           'awarded_count', count(*) filter (where r.status in ('ready_to_pack','packed','shipped','delivered','completed')))
    into v_spend
    from public.recognitions r join public.gift_catalogue g on g.id = r.gift_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'sku', g.sku,
                  'stock_quantity', g.stock_quantity, 'unit_cost', g.unit_cost, 'is_active', g.is_active)
                  order by g.stock_quantity), '[]'::jsonb)
    into v_low_stock
    from public.gift_catalogue g
   where g.is_active and g.stock_quantity <= 2;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'status', r.status, 'member_id', r.user_id,
           'member_name', trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)),
           'member_email', p.email, 'gift_name', g.name, 'created_at', r.created_at)
           order by r.created_at), '[]'::jsonb)
    into v_ready
    from public.recognitions r
    join public.profiles p on p.id = r.user_id
    join public.gift_catalogue g on g.id = r.gift_id
   where r.status in ('nominated','ready_to_pack');

  return jsonb_build_object('success', true, 'counts', v_counts, 'spend', v_spend,
                            'low_stock', v_low_stock, 'needs_action', v_ready);
end;
$$;

commit;
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
