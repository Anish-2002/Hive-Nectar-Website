-- =====================================================================
-- S1. mail_legacy_status() - one word per column vocabulary.
-- ---------------------------------------------------------------------
-- mail_outbox speaks pending / sending / sent / failed / skipped. The three
-- pre-existing columns it mirrors into speak their own vocabularies, enforced
-- by check constraints that were already live:
--   admin_notifications.delivery_status   not_configured | queued | sent | failed | read
--   support_messages.email_status         not_attempted | not_configured | queued | sent | failed
--   member_reviews.member_response_delivery  stored_only | queued | sent | failed
-- 'pending' is legal in NO table except mail_outbox. Writing the outbox word
-- straight into those columns raises 23514, which is what took the whole reply
-- and notification path down. This helper is the single translation point, and
-- its fallback is always a word the target column accepts, so a new transport
-- state can never break a live column again.
-- =====================================================================
create or replace function public.mail_legacy_status(p_status text, p_kind text default 'notification')
returns text
language plpgsql
immutable
set search_path to 'public'
as $mls$
declare
  v_kind text := lower(coalesce(nullif(trim(coalesce(p_kind, '')), ''), 'notification'));
  v_word text;
begin
  v_word := case lower(trim(coalesce(p_status, '')))
    when 'sent' then 'sent'
    when 'read' then 'read'
    when 'failed' then 'failed'
    when 'bounced' then 'failed'
    when 'pending' then 'queued'
    when 'sending' then 'queued'
    when 'queued' then 'queued'
    when 'not_configured' then 'not_configured'
    when 'not_attempted' then 'not_attempted'
    when 'stored_only' then 'stored_only'
    else 'skipped'
  end;

  if v_word = any (
      case v_kind
        when 'review' then array['stored_only', 'queued', 'sent', 'failed']
        when 'ticket' then array['not_attempted', 'not_configured', 'queued', 'sent', 'failed']
        else array['not_configured', 'queued', 'sent', 'failed', 'read']
      end) then
    return v_word;
  end if;

  -- 'skipped' (no transport / switched off): honest word per column.
  return case v_kind when 'review' then 'stored_only' else 'not_configured' end;
end;
$mls$;

revoke all on function public.mail_legacy_status(text, text) from public, anon, authenticated;


-- =====================================================================
-- S2. Review reply - records the reply, then queues and mirrors the result
-- (re-created from the definition live in the database)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_reply_to_member(p_id uuid, p_body text, p_channel text DEFAULT 'in_app'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  v_link    := coalesce(public.mail_config('site_url', 'https://www.hivenectar.earth'),
                        'https://www.hivenectar.earth') || '/the-meadow.html';
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
          'in_app', 'queued', null, 0, auth.uid())
  returning id into v_notif;

  v_mail := public.queue_email(v_email, v_name, v_subject, v_html,
                               p_body || E'\n\nOpen the Meadow: ' || v_link,
                               'review.reply', 'member_review', p_id::text, v_notif, null);
  v_status := public.mail_legacy_status(coalesce(v_mail ->> 'status', 'failed'), 'notification');
  v_error  := v_mail ->> 'error';
  v_mail_id := nullif(v_mail ->> 'mail_id', '')::uuid;

  if coalesce((v_mail ->> 'success')::boolean, false) = false then
    v_status := 'failed';
    v_error  := coalesce(v_error, 'The message could not be queued');
  end if;

  update public.admin_notifications
     set delivery_status = public.mail_legacy_status(v_status, 'notification'), delivery_error = v_error
   where id = v_notif;

  update public.member_reviews
     set member_response = p_body,
         member_response_at = now(),
         member_response_delivery = public.mail_legacy_status(v_status, 'review')
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
-- S3. Ticket reply - internal notes stay 'not_attempted' and are never queued
-- (re-created from the definition live in the database)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_reply_ticket(p_ticket_id uuid, p_body text, p_internal boolean DEFAULT false, p_template_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          case when p_internal then 'not_attempted' else 'queued' end,
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
                                      'ticket_no', coalesce(v_t.ticket_no::text, ''),
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
    v_status := public.mail_legacy_status(coalesce(v_mail ->> 'status', 'failed'), 'ticket');
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
-- S4. Member notification - in-app row then email
-- (re-created from the definition live in the database)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_send_member_notification(p_user_id uuid, p_title text, p_body text DEFAULT NULL::text, p_link text DEFAULT NULL::text, p_kind text DEFAULT 'admin.message'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                     coalesce(public.mail_config('site_url', 'https://www.hivenectar.earth'),
                              'https://www.hivenectar.earth'));
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
          'in_app', 'queued', null, 0, auth.uid())
  returning id into v_id;

  v_mail := public.queue_email(v_email, v_name, v_subject, v_html,
                               nullif(concat_ws(E'\n\n', nullif(trim(coalesce(p_body, '')), ''),
                                                'Open Hive Nectar: ' || v_url), ''),
                               coalesce(nullif(p_kind, ''), 'admin.message'),
                               'member', p_user_id::text, v_id, null);
  v_status := public.mail_legacy_status(coalesce(v_mail ->> 'status', 'failed'), 'notification');
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
-- S5. Transport result - mirrors sent/failed back onto the member-facing rows
-- (re-created from the definition live in the database)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.apply_mail_result(p_id uuid, p_status text, p_provider_message_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
       set delivery_status = public.mail_legacy_status(v_status, 'notification'),
           delivery_error = case when v_status = 'sent' then null else coalesce(v_error, delivery_error) end,
           attempts = v_row.attempts
     where id = v_row.notification_id;
    v_mirror := v_mirror || jsonb_build_object('notification_id', v_row.notification_id);
  end if;

  if v_row.support_message_id is not null then
    update public.support_messages
       set email_status = public.mail_legacy_status(v_status, 'ticket'),
           email_error = case when v_status = 'sent' then null else coalesce(v_error, email_error) end,
           provider_message_id = coalesce(v_row.provider_message_id, provider_message_id),
           sent_at = case when v_status = 'sent' then coalesce(sent_at, now()) else sent_at end,
           attempts = v_row.attempts
     where id = v_row.support_message_id;
    v_mirror := v_mirror || jsonb_build_object('support_message_id', v_row.support_message_id);
  end if;

  if v_row.related_type = 'member_review' and v_row.related_id ~ '^[0-9a-f-]{36}$' then
    update public.member_reviews
       set member_response_delivery = public.mail_legacy_status(v_status, 'review')
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
-- S8. Privileges on the re-created functions (create or replace keeps the old
-- ACL, this re-asserts it so a replay from scratch cannot drift).
-- =====================================================================
revoke all on function public.apply_mail_result(uuid, text, text, text) from public, anon;
revoke all on function public.admin_reply_to_member(uuid, text, text) from public, anon;
revoke all on function public.admin_reply_ticket(uuid, text, boolean, uuid) from public, anon;
revoke all on function public.admin_send_member_notification(uuid, text, text, text, text) from public, anon;

grant execute on function public.apply_mail_result(uuid, text, text, text) to authenticated;
grant execute on function public.admin_reply_to_member(uuid, text, text) to authenticated;
grant execute on function public.admin_reply_ticket(uuid, text, boolean, uuid) to authenticated;
grant execute on function public.admin_send_member_notification(uuid, text, text, text, text) to authenticated;

-- =====================================================================
-- S9. Self-check - every legacy column write now routes through the helper.
-- =====================================================================
do $chk$
declare v_bad int;
begin
  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('apply_mail_result', 'admin_reply_to_member', 'admin_reply_ticket',
                       'admin_send_member_notification')
     and (pg_get_functiondef(p.oid) like '%''pending''%');
  if v_bad > 0 then
    raise exception 'a send path still writes the outbox word pending (% function(s))', v_bad;
  end if;

  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_reply_ticket'
     and pg_get_functiondef(p.oid) like '%coalesce(v_t.ticket_no,%';
  if v_bad > 0 then
    raise exception 'admin_reply_ticket still coalesces bigint ticket_no with a string';
  end if;

  raise notice 'mail send paths: legacy vocabulary mapped, ticket_no cast to text';
end;
$chk$;

notify pgrst, 'reload schema';
