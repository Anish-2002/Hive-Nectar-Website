-- 2026-10-14 - Migration 16: report the mail transport truthfully.
--
-- WHY: admin_get_integration_health used to answer 'No mail function in the
-- database: nothing can be emailed from the CRM yet.' That sentence was TRUE
-- before migration 14 and is a LIE now that the outbox + send-mail transport
-- exist. The health screen must describe the transport that is actually
-- installed, name it, and say why it is not ready when it is not.
--
-- Rebuilt from the LIVE definition (pg_get_functiondef) so nothing else drifts.
-- The four globals it reads (mail_enabled, mail_transport, sender_email) come
-- from app_config through the m14 helper public.mail_config(text,text).
--
-- Grants are untouched by CREATE OR REPLACE: this function keeps whatever
-- ACL it already had (authenticated-only, revoked from anon/public by m11).

CREATE OR REPLACE FUNCTION public.admin_get_integration_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email_fn boolean;
  v_mail_box boolean;
  v_mail_on boolean;
  v_transport text;
  v_sender text;
  v_waiting bigint;
  v_sent bigint;
  v_failed bigint;
  v_tables jsonb;
begin
  perform public.assert_admin_can('health.read');

  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('send_email','queue_email'))
    into v_email_fn;

  select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'mail_outbox'),
         lower(coalesce(public.mail_config('mail_enabled','false'),'false')) = 'true',
         coalesce(nullif(public.mail_config('mail_transport','brevo'),''),'brevo'),
         coalesce(public.mail_config('sender_email',null),''),
         (select count(*) from public.mail_outbox where status in ('pending','sending')),
         (select count(*) from public.mail_outbox where status = 'sent'),
         (select count(*) from public.mail_outbox where status = 'failed')
    into v_mail_box, v_mail_on, v_transport, v_sender, v_waiting, v_sent, v_failed;

  select jsonb_build_object(
    'email_transport', jsonb_build_object(
        'ready', v_email_fn and v_mail_box and v_mail_on and v_sender <> '',
        'transport', v_transport,
        'sender', nullif(v_sender, ''),
        'enabled', v_mail_on,
        'waiting', v_waiting,
        'sent', v_sent,
        'failed', v_failed,
        'detail', case
          when not v_email_fn or not v_mail_box
            then 'No mail function in the database: nothing can be emailed from the CRM yet.'
          when not v_mail_on
            then 'Mail is switched off in app_config (mail_enabled).'
          when v_sender = ''
            then 'No sender address is configured (app_config sender_email).'
          else format('Mail is live over %s from %s: %s waiting, %s sent, %s failed.',
                      v_transport, v_sender, v_waiting, v_sent, v_failed)
        end),
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
$function$;

notify pgrst, 'reload schema';
