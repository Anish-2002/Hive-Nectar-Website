-- 2026-10-14-14-mail-transport.sql  (part 1 of 2)
-- Sections: S1 config | S2 outbox table | S3 helpers | S4 queue/send
--           S5 review reply | S6 member notification | S7 ticket reply
--           S8 outbox read | S9 worker claim | S10 result write-back
--           S11 retry | S12 self-test | S13 grants
--
-- Closes the "Email is NOT ready" gap: there was no mail function in the
-- database at all, so admin_reply_to_member / admin_send_member_notification /
-- admin_reply_ticket feature-detected for send_email|queue_email, found nothing,
-- and wrote delivery_status = 'not_configured' with the text "stays in-app only".
-- Every reply and notification was therefore stored in-app and never marked sent.
--
-- This migration adds the missing transport as an OUTBOX, because the project has
-- no pg_net: the database cannot open an outbound HTTP connection. So the database
-- owns queueing + delivery state (the source of truth), and the send-mail edge
-- function (verify_jwt, admin-gated) claims a row, calls Brevo, and writes the
-- provider result back through apply_mail_result(). A row may only ever reach
-- 'sent' when a provider message id came back from Brevo; failures store the
-- verbatim provider error.
--
-- Admin-plane only. No member-facing behaviour, table or policy is changed.
begin;

-- =====================================================================
-- S1. Sender / transport configuration (app_config, editable without deploy)
-- ---------------------------------------------------------------------
-- Sender must be a Brevo-verified address. Values are INSERT-if-absent so an
-- owner edit is never clobbered by re-running this file.
-- =====================================================================
insert into public.app_config (key, value, description) values
  ('sender_email',      'follydevs@gmail.com',            'From address on every CRM email (must be verified in Brevo)'),
  ('sender_name',       'Hive Nectar',                    'From name on every CRM email'),
  ('mail_reply_to',     'follydevs@gmail.com',            'Reply-To address on every CRM email'),
  ('mail_transport',    'brevo',                          'Mail transport. "brevo" sends; anything else queues as skipped'),
  ('mail_enabled',      'true',                           'Master switch for outbound email. false = queue as skipped'),
  ('mail_max_attempts', '3',                              'Delivery attempts before a row stops being retried'),
  ('subject_review_reply',   'A message from the Hive team',                    'Subject for review replies'),
  ('subject_notification',   '{title}',                                          'Subject for member notifications'),
  ('subject_ticket_reply',   'Re: {subject} (ticket {ticket_no})',               'Subject for support replies'),
  ('subject_mail_test',      'Test email from the Hive Nectar admin',            'Subject for the self-test button'),
  ('mail_footer_note',  'You are receiving this because you have a Hive Nectar account.', 'Footer line on every email')
on conflict (key) do nothing;

-- =====================================================================
-- S2. mail_outbox — the delivery ledger
-- ---------------------------------------------------------------------
-- One row per (attempt to send one email). Nothing is emailed without a row,
-- so "was it sent?" is always answerable from the database. No client role
-- gets any grant and there are no RLS policies: the admin UI reads this
-- through gated RPCs only.
-- =====================================================================
create table if not exists public.mail_outbox (
  id                  uuid primary key default gen_random_uuid(),
  to_email            text        not null,
  to_name             text,
  subject             text        not null,
  html                text        not null,
  text_body           text,
  kind                text        not null default 'admin.message',
  related_type        text,
  related_id          text,
  notification_id     bigint      references public.admin_notifications(id) on delete set null,
  support_message_id  uuid        references public.support_messages(id) on delete set null,
  status              text        not null default 'pending'
                      check (status in ('pending','sending','sent','failed','skipped')),
  attempts            integer     not null default 0,
  max_attempts        integer     not null default 3,
  provider            text        not null default 'brevo',
  provider_message_id text,
  error               text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz
);

comment on table public.mail_outbox is
  'Outbound email ledger. status=sent only after a provider message id is written back.';
comment on column public.mail_outbox.status is
  'pending (waiting) | sending (claimed by the worker) | sent | failed (provider refused) | skipped (deliberately not sent)';

create index if not exists mail_outbox_status_idx on public.mail_outbox (status, created_at desc);
create index if not exists mail_outbox_notification_idx on public.mail_outbox (notification_id);
create index if not exists mail_outbox_support_message_idx on public.mail_outbox (support_message_id);

alter table public.mail_outbox enable row level security;
revoke all on public.mail_outbox from public;
revoke all on public.mail_outbox from anon;
revoke all on public.mail_outbox from authenticated;

-- =====================================================================
-- S3. Helpers: permission gate, config lookup, HTML shell, token render
-- =====================================================================
create or replace function public.mail_config(p_key text, p_default text default null)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(nullif((select value from public.app_config where key = p_key), ''), p_default);
$function$;

-- Who may queue, read and flush mail. Mirrors the roles that actually answer
-- members: support managers, support agents, member reviewers, and anyone who
-- can write to a member record. read.all alone is not enough to send as the Hive.
create or replace function public.mail_perm_ok(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p_user is not null and (
           public.admin_can('support.manage', p_user)
        or public.admin_can('support.reply',  p_user)
        or public.admin_can('review.decide',  p_user)
        or public.admin_can('member.write',   p_user)
      );
$function$;

-- A trusted worker may write delivery state without a person behind it: the
-- service role (edge function) and a direct owner connection (verifier harness).
-- session_user, not current_user: inside a SECURITY DEFINER function current_user
-- is always the definer, which would make this check meaningless.
create or replace function public.mail_authorized()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
           when auth.role() = 'service_role' then true
           when session_user in ('postgres', 'supabase_admin') then true
           else public.mail_perm_ok(auth.uid())
         end;
$function$;

create or replace function public.mail_escape(p_text text)
returns text
language sql
immutable
as $function$
  select replace(replace(replace(replace(replace(coalesce(p_text, ''),
           '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$function$;

-- Branded shell. Inline styles only (mail clients strip <style>), no emoji
-- anywhere, and every line readable as plain text if the HTML is stripped.
create or replace function public.mail_shell(p_title text, p_body_html text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select '<!doctype html><html><body style="margin:0;padding:0;background:#f6f4ef;">'
      || '<div style="max-width:560px;margin:0 auto;padding:24px 20px;'
      || 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      || 'color:#2b2b2b;font-size:15px;line-height:1.55;">'
      || '<div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;'
      || 'color:#8a7a4f;padding-bottom:10px;">Hive Nectar</div>'
      || '<div style="background:#ffffff;border:1px solid #e6e0d3;border-radius:12px;padding:22px;">'
      || '<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#1f1f1f;">'
      || public.mail_escape(p_title) || '</h1>'
      || coalesce(p_body_html, '')
      || '</div>'
      || '<div style="padding:14px 4px 0;font-size:12px;color:#8b8b8b;">'
      || public.mail_escape(coalesce(public.mail_config('mail_footer_note',
           'You are receiving this because you have a Hive Nectar account.'), ''))
      || '</div></div></body></html>';
$function$;

create or replace function public.mail_render(p_template text, p_vars jsonb)
returns text
language sql
immutable
as $function$
  select coalesce(
    (select string_agg(
              case when v.key is null then v.chunk
                   else coalesce(p_vars ->> v.key, '')
              end, '')
       from regexp_matches(coalesce(p_template, ''), '\{([a-z_]+)\}|([^{]+)', 'g') as m,
            lateral (select m[1] as key, m[2] as chunk) as v),
    '');
$function$;

create or replace function public.mail_button(p_label text, p_url text)
returns text
language sql
immutable
as $function$
  select case when coalesce(p_url, '') = '' then ''
              else '<p style="margin:18px 0 4px;"><a href="' || public.mail_escape(p_url)
                || '" style="display:inline-block;background:#c8a24a;color:#1f1f1f;'
                || 'text-decoration:none;padding:10px 18px;border-radius:999px;'
                || 'font-weight:600;">' || public.mail_escape(p_label) || '</a></p>'
         end;
$function$;

-- =====================================================================
-- S4. queue_email / send_email — the transport the old code looked for
-- ---------------------------------------------------------------------
-- Both names exist because admin_reply_to_member, admin_send_member_notification
-- and admin_reply_ticket detect mail support with:
--   exists (select 1 from pg_proc ... where proname in ('send_email','queue_email'))
-- send_email is the same operation under the name those call sites expect: the
-- database queues, the edge function transmits. Neither may be executed by a
-- client role; only the DEFINER call sites inside this file use them.
-- =====================================================================
create or replace function public.queue_email(
  p_to_email           text,
  p_to_name            text,
  p_subject            text,
  p_html               text,
  p_text               text        default null,
  p_kind               text        default 'admin.message',
  p_related_type       text        default null,
  p_related_id         text        default null,
  p_notification_id    bigint      default null,
  p_support_message_id uuid        default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_transport text := lower(coalesce(public.mail_config('mail_transport', 'brevo'), 'brevo'));
  v_enabled   text := lower(coalesce(public.mail_config('mail_enabled', 'true'), 'true'));
  v_max       int;
  v_status    text;
  v_error     text;
  v_id        uuid;
begin
  if coalesce(trim(p_to_email), '') = '' then
    return jsonb_build_object('success', false, 'error', 'No recipient address for this message');
  end if;
  if p_to_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('success', false, 'error',
      'Recipient address is not a valid email: ' || p_to_email);
  end if;

  if v_enabled in ('false', '0', 'no', 'off') then
    v_status := 'skipped';
    v_error  := 'Outbound email is switched off (app_config mail_enabled). The message is stored and can be retried.';
  elsif v_transport in ('', 'none', 'null') then
    v_status := 'skipped';
    v_error  := 'No mail transport is configured (app_config mail_transport). The message is stored and can be retried.';
  else
    v_status := 'pending';
  end if;

  v_max := case when coalesce(public.mail_config('mail_max_attempts', '3'), '3') ~ '^[0-9]+$'
                then greatest(1, least(10, (public.mail_config('mail_max_attempts', '3'))::int))
                else 3 end;

  insert into public.mail_outbox (to_email, to_name, subject, html, text_body, kind,
                                  related_type, related_id, notification_id,
                                  support_message_id, status, error, provider,
                                  max_attempts, created_by)
  values (trim(p_to_email), nullif(trim(coalesce(p_to_name, '')), ''),
          coalesce(nullif(trim(p_subject), ''), '(no subject)'),
          coalesce(p_html, ''), p_text, coalesce(nullif(trim(p_kind), ''), 'admin.message'),
          p_related_type, p_related_id, p_notification_id, p_support_message_id,
          v_status, v_error, v_transport, v_max, auth.uid())
  returning id into v_id;

  return jsonb_build_object('success', true, 'mail_id', v_id, 'status', v_status,
                            'queued', v_status = 'pending', 'error', v_error,
                            'provider_message_id', null);
end;
$function$;

create or replace function public.send_email(
  p_to_email           text,
  p_to_name            text,
  p_subject            text,
  p_html               text,
  p_text               text        default null,
  p_kind               text        default 'admin.message',
  p_related_type       text        default null,
  p_related_id         text        default null,
  p_notification_id    bigint      default null,
  p_support_message_id uuid        default null
) returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  select public.queue_email(p_to_email, p_to_name, p_subject, p_html, p_text, p_kind,
                            p_related_type, p_related_id, p_notification_id, p_support_message_id);
$function$;

-- =====================================================================
-- S5. Review reply now queues real email
-- ---------------------------------------------------------------------
-- Replaces the version that wrote delivery_status='not_configured' and the
-- text "No mail transport is configured, so this stays in-app only."
-- The in-app notification row is kept (the member's inbox) AND a mail row is
-- queued; the notification's delivery_status carries the mail status so the
-- admin screen shows the truth, including a hard failure and its reason.
-- =====================================================================
create or replace function public.admin_reply_to_member(
  p_id      uuid,
  p_body    text,
  p_channel text default 'in_app'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rev       public.member_reviews;
  v_email     text;
  v_name      text;
  v_mail      jsonb;
  v_status    text;
  v_error     text;
  v_mail_id   uuid;
  v_subject   text;
  v_notif     bigint;
  v_html      text;
  v_link      text;
begin
  perform public.assert_admin_can('review.decide');

  if coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A reply body is required');
  end if;

  select * into v_rev from public.member_reviews where id = p_id;
  if v_rev.id is null then
    return jsonb_build_object('success', false, 'error', 'Review not found');
  end if;

  select p.email,
         nullif(trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)), '')
    into v_email, v_name
    from public.profiles p where p.id = v_rev.user_id;

  v_link    := coalesce(public.mail_config('site_url', 'https://www.pollenpop.org'),
                        'https://www.pollenpop.org') || '/the-meadow.html';
  v_subject := coalesce(public.mail_config('subject_review_reply', 'A message from the Hive team'),
                        'A message from the Hive team');
  v_html    := public.mail_shell(v_subject,
                 '<p style="margin:0 0 12px;">'
                 || public.mail_escape('Hi ' || coalesce(v_name, 'there') || ',') || '</p>'
                 || '<p style="margin:0 0 12px;">'
                 || public.mail_escape('The Hive team replied about your submission:') || '</p>'
                 || '<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #c8a24a;'
                 || 'background:#faf7f0;white-space:pre-wrap;">' || public.mail_escape(p_body) || '</blockquote>'
                 || '<p style="margin:0;">'
                 || public.mail_escape('Open your submission in the Meadow to read the full thread and reply.')
                 || '</p>'
                 || public.mail_button('Open the Meadow', v_link));

  insert into public.admin_notifications (user_id, kind, title, body, related_type, related_id,
                                          channel, delivery_status, delivery_error, attempts, created_by)
  values (v_rev.user_id, 'review.reply', v_subject, p_body, 'member_review', p_id::text,
          'in_app', 'pending', null, 0, auth.uid())
  returning id into v_notif;

  v_mail := public.queue_email(v_email, v_name, v_subject, v_html,
                               p_body || E'\n\nOpen the Meadow: ' || v_link,
                               'review.reply', 'member_review', p_id::text, v_notif, null);
  v_status := coalesce(v_mail ->> 'status', 'failed');
  v_error  := v_mail ->> 'error';
  v_mail_id := nullif(v_mail ->> 'mail_id', '')::uuid;

  if coalesce((v_mail ->> 'success')::boolean, false) = false then
    v_status := 'failed';
    v_error  := coalesce(v_error, 'The message could not be queued');
  end if;

  update public.admin_notifications
     set delivery_status = v_status, delivery_error = v_error
   where id = v_notif;

  update public.member_reviews
     set member_response = p_body,
         member_response_at = now(),
         member_response_delivery = v_status
   where id = p_id;

  insert into public.member_review_events (review_id, actor_id, actor_email, kind, from_status, to_status, body)
  values (p_id, auth.uid(), public.admin_actor_email(), 'reply', v_rev.status, v_rev.status, p_body);

  perform public.log_admin_action('review.reply', 'member_review', p_id::text, null,
      jsonb_build_object('notification_id', v_notif, 'mail_id', v_mail_id,
                         'delivery', v_status, 'to', v_email), null);

  return jsonb_build_object('success', true, 'notification_id', v_notif,
                            'mail_id', v_mail_id, 'delivery_status', v_status,
                            'delivered', v_status = 'sent', 'error', v_error);
end;
$function$;

-- =====================================================================
-- S6. Member notification now queues real email
-- =====================================================================
create or replace function public.admin_send_member_notification(
  p_user_id uuid,
  p_title   text,
  p_body    text default null,
  p_link    text default null,
  p_kind    text default 'admin.message'
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email   text;
  v_name    text;
  v_mail    jsonb;
  v_status  text;
  v_error   text;
  v_mail_id uuid;
  v_subject text;
  v_id      bigint;
  v_url     text;
  v_html    text;
begin
  perform public.assert_admin_can('member.write');

  if coalesce(trim(p_title), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A title is required');
  end if;

  select p.email,
         nullif(trim(both ' ' from concat_ws(' ', p.first_name, p.last_name)), '')
    into v_email, v_name
    from public.profiles p where p.id = p_user_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Member not found');
  end if;

  v_subject := public.mail_render(coalesce(public.mail_config('subject_notification', '{title}'), '{title}'),
                                  jsonb_build_object('title', p_title, 'name', coalesce(v_name, '')));
  if coalesce(trim(v_subject), '') = '' then v_subject := p_title; end if;

  v_url  := coalesce(nullif(trim(coalesce(p_link, '')), ''),
                     coalesce(public.mail_config('site_url', 'https://www.pollenpop.org'),
                              'https://www.pollenpop.org'));
  v_html := public.mail_shell(v_subject,
              '<p style="margin:0 0 12px;">'
              || public.mail_escape('Hi ' || coalesce(v_name, 'there') || ',') || '</p>'
              || case when coalesce(trim(p_body), '') = '' then ''
                      else '<div style="margin:0 0 12px;white-space:pre-wrap;">'
                           || public.mail_escape(p_body) || '</div>' end
              || public.mail_button('Open Hive Nectar', v_url));

  insert into public.admin_notifications (user_id, kind, title, body, link, channel,
                                          delivery_status, delivery_error, attempts, created_by)
  values (p_user_id, coalesce(nullif(p_kind, ''), 'admin.message'), p_title, p_body, p_link,
          'in_app', 'pending', null, 0, auth.uid())
  returning id into v_id;

  v_mail := public.queue_email(v_email, v_name, v_subject, v_html,
                               nullif(concat_ws(E'\n\n', nullif(trim(coalesce(p_body, '')), ''),
                                                'Open Hive Nectar: ' || v_url), ''),
                               coalesce(nullif(p_kind, ''), 'admin.message'),
                               'member', p_user_id::text, v_id, null);
  v_status := coalesce(v_mail ->> 'status', 'failed');
  v_error  := v_mail ->> 'error';
  v_mail_id := nullif(v_mail ->> 'mail_id', '')::uuid;

  if coalesce((v_mail ->> 'success')::boolean, false) = false then
    v_status := 'failed';
    v_error  := coalesce(v_error, 'The message could not be queued');
  end if;

  update public.admin_notifications
     set delivery_status = v_status, delivery_error = v_error
   where id = v_id;

  perform public.log_admin_action('member.notify', 'member', p_user_id::text, null,
      jsonb_build_object('notification_id', v_id, 'mail_id', v_mail_id, 'delivery', v_status), p_title);

  return jsonb_build_object('success', true, 'notification_id', v_id, 'mail_id', v_mail_id,
                            'delivery_status', v_status, 'delivered', v_status = 'sent',
                            'error', v_error);
end;
$function$;

-- =====================================================================
-- S7. Support reply now queues real email to the requester
-- ---------------------------------------------------------------------
-- Internal notes stay internal ('not_attempted', no mail row). An outbound
-- reply queues mail to requester_email and the support_messages row carries
-- the mail status, so the ticket view stops claiming a reply was delivered
-- when nothing left the building.
-- =====================================================================
create or replace function public.admin_reply_ticket(
  p_ticket_id   uuid,
  p_body        text,
  p_internal    boolean default false,
  p_template_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_t       public.support_tickets;
  v_msg     public.support_messages;
  v_mail    jsonb;
  v_status  text;
  v_error   text;
  v_mail_id uuid;
  v_subject text;
  v_html    text;
begin
  perform public.assert_admin_can(case when p_internal then 'support.read' else 'support.reply' end);

  if coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('success', false, 'error', 'A message body is required');
  end if;

  select * into v_t from public.support_tickets where id = p_ticket_id;
  if v_t.id is null then
    return jsonb_build_object('success', false, 'error', 'Ticket not found');
  end if;

  insert into public.support_messages (ticket_id, direction, author_id, author_email, author_name,
                                       body, template_id, email_status, email_error, attempts, sent_at)
  values (p_ticket_id,
          case when p_internal then 'note' else 'outbound' end,
          auth.uid(), public.admin_actor_email(),
          (select trim(both ' ' from concat_ws(' ', p.first_name, p.last_name))
             from public.profiles p where p.id = auth.uid()),
          p_body, p_template_id,
          case when p_internal then 'not_attempted' else 'pending' end,
          null,
          case when p_internal then 0 else 1 end,
          null)
  returning * into v_msg;

  if not p_internal then
    v_subject := public.mail_render(
                   coalesce(public.mail_config('subject_ticket_reply',
                              'Re: {subject} (ticket {ticket_no})'),
                            'Re: {subject} (ticket {ticket_no})'),
                   jsonb_build_object('subject', coalesce(v_t.subject, 'your ticket'),
                                      'ticket_no', coalesce(v_t.ticket_no, ''),
                                      'name', coalesce(v_t.requester_name, '')));
    v_html := public.mail_shell(v_subject,
                '<p style="margin:0 0 12px;">'
                || public.mail_escape('Hi ' || coalesce(nullif(v_t.requester_name, ''), 'there') || ',') || '</p>'
                || '<p style="margin:0 0 12px;">'
                || public.mail_escape('A reply from the Hive Nectar team:') || '</p>'
                || '<blockquote style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #c8a24a;'
                || 'background:#faf7f0;white-space:pre-wrap;">' || public.mail_escape(p_body) || '</blockquote>'
                || '<p style="margin:0;">'
                || public.mail_escape('You can reply to this email and it will reach the same thread.')
                || '</p>');

    v_mail := public.queue_email(v_t.requester_email, v_t.requester_name, v_subject, v_html,
                                 p_body, 'support.reply', 'support_ticket', p_ticket_id::text,
                                 null, v_msg.id);
    v_status := coalesce(v_mail ->> 'status', 'failed');
    v_error  := v_mail ->> 'error';
    v_mail_id := nullif(v_mail ->> 'mail_id', '')::uuid;

    if coalesce((v_mail ->> 'success')::boolean, false) = false then
      v_status := 'failed';
      v_error  := coalesce(v_error, 'The message could not be queued');
    end if;

    update public.support_messages
       set email_status = v_status, email_error = v_error
     where id = v_msg.id;
    v_msg.email_status := v_status;
    v_msg.email_error  := v_error;

    update public.support_tickets
       set status = 'pending_customer',
           first_response_at = coalesce(first_response_at, now())
     where id = p_ticket_id;
  end if;

  perform public.log_admin_action(case when p_internal then 'support.note' else 'support.reply' end,
      'support_ticket', p_ticket_id::text, null,
      jsonb_build_object('message_id', v_msg.id, 'mail_id', v_mail_id,
                         'email_status', v_msg.email_status), null);

  return jsonb_build_object('success', true, 'message_id', v_msg.id, 'mail_id', v_mail_id,
                            'email_status', v_msg.email_status,
                            'delivered', v_msg.email_status = 'sent', 'error', v_msg.email_error);
end;
$function$;

-- =====================================================================
-- S8. Outbox read for the admin screen
-- =====================================================================
create or replace function public.admin_get_mail_outbox(
  p_status text default null,
  p_limit  integer default 50,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit  int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_filter text := nullif(lower(trim(coalesce(p_status, ''))), '');
begin
  if not public.mail_perm_ok(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  if v_filter is not null and v_filter not in ('pending','sending','sent','failed','skipped') then
    return jsonb_build_object('success', false, 'error', 'Unknown mail status: ' || v_filter);
  end if;

  return jsonb_build_object(
    'success', true,
    'data', coalesce((
      select jsonb_agg(r order by r ->> 'created_at' desc)
        from (
          select jsonb_build_object(
                   'id', m.id, 'created_at', m.created_at, 'updated_at', m.updated_at,
                   'sent_at', m.sent_at, 'claimed_at', m.claimed_at,
                   'to_email', m.to_email, 'to_name', m.to_name,
                   'subject', m.subject, 'kind', m.kind,
                   'status', m.status, 'attempts', m.attempts, 'max_attempts', m.max_attempts,
                   'provider', m.provider, 'provider_message_id', m.provider_message_id,
                   'error', m.error, 'related_type', m.related_type, 'related_id', m.related_id,
                   'notification_id', m.notification_id, 'support_message_id', m.support_message_id,
                   'preview', left(regexp_replace(coalesce(m.text_body, m.html), '<[^>]*>', ' ', 'g'), 220)
                 ) as r
            from public.mail_outbox m
           where v_filter is null or m.status = v_filter
           order by m.created_at desc
           limit v_limit offset v_offset
        ) s), '[]'::jsonb),
    'counts', coalesce((
      select jsonb_object_agg(t.status, t.n)
        from (select status, count(*) n from public.mail_outbox group by 1) t), '{}'::jsonb),
    'total', (select count(*) from public.mail_outbox m
               where v_filter is null or m.status = v_filter),
    'filter', v_filter,
    'transport', public.mail_config('mail_transport', 'brevo'),
    'enabled', coalesce(public.mail_config('mail_enabled', 'true'), 'true'),
    'sender_email', public.mail_config('sender_email', null)
  );
end;
$function$;

-- =====================================================================
-- S9. Worker claim — what the send-mail edge function calls
-- ---------------------------------------------------------------------
-- Atomically takes ownership of up to p_limit rows and returns everything the
-- transport needs (recipient, subject, html, sender, reply-to). Rows left in
-- 'sending' by a crashed worker become claimable again after 10 minutes.
-- =====================================================================
create or replace function public.admin_mail_flush_claim(
  p_ids   uuid[]  default null,
  p_limit integer default 10
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 10), 50));
  v_rows  jsonb;
begin
  if not public.mail_authorized() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  with claimable as (
    select m.id
      from public.mail_outbox m
     where (p_ids is null or m.id = any(p_ids))
       and (   m.status = 'pending'
            or (m.status = 'failed' and m.attempts < m.max_attempts)
            or (m.status = 'sending' and m.claimed_at < now() - interval '10 minutes'))
     order by m.created_at
     limit v_limit
     for update skip locked
  ), claimed as (
    update public.mail_outbox m
       set status = 'sending',
           attempts = m.attempts + 1,
           claimed_at = now(),
           updated_at = now()
      from claimable c
     where m.id = c.id
     returning m.id, m.to_email, m.to_name, m.subject, m.html, m.text_body,
               m.kind, m.attempts, m.max_attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'to_email', c.to_email, 'to_name', c.to_name,
           'subject', c.subject, 'html', c.html, 'text', c.text_body,
           'kind', c.kind, 'attempts', c.attempts, 'max_attempts', c.max_attempts)), '[]'::jsonb)
    into v_rows
    from claimed c;

  return jsonb_build_object(
    'success', true,
    'data', v_rows,
    'claimed', jsonb_array_length(v_rows),
    'sender', jsonb_build_object(
       'email', public.mail_config('sender_email', 'follydevs@gmail.com'),
       'name',  public.mail_config('sender_name', 'Hive Nectar')),
    'reply_to', public.mail_config('mail_reply_to', null),
    'transport', public.mail_config('mail_transport', 'brevo'));
end;
$function$;

-- =====================================================================
-- S10. apply_mail_result — the only way a row becomes 'sent'
-- ---------------------------------------------------------------------
-- Mirrors the provider outcome onto whatever the message belonged to:
-- the member's in-app notification, the support thread row, or the review.
-- 'sent' without a provider message id is refused outright, so no screen can
-- ever show a delivered message that no provider ever accepted.
-- =====================================================================
create or replace function public.apply_mail_result(
  p_id                  uuid,
  p_status              text,
  p_provider_message_id text default null,
  p_error               text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row    public.mail_outbox;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_error  text := nullif(left(trim(coalesce(p_error, '')), 900), '');
  v_mirror jsonb := '{}'::jsonb;
begin
  if not public.mail_authorized() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  if v_status not in ('sent', 'failed', 'skipped') then
    return jsonb_build_object('success', false, 'error',
      'Delivery status must be sent, failed or skipped (got: ' || coalesce(p_status, 'null') || ')');
  end if;

  if v_status = 'sent' and coalesce(trim(coalesce(p_provider_message_id, '')), '') = '' then
    return jsonb_build_object('success', false, 'error',
      'A provider message id is required before a message can be marked sent');
  end if;

  update public.mail_outbox
     set status = v_status,
         provider_message_id = case when v_status = 'sent'
                                    then trim(p_provider_message_id) else provider_message_id end,
         error = case when v_status = 'sent' then null else coalesce(v_error, error) end,
         sent_at = case when v_status = 'sent' then coalesce(sent_at, now()) else sent_at end,
         updated_at = now()
   where id = p_id
   returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('success', false, 'error', 'Mail row not found');
  end if;

  if v_row.notification_id is not null then
    update public.admin_notifications
       set delivery_status = v_status,
           delivery_error = case when v_status = 'sent' then null else coalesce(v_error, delivery_error) end,
           attempts = v_row.attempts
     where id = v_row.notification_id;
    v_mirror := v_mirror || jsonb_build_object('notification_id', v_row.notification_id);
  end if;

  if v_row.support_message_id is not null then
    update public.support_messages
       set email_status = v_status,
           email_error = case when v_status = 'sent' then null else coalesce(v_error, email_error) end,
           provider_message_id = coalesce(v_row.provider_message_id, provider_message_id),
           sent_at = case when v_status = 'sent' then coalesce(sent_at, now()) else sent_at end,
           attempts = v_row.attempts
     where id = v_row.support_message_id;
    v_mirror := v_mirror || jsonb_build_object('support_message_id', v_row.support_message_id);
  end if;

  if v_row.related_type = 'member_review' and v_row.related_id ~ '^[0-9a-f-]{36}$' then
    update public.member_reviews
       set member_response_delivery = v_status
     where id = v_row.related_id::uuid;
    v_mirror := v_mirror || jsonb_build_object('member_review_id', v_row.related_id);
  end if;

  perform public.log_admin_action(
    case v_status when 'sent' then 'mail.sent' when 'failed' then 'mail.failed' else 'mail.skipped' end,
    'mail_outbox', v_row.id::text, null,
    jsonb_build_object('status', v_status, 'provider', v_row.provider,
                       'provider_message_id', v_row.provider_message_id,
                       'attempts', v_row.attempts, 'to', v_row.to_email), v_error);

  return jsonb_build_object('success', true, 'id', v_row.id, 'status', v_row.status,
                            'attempts', v_row.attempts,
                            'provider_message_id', v_row.provider_message_id,
                            'error', v_row.error, 'mirrored', v_mirror);
end;
$function$;

-- =====================================================================
-- S11. Retry
-- =====================================================================
create or replace function public.admin_retry_mail(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.mail_outbox;
begin
  if not public.mail_perm_ok(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.mail_outbox where id = p_id;
  if v_row.id is null then
    return jsonb_build_object('success', false, 'error', 'Mail row not found');
  end if;
  if v_row.status = 'sent' then
    return jsonb_build_object('success', false, 'error',
      'Already sent to ' || v_row.to_email || ' — resending would duplicate it');
  end if;
  if v_row.status = 'sending' and v_row.claimed_at > now() - interval '10 minutes' then
    return jsonb_build_object('success', false, 'error', 'A send is already in flight for this message');
  end if;

  update public.mail_outbox
     set status = 'pending', error = null, claimed_at = null, updated_at = now()
   where id = p_id;

  perform public.log_admin_action('mail.retry', 'mail_outbox', p_id::text, null,
      jsonb_build_object('attempts', v_row.attempts, 'to', v_row.to_email), null);

  return jsonb_build_object('success', true, 'id', p_id, 'status', 'pending');
end;
$function$;

-- =====================================================================
-- S12. Self-test: one real email to the configured notification address
-- ---------------------------------------------------------------------
-- The button that proves the pipeline end to end without inventing a member.
-- It only queues; the status is still whatever Brevo actually answered.
-- =====================================================================
create or replace function public.admin_queue_test_email(p_to text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_to      text := coalesce(nullif(trim(coalesce(p_to, '')), ''),
                             public.mail_config('notification_email', null));
  v_subject text := coalesce(public.mail_config('subject_mail_test',
                            'Test email from the Hive Nectar admin'),
                            'Test email from the Hive Nectar admin');
  v_mail    jsonb;
begin
  if not public.mail_perm_ok(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if coalesce(v_to, '') = '' then
    return jsonb_build_object('success', false,
      'error', 'No recipient: set app_config.notification_email or pass an address');
  end if;

  v_mail := public.queue_email(v_to, 'Hive Nectar admin', v_subject,
               public.mail_shell(v_subject,
                 '<p style="margin:0 0 12px;">'
                 || public.mail_escape('This is a test of the CRM mail transport.') || '</p>'
                 || '<p style="margin:0;">'
                 || public.mail_escape('If you are reading it, replies and notifications now leave the building.')
                 || '</p>'),
               'Test of the CRM mail transport from Hive Nectar.', 'mail.test',
               null, null, null, null);

  return jsonb_build_object('success', coalesce((v_mail ->> 'success')::boolean, false),
                            'mail_id', nullif(v_mail ->> 'mail_id', '')::uuid,
                            'status', v_mail ->> 'status', 'to', v_to,
                            'error', v_mail ->> 'error');
end;
$function$;

-- =====================================================================
-- S13. Grants — nothing mail-related may be reached by a signed-out caller
-- =====================================================================
revoke all on function public.queue_email(text,text,text,text,text,text,text,text,bigint,uuid) from public;
revoke all on function public.queue_email(text,text,text,text,text,text,text,text,bigint,uuid) from anon;
revoke all on function public.queue_email(text,text,text,text,text,text,text,text,bigint,uuid) from authenticated;
revoke all on function public.send_email(text,text,text,text,text,text,text,text,bigint,uuid) from public;
revoke all on function public.send_email(text,text,text,text,text,text,text,text,bigint,uuid) from anon;
revoke all on function public.send_email(text,text,text,text,text,text,text,text,bigint,uuid) from authenticated;
revoke all on function public.mail_config(text,text) from public, anon;
revoke all on function public.mail_escape(text) from public, anon;
revoke all on function public.mail_shell(text,text) from public, anon;
revoke all on function public.mail_render(text,jsonb) from public, anon;
revoke all on function public.mail_button(text,text) from public, anon;
revoke all on function public.mail_perm_ok(uuid) from public, anon;
revoke all on function public.mail_authorized() from public, anon;

revoke all on function public.admin_get_mail_outbox(text,integer,integer) from public, anon;
revoke all on function public.admin_mail_flush_claim(uuid[],integer) from public, anon;
revoke all on function public.apply_mail_result(uuid,text,text,text) from public, anon;
revoke all on function public.admin_retry_mail(uuid) from public, anon;
revoke all on function public.admin_queue_test_email(text) from public, anon;

grant execute on function public.admin_get_mail_outbox(text,integer,integer) to authenticated;
grant execute on function public.admin_mail_flush_claim(uuid[],integer) to authenticated;
grant execute on function public.apply_mail_result(uuid,text,text,text) to authenticated;
grant execute on function public.admin_retry_mail(uuid) to authenticated;
grant execute on function public.admin_queue_test_email(text) to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- S14. Baseline note (no data invented)
-- ---------------------------------------------------------------------
-- Rows that predate this migration cannot be emailed retroactively and are
-- left untouched: 6 support_messages with email_status = 'not_attempted' and
-- 12 member_reviews with member_response_delivery = 'stored_only'. They stay
-- visible as history; anything sent from now on gets a mail_outbox row.
-- Their delivery columns are updated by apply_mail_result when a message is
-- retried from the UI.
commit;
