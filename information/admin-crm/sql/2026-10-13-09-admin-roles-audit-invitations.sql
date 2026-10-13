-- ============================================================================
-- 09 — ADMIN ROLES, EMAIL INVITATIONS, AUDIT LOG
-- Part 1/3: tables + seeds. Additive; nothing existing is altered.
-- ============================================================================
-- Why these three together: every later module (member review, support,
-- recognition/fulfilment, nectar ledger) has to answer "who did this, when" and
-- "is this person allowed to" -- so the audit trail and the role model must
-- exist before the features that write to them.

begin;

-- ---------------------------------------------------------------- roles ----
-- One row per role. Permissions are data, not code, so a Super Admin can adjust
-- them from the CRM without a deployment.
create table if not exists public.admin_roles (
    role_key    text primary key,
    label       text not null,
    rank        integer not null default 100,
    permissions text[] not null default '{}',
    description text,
    created_at  timestamptz not null default now()
);

insert into public.admin_roles (role_key, label, rank, permissions, description) values
  ('super_admin',        'Super Admin',              10, '{team.manage,audit.read,member.write,nectar.adjust,review.decide,support.manage,support.reply,content.publish,cms.write,recognition.approve,fulfilment.manage,billing.read,billing.manage,settings.write,export.data,health.read,read.all}', 'Full control including team, permissions and destructive operations.'),
  ('administrator',      'Administrator',            20, '{audit.read,member.write,nectar.adjust,review.decide,support.manage,support.reply,content.publish,cms.write,recognition.approve,fulfilment.manage,billing.read,settings.write,export.data,health.read,read.all}', 'Day-to-day operations. Cannot change team roles or permissions.'),
  ('member_reviewer',    'Member Reviewer',          30, '{review.decide,member.read,review.read,export.data}', 'Reviews reflections, Sigma logs and member contributions.'),
  ('support_agent',      'Support Agent',            40, '{support.reply,support.read,member.read,read.all}', 'Handles the support inbox. No billing, no destructive operations.'),
  ('fulfilment_manager', 'Rewards / Fulfilment',     45, '{recognition.approve,fulfilment.manage,member.read,export.data}', 'Approves recognition and manages gift stock, packing and tracking.'),
  ('content_editor',     'Content Editor',           50, '{content.publish,cms.write,read.all}', 'Communication board, CMS pages, media library.'),
  ('analyst',            'Read-Only Analyst',        60, '{read.all,audit.read,billing.read,health.read,export.data}', 'Read-only access to dashboards, reports and audit history.')
on conflict (role_key) do update
  set label = excluded.label,
      rank = excluded.rank,
      permissions = excluded.permissions,
      description = excluded.description;

-- ------------------------------------------------------- team membership ----
-- The authoritative "who is an admin" record. public.admin_users (the flat email
-- allowlist) stays in place untouched: public.is_admin() keeps working exactly as
-- before, so none of the fifty-plus existing admin RPCs change behaviour.
create table if not exists public.admin_team_members (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null unique references public.profiles(id) on delete cascade,
    role_key     text not null references public.admin_roles(role_key),
    status       text not null default 'active' check (status in ('active','suspended')),
    invited_by   uuid references public.profiles(id) on delete set null,
    joined_at    timestamptz not null default now(),
    last_seen_at timestamptz,
    notes        text
);

-- Seed from the existing allowlist so the current administrator becomes the
-- first Super Admin instead of being locked out.
insert into public.admin_team_members (user_id, role_key, status, notes)
select p.id, 'super_admin', 'active', 'Seeded from admin_users allowlist'
from public.admin_users a
join public.profiles p on lower(p.email) = lower(a.email)
on conflict (user_id) do nothing;

-- ----------------------------------------------------------- invitations ----
-- Only the SHA-256 hash of the token is stored, so a database read cannot be
-- replayed into an admin account.
create table if not exists public.admin_invitations (
    id          uuid primary key default gen_random_uuid(),
    email       text not null,
    role_key    text not null references public.admin_roles(role_key),
    token_hash  text not null unique,
    invited_by  uuid references public.profiles(id) on delete set null,
    note        text,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null default (now() + interval '7 days'),
    accepted_at timestamptz,
    accepted_by uuid references public.profiles(id) on delete set null,
    revoked_at  timestamptz,
    revoked_by  uuid references public.profiles(id) on delete set null
);
create index if not exists admin_invitations_email_idx on public.admin_invitations (lower(email));

commit;
-- ============================================================================
-- 09 — Part 2/3: audit log + permission helpers
-- ============================================================================
begin;

-- ------------------------------------------------------------- audit log ----
create table if not exists public.admin_action_logs (
    id          bigserial primary key,
    actor_id    uuid references public.profiles(id) on delete set null,
    actor_email text,
    action      text not null,
    target_type text,
    target_id   text,
    before_data jsonb,
    after_data  jsonb,
    reason      text,
    created_at  timestamptz not null default now()
);
create index if not exists admin_action_logs_created_idx on public.admin_action_logs (created_at desc);
create index if not exists admin_action_logs_actor_idx   on public.admin_action_logs (actor_id, created_at desc);
create index if not exists admin_action_logs_action_idx  on public.admin_action_logs (action, created_at desc);
create index if not exists admin_action_logs_target_idx  on public.admin_action_logs (target_type, target_id);

-- --------------------------------------------------------------- helpers ----
-- The role of the calling administrator. Anyone on the legacy admin_users
-- allowlist who is not (yet) in admin_team_members is treated as a Super Admin:
-- that keeps the existing admin surface working and cannot lock anyone out.
create or replace function public.admin_role_of(p_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role_key from public.admin_team_members m
      where m.user_id = p_user_id and m.status = 'active'),
    case when public.is_admin(p_user_id) then 'super_admin' end
  );
$$;

-- Permission check. Accepts one permission key or several (any-of).
-- 'read.all' is a READ grant: it satisfies 'read.all' itself and any '*.read'
-- permission. It must never satisfy a write permission, or a read-only analyst
-- would pass the write guards.
create or replace function public.admin_can(p_perm text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
       when r.role_key = 'super_admin'                    then true
       when p_perm = any(r.permissions)                   then true
       when 'read.all' = any(r.permissions)
            and (p_perm = 'read.all' or p_perm like '%.read') then true
       else false
     end
       from public.admin_roles r
      where r.role_key = public.admin_role_of(p_user_id)),
    false
  );
$$;

-- Raises unless the caller holds the permission. Used by the RPCs below and by
-- every module added after this one.
create or replace function public.assert_admin_can(p_perm text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.admin_ok() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if not public.admin_can(p_perm) then
    raise exception 'Your role does not include the "%" permission', p_perm using errcode = '42501';
  end if;
end;
$$;

-- Writes one audit row. SECURITY DEFINER so any module can call it without
-- needing insert rights of its own. Never raises: an audit failure must not roll
-- back the operation the administrator actually asked for.
create or replace function public.log_admin_action(
    p_action      text,
    p_target_type text default null,
    p_target_id   text default null,
    p_before      jsonb default null,
    p_after       jsonb default null,
    p_reason      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  my_email  text;
  new_id    bigint;
begin
  begin
    select email into my_email from public.profiles where id = me;
    insert into public.admin_action_logs (actor_id, actor_email, action, target_type, target_id, before_data, after_data, reason)
    values (me, my_email, p_action, p_target_type, p_target_id, p_before, p_after, p_reason)
    returning id into new_id;
  exception when others then
    return jsonb_build_object('success', false, 'error', SQLERRM);
  end;
  return jsonb_build_object('success', true, 'id', new_id);
end;
$$;

-- Audit trigger for the team and invitation tables, so a change made through any
-- path (RPC, dashboard, script) still leaves a trail.
create or replace function public.tg_audit_admin_tables()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb;
begin
  rec := case when TG_OP = 'DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
  insert into public.admin_action_logs (actor_id, actor_email, action, target_type, target_id, before_data, after_data)
  values (
    auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    lower(TG_TABLE_NAME) || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    coalesce(rec->>'id', rec->>'user_id'),
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) end,
    case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) end
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists audit_admin_team_members on public.admin_team_members;
create trigger audit_admin_team_members
  after insert or update or delete on public.admin_team_members
  for each row execute function public.tg_audit_admin_tables();

drop trigger if exists audit_admin_invitations on public.admin_invitations;
create trigger audit_admin_invitations
  after insert or update or delete on public.admin_invitations
  for each row execute function public.tg_audit_admin_tables();

commit;
-- ============================================================================
-- 09 — Part 3/3a: team, invitation and role RPCs
-- ============================================================================
begin;

-- Everything the Admin Team screen needs in one call.
create or replace function public.admin_get_team_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if auth.uid() is null or not public.admin_ok() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'me', jsonb_build_object(
      'user_id', me,
      'email', (select email from public.profiles where id = me),
      'role_key', public.admin_role_of(me),
      'label', (select label from public.admin_roles where role_key = public.admin_role_of(me)),
      'permissions', coalesce((select to_jsonb(permissions) from public.admin_roles where role_key = public.admin_role_of(me)), '[]'::jsonb),
      'can_manage', public.admin_can('team.manage'),
      'can_read_audit', public.admin_can('audit.read')
    ),
    'roles', coalesce((select jsonb_agg(jsonb_build_object(
        'role_key', r.role_key, 'label', r.label, 'rank', r.rank,
        'permissions', to_jsonb(r.permissions), 'description', r.description
      ) order by r.rank) from public.admin_roles r), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'role_key', m.role_key, 'status', m.status,
        'email', p.email, 'first_name', p.first_name, 'last_name', p.last_name,
        'username', p.username, 'nectar_points', p.nectar_points,
        'member_tier', p.member_tier, 'joined_at', m.joined_at,
        'invited_by_email', (select email from public.profiles where id = m.invited_by),
        'last_seen_at', m.last_seen_at, 'notes', m.notes
      ) order by r2.rank, p.email)
      from public.admin_team_members m
      join public.profiles p on p.id = m.user_id
      join public.admin_roles r2 on r2.role_key = m.role_key), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'email', i.email, 'role_key', i.role_key,
        'role_label', (select label from public.admin_roles where role_key = i.role_key),
        'invited_by_email', (select email from public.profiles where id = i.invited_by),
        'note', i.note, 'created_at', i.created_at, 'expires_at', i.expires_at,
        'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
        'status', case
            when i.revoked_at is not null then 'revoked'
            when i.accepted_at is not null then 'accepted'
            when i.expires_at < now() then 'expired'
            else 'pending' end
      ) order by i.created_at desc)
      from public.admin_invitations i), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Create an invitation. Returns the plaintext token exactly once; only its hash
-- is stored. The admin copies the link out (no mail server is wired yet).
create or replace function public.admin_invite_admin(
    p_email    text,
    p_role_key text,
    p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token text;
  v_id    uuid;
  v_exp   timestamptz := now() + interval '7 days';
begin
  perform public.assert_admin_can('team.manage');

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('success', false, 'error', 'A valid email address is required.');
  end if;
  if not exists (select 1 from public.admin_roles where role_key = p_role_key) then
    return jsonb_build_object('success', false, 'error', 'Unknown role: ' || coalesce(p_role_key, 'null'));
  end if;
  if exists (select 1 from public.admin_team_members m join public.profiles p on p.id = m.user_id
             where lower(p.email) = v_email and m.status = 'active' and m.role_key = p_role_key) then
    return jsonb_build_object('success', false, 'error', 'That person already holds this role.');
  end if;

  -- 64 hex characters of entropy from two UUIDs: no extension dependency, so the
  -- function keeps working with search_path pinned to public.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.admin_invitations (email, role_key, token_hash, invited_by, note, expires_at)
  values (v_email, p_role_key, encode(sha256(v_token::bytea), 'hex'), me, p_note, v_exp)
  returning id into v_id;

  perform public.log_admin_action('team.invite_created', 'admin_invitations', v_id::text,
    null, jsonb_build_object('email', v_email, 'role_key', p_role_key, 'expires_at', v_exp), p_note);

  return jsonb_build_object(
    'success', true, 'invitation_id', v_id, 'email', v_email,
    'role_key', p_role_key, 'token', v_token,
    'accept_url', '/admin?invite=' || v_token,
    'expires_at', v_exp,
    'email_sent', false,
    'email_note', 'Mail server not connected: copy the link and send it yourself for now.'
  );
end;
$$;

create or replace function public.admin_revoke_invitation(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  inv public.admin_invitations;
begin
  perform public.assert_admin_can('team.manage');

  select * into inv from public.admin_invitations where id = p_id for update;
  if inv.id is null then
    return jsonb_build_object('success', false, 'error', 'Invitation not found.');
  end if;
  if inv.accepted_at is not null then
    return jsonb_build_object('success', false, 'error', 'Invitation was already accepted.');
  end if;
  if inv.revoked_at is not null then
    return jsonb_build_object('success', true, 'already', true);
  end if;

  update public.admin_invitations
     set revoked_at = now(), revoked_by = me
   where id = p_id;

  perform public.log_admin_action('team.invite_revoked', 'admin_invitations', p_id::text,
    jsonb_build_object('email', inv.email, 'role_key', inv.role_key), null, p_reason);

  return jsonb_build_object('success', true);
end;
$$;

-- Accepted by the invited person, signed in with the invited address.
create or replace function public.admin_accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  my_mail text;
  inv    public.admin_invitations;
begin
  if me is null then
    return jsonb_build_object('success', false, 'error', 'You must be signed in.');
  end if;

  select email into my_mail from public.profiles where id = me;
  if my_mail is null then
    return jsonb_build_object('success', false, 'error', 'No profile found for your account.');
  end if;

  select * into inv from public.admin_invitations
   where token_hash = encode(sha256(coalesce(p_token, '')::bytea), 'hex') for update;

  if inv.id is null then
    return jsonb_build_object('success', false, 'error', 'That invitation link is not valid.');
  end if;
  if inv.revoked_at is not null then
    return jsonb_build_object('success', false, 'error', 'That invitation was revoked.');
  end if;
  if inv.accepted_at is not null then
    return jsonb_build_object('success', false, 'error', 'That invitation was already used.');
  end if;
  if inv.expires_at < now() then
    return jsonb_build_object('success', false, 'error', 'That invitation has expired.');
  end if;
  if lower(my_mail) <> lower(inv.email) then
    return jsonb_build_object('success', false, 'error',
      'Invitation is for ' || lower(inv.email) || ', but you are signed in as ' || lower(my_mail) || '.');
  end if;

  insert into public.admin_team_members (user_id, role_key, status, invited_by, joined_at)
  values (me, inv.role_key, 'active', inv.invited_by, now())
  on conflict (user_id) do update
    set role_key = excluded.role_key, status = 'active';

  update public.admin_invitations
     set accepted_at = now(), accepted_by = me
   where id = inv.id;

  perform public.log_admin_action('team.invite_accepted', 'admin_team_members', me::text,
    null, jsonb_build_object('email', my_mail, 'role_key', inv.role_key), null);

  return jsonb_build_object('success', true, 'role_key', inv.role_key,
    'label', (select label from public.admin_roles where role_key = inv.role_key));
end;
$$;

-- Pending invitations for the signed-in address, so an invited administrator can
-- accept without the original link.
create or replace function public.admin_get_my_pending_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  my_mail text;
begin
  if me is null then return '[]'::jsonb; end if;
  select email into my_mail from public.profiles where id = me;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', i.id, 'role_key', i.role_key,
      'role_label', (select label from public.admin_roles where role_key = i.role_key),
      'note', i.note, 'created_at', i.created_at, 'expires_at', i.expires_at,
      'invited_by_email', (select email from public.profiles where id = i.invited_by)))
    from public.admin_invitations i
    where lower(i.email) = lower(my_mail)
      and i.accepted_at is null and i.revoked_at is null and i.expires_at >= now()
  ), '[]'::jsonb);
end;
$$;

commit;
-- ============================================================================
-- 09 — Part 3/3b: role changes, audit reads, grants, RLS
-- ============================================================================
begin;

-- Change someone's role. Refuses to remove the last active Super Admin.
create or replace function public.admin_set_team_role(p_user_id uuid, p_role_key text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  prev     text;
  supers   integer;
begin
  perform public.assert_admin_can('team.manage');

  if not exists (select 1 from public.admin_roles where role_key = p_role_key) then
    return jsonb_build_object('success', false, 'error', 'Unknown role: ' || coalesce(p_role_key, 'null'));
  end if;
  if not exists (select 1 from public.admin_team_members where user_id = p_user_id) then
    return jsonb_build_object('success', false, 'error', 'That person is not on the admin team.');
  end if;

  select role_key into prev from public.admin_team_members where user_id = p_user_id;
  if prev = p_role_key then
    return jsonb_build_object('success', true, 'unchanged', true);
  end if;

  if prev = 'super_admin' then
    select count(*) into supers from public.admin_team_members
     where role_key = 'super_admin' and status = 'active';
    if supers <= 1 then
      return jsonb_build_object('success', false,
        'error', 'This is the only active Super Admin. Give someone else that role first.');
    end if;
  end if;

  update public.admin_team_members set role_key = p_role_key where user_id = p_user_id;

  perform public.log_admin_action('team.role_changed', 'admin_team_members', p_user_id::text,
    jsonb_build_object('role_key', prev), jsonb_build_object('role_key', p_role_key), p_reason);

  return jsonb_build_object('success', true, 'role_key', p_role_key);
end;
$$;

-- Suspend or reinstate. Same last-Super-Admin guard.
create or replace function public.admin_set_team_status(p_user_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  prev   text;
  role   text;
  supers integer;
begin
  perform public.assert_admin_can('team.manage');

  if p_status not in ('active','suspended') then
    return jsonb_build_object('success', false, 'error', 'Status must be active or suspended.');
  end if;
  if p_user_id = me and p_status = 'suspended' then
    return jsonb_build_object('success', false, 'error', 'You cannot suspend your own account.');
  end if;

  select status, role_key into prev, role from public.admin_team_members where user_id = p_user_id;
  if prev is null then
    return jsonb_build_object('success', false, 'error', 'That person is not on the admin team.');
  end if;
  if prev = p_status then
    return jsonb_build_object('success', true, 'unchanged', true);
  end if;

  if role = 'super_admin' and p_status = 'suspended' then
    select count(*) into supers from public.admin_team_members
     where role_key = 'super_admin' and status = 'active';
    if supers <= 1 then
      return jsonb_build_object('success', false,
        'error', 'This is the only active Super Admin. Promote a replacement first.');
    end if;
  end if;

  update public.admin_team_members set status = p_status where user_id = p_user_id;

  perform public.log_admin_action('team.status_changed', 'admin_team_members', p_user_id::text,
    jsonb_build_object('status', prev), jsonb_build_object('status', p_status), p_reason);

  return jsonb_build_object('success', true, 'status', p_status);
end;
$$;

-- ------------------------------------------------------------ audit read ----
create or replace function public.admin_get_action_logs(
    p_limit       integer default 100,
    p_action      text default null,
    p_actor_id    uuid default null,
    p_target_type text default null,
    p_target_id   text default null,
    p_search      text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  rows_ jsonb;
  total integer;
begin
  perform public.assert_admin_can('audit.read');

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb), count(*)
    into rows_, total
  from (
    select l.id, l.created_at, l.action, l.target_type, l.target_id, l.reason,
           l.actor_id, coalesce(l.actor_email, p.email) as actor_email,
           nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') as actor_name,
           l.before_data, l.after_data
      from public.admin_action_logs l
      left join public.profiles p on p.id = l.actor_id
     where (p_action is null or l.action = p_action)
       and (p_actor_id is null or l.actor_id = p_actor_id)
       and (p_target_type is null or l.target_type = p_target_type)
       and (p_target_id is null or l.target_id = p_target_id)
       and (p_search is null or p_search = '' or
            l.action ilike '%'||p_search||'%' or
            coalesce(l.actor_email,'') ilike '%'||p_search||'%' or
            coalesce(l.target_id,'') ilike '%'||p_search||'%' or
            coalesce(l.reason,'') ilike '%'||p_search||'%')
     order by l.created_at desc
     limit lim
  ) t;

  return jsonb_build_object('rows', rows_, 'count', total, 'limit', lim);
end;
$$;

-- The set of actions available as filters, for the Audit Log screen.
create or replace function public.admin_get_audit_actions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_admin_can('audit.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object('action', a.action, 'count', a.n) order by a.n desc)
    from (select action, count(*)::integer as n from public.admin_action_logs group by action) a
  ), '[]'::jsonb);
end;
$$;

-- Who am I, as an administrator. Used to gate the navigation.
create or replace function public.admin_get_my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  rk text;
begin
  if me is null then
    return jsonb_build_object('is_admin', false);
  end if;
  rk := public.admin_role_of(me);
  return jsonb_build_object(
    'is_admin', public.admin_ok(),
    'user_id', me,
    'email', (select email from public.profiles where id = me),
    'role_key', rk,
    'label', (select label from public.admin_roles where role_key = rk),
    'permissions', coalesce((select to_jsonb(permissions) from public.admin_roles where role_key = rk), '[]'::jsonb),
    'pending_invitations', public.admin_get_my_pending_invitations()
  );
end;
$$;

-- Lets the CRM record a manual note against a record (e.g. "rang the member").
create or replace function public.admin_log_action(
    p_action      text,
    p_target_type text default null,
    p_target_id   text default null,
    p_reason      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.admin_ok() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  return public.log_admin_action(p_action, p_target_type, p_target_id, null, null, p_reason);
end;
$$;

-- ------------------------------------------------------------ RLS + ACL ----
alter table public.admin_roles         enable row level security;
alter table public.admin_team_members  enable row level security;
alter table public.admin_invitations   enable row level security;
alter table public.admin_action_logs   enable row level security;

-- No direct table access from the browser: everything goes through the RPCs
-- above. Administrators may read roles (harmless, needed for the role picker).
drop policy if exists admin_roles_read on public.admin_roles;
create policy admin_roles_read on public.admin_roles
  for select to authenticated using (public.admin_ok());

revoke all on function public.admin_get_team_overview()                from public, anon;
revoke all on function public.admin_invite_admin(text, text, text)     from public, anon;
revoke all on function public.admin_revoke_invitation(uuid, text)      from public, anon;
revoke all on function public.admin_accept_invitation(text)            from public, anon;
revoke all on function public.admin_get_my_pending_invitations()       from public, anon;
revoke all on function public.admin_set_team_role(uuid, text, text)    from public, anon;
revoke all on function public.admin_set_team_status(uuid, text, text)  from public, anon;
revoke all on function public.admin_get_action_logs(integer, text, uuid, text, text, text) from public, anon;
revoke all on function public.admin_get_audit_actions()                from public, anon;
revoke all on function public.admin_get_my_context()                   from public, anon;
revoke all on function public.admin_log_action(text, text, text, text) from public, anon;
revoke all on function public.log_admin_action(text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.assert_admin_can(text) from public, anon;

grant execute on function public.admin_get_team_overview()                to authenticated;
grant execute on function public.admin_invite_admin(text, text, text)     to authenticated;
grant execute on function public.admin_revoke_invitation(uuid, text)      to authenticated;
grant execute on function public.admin_accept_invitation(text)            to authenticated;
grant execute on function public.admin_get_my_pending_invitations()       to authenticated;
grant execute on function public.admin_set_team_role(uuid, text, text)    to authenticated;
grant execute on function public.admin_set_team_status(uuid, text, text)  to authenticated;
grant execute on function public.admin_get_action_logs(integer, text, uuid, text, text, text) to authenticated;
grant execute on function public.admin_get_audit_actions()                to authenticated;
grant execute on function public.admin_get_my_context()                   to authenticated;
grant execute on function public.admin_log_action(text, text, text, text) to authenticated;

grant select on public.admin_roles to authenticated;

commit;

notify pgrst, 'reload schema';
