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
