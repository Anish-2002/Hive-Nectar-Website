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
