-- =====================================================================
-- Hive Nectar admin CRM — migration 02: Subscriptions, membership, analytics
-- =====================================================================
-- Fills the largest gap in the own-CRM scope: subscriptions/tier/Stripe had NO
-- admin RPC at all, and every dashboard metric had to be assembled by hand in
-- the browser (so the old dashboard could not show live aggregates at all).
--
-- MEMBER-FACING CONTRACT — MUST NOT BREAK
--   Nothing here changes a member's read or write path. Four new read functions
--   plus two admin-only writers. admin_set_member_tier() writes profiles.member_tier
--   / profiles.tier, which is exactly the privilege an administrator is meant to
--   hold; no member RPC is touched, and no column is added, dropped or retyped.
--
--   Tier semantics (unchanged): member_tier 0..3, text tier mirrors it.
--   Migrations must never DELETE: subscriptions rows are corrected, not removed.
--
-- HOUSE RULES APPLIED
--   SECURITY DEFINER, SET search_path TO 'public', jsonb return, admin_ok() gate,
--   anon EXECUTE revoked, NOTIFY pgrst at the end.
-- =====================================================================

-- ---------------------------------------------------------------------
-- READ: subscriptions overview (+ summary counts, customer map, event tail)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_subscriptions(
  p_limit  integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows      JSONB;
  v_customers JSONB;
  v_events    JSONB;
  v_summary   JSONB;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT * FROM subscriptions
       ORDER BY created_at DESC
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
      OFFSET GREATEST(0, COALESCE(p_offset, 0))
    ) s;

  -- customer map: stripe_customer_id -> hive profile
  SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
    INTO v_customers
    FROM (
      SELECT cu.stripe_customer_id,
             cu.created_at,
             p.id   AS user_id,
             p.email,
             p.username,
             p.member_tier
        FROM customers cu
        LEFT JOIN profiles p ON p.stripe_customer_id = cu.stripe_customer_id
       ORDER BY cu.created_at DESC
       LIMIT 200
    ) c;

  -- event tail: never return raw (it can hold full webhook payloads)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'created_at', e.created_at)
                            ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_events
    FROM (SELECT id, type, created_at FROM stripe_events ORDER BY created_at DESC LIMIT 20) e;

  SELECT jsonb_build_object(
    'total',            (SELECT COUNT(*) FROM subscriptions),
    'active',           (SELECT COUNT(*) FROM subscriptions WHERE status = 'active'),
    'trialing',         (SELECT COUNT(*) FROM subscriptions WHERE status = 'trialing'),
    'past_due',         (SELECT COUNT(*) FROM subscriptions WHERE status IN ('past_due', 'unpaid')),
    'canceled',         (SELECT COUNT(*) FROM subscriptions WHERE status = 'canceled'),
    'ending_period',    (SELECT COUNT(*) FROM subscriptions WHERE cancel_at_period_end IS TRUE),
    'members_paying',   (SELECT COUNT(*) FROM profiles WHERE member_tier > 0),
    'stripe_events',    (SELECT COUNT(*) FROM stripe_events),
    'last_event_at',    (SELECT MAX(created_at) FROM stripe_events)
  ) INTO v_summary;

  RETURN jsonb_build_object('success', true,
    'data', jsonb_build_object(
      'rows',      v_rows,
      'customers', v_customers,
      'events',    v_events,
      'summary',   v_summary
    ));
END;
$function$;

-- ---------------------------------------------------------------------
-- READ: one member's billing state (profile mirror + subscription rows)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_member_subscription(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_profile JSONB;
  v_subs    JSONB;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  SELECT jsonb_build_object(
           'id', p.id, 'email', p.email, 'username', p.username,
           'member_tier', p.member_tier, 'tier', p.tier,
           'subscription_tier', p.subscription_tier,
           'subscription_status', p.subscription_status,
           'subscription_current_period_end', p.subscription_current_period_end,
           'subscription_cancel_at_period_end', p.subscription_cancel_at_period_end,
           'stripe_customer_id', p.stripe_customer_id,
           'stripe_subscription_id', p.stripe_subscription_id,
           'member_status', p.member_status, 'join_date', p.join_date)
    INTO v_profile
    FROM profiles p WHERE p.id = p_user_id;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member not found');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO v_subs
    FROM (
      SELECT * FROM subscriptions
       WHERE user_id = p_user_id
          OR (stripe_customer_id IS NOT NULL
              AND stripe_customer_id = (SELECT stripe_customer_id FROM profiles WHERE id = p_user_id))
       ORDER BY created_at DESC
       LIMIT 50
    ) s;

  RETURN jsonb_build_object('success', true,
    'data', jsonb_build_object('profile', v_profile, 'subscriptions', v_subs));
END;
$function$;

-- ---------------------------------------------------------------------
-- WRITE: set a member's tier (absolute, 0..3) — the admin membership control
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_member_tier(
  p_user_id     uuid,
  p_member_tier integer,
  p_tier        text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tier  text;
  v_row   profiles;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  IF p_member_tier IS NULL OR p_member_tier < 0 OR p_member_tier > 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'member_tier must be 0, 1, 2 or 3');
  END IF;

  -- the text mirror defaults to the canonical tier name for that number
  v_tier := COALESCE(NULLIF(btrim(COALESCE(p_tier, '')), ''),
                     CASE p_member_tier WHEN 1 THEN 'hive_plus'
                                        WHEN 2 THEN 'steward'
                                        WHEN 3 THEN 'collective'
                                        ELSE 'free' END);

  UPDATE profiles
     SET member_tier = p_member_tier,
         tier        = v_tier
   WHERE id = p_user_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Member not found');
  END IF;

  -- Subscription mirror rows are corrected, never deleted (no-DELETE rule).
  UPDATE subscriptions
     SET tier = v_tier
   WHERE user_id = p_user_id OR stripe_subscription_id = v_row.stripe_subscription_id;

  RETURN jsonb_build_object('success', true,
    'data', jsonb_build_object('id', v_row.id, 'member_tier', v_row.member_tier, 'tier', v_row.tier));
END;
$function$;

-- ---------------------------------------------------------------------
-- WRITE: correct a subscription mirror row (whitelisted columns only)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_subscription(p_id text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row subscriptions;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  UPDATE subscriptions s
     SET status               = COALESCE(NULLIF(btrim(COALESCE(p_data->>'status', '')), ''), s.status),
         tier                 = COALESCE(NULLIF(btrim(COALESCE(p_data->>'tier', '')), ''), s.tier),
         price_id             = COALESCE(NULLIF(btrim(COALESCE(p_data->>'price_id', '')), ''), s.price_id),
         cancel_at_period_end = COALESCE((NULLIF(btrim(COALESCE(p_data->>'cancel_at_period_end', '')), ''))::boolean,
                                         s.cancel_at_period_end),
         current_period_end   = COALESCE((NULLIF(btrim(COALESCE(p_data->>'current_period_end', '')), ''))::timestamptz,
                                         s.current_period_end),
         trial_end            = COALESCE((NULLIF(btrim(COALESCE(p_data->>'trial_end', '')), ''))::timestamptz,
                                         s.trial_end)
   WHERE s.id = p_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Subscription not found');
  END IF;

  RETURN jsonb_build_object('success', true, 'data', to_jsonb(v_row));
END;
$function$;

-- ---------------------------------------------------------------------
-- READ: live analytics (every dashboard number the old UI faked)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_analytics(p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_days     integer := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));
  v_signups  JSONB;
  v_done     JSONB;
  v_themes   JSONB;
  v_totals   JSONB;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'count', d.n) ORDER BY d.day), '[]'::jsonb)
    INTO v_signups
    FROM (SELECT join_date::date AS day, COUNT(*) AS n
            FROM profiles
           WHERE join_date >= now() - make_interval(days => v_days)
           GROUP BY 1) d;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'count', d.n) ORDER BY d.day), '[]'::jsonb)
    INTO v_done
    FROM (SELECT completed_at::date AS day, COUNT(*) AS n
            FROM user_tasks
           WHERE completed_at >= now() - make_interval(days => v_days)
           GROUP BY 1) d;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'theme_id', t.theme_id, 'theme_name', t.theme_name,
           'learners', COALESCE(p.learners, 0), 'nectar_earned', COALESCE(p.nectar_earned, 0),
           'stages', COALESCE((
              SELECT jsonb_object_agg(s.stage, s.n)
                FROM (SELECT COALESCE(utp2.stage, 'unknown') AS stage, COUNT(*) AS n
                        FROM user_theme_progress utp2
                       WHERE utp2.theme_id = t.theme_id
                       GROUP BY 1) s), '{}'::jsonb)
           ) ORDER BY COALESCE(p.nectar_earned, 0) DESC), '[]'::jsonb)
    INTO v_themes
    FROM themes t
    LEFT JOIN (
      SELECT utp.theme_id,
             COUNT(DISTINCT utp.user_id)          AS learners,
             SUM(utp.nectar_earned)               AS nectar_earned
        FROM user_theme_progress utp
       GROUP BY utp.theme_id
    ) p ON p.theme_id = t.theme_id;

  SELECT jsonb_build_object(
    'members_total',      (SELECT COUNT(*) FROM profiles),
    'members_7d',         (SELECT COUNT(DISTINCT user_id) FROM user_tasks WHERE completed_at >= now() - interval '7 days'),
    'members_30d',        (SELECT COUNT(DISTINCT user_id) FROM user_tasks WHERE completed_at >= now() - interval '30 days'),
    'tasks_completed',    (SELECT COUNT(*) FROM user_tasks WHERE completed_at IS NOT NULL),
    'tasks_available',    (SELECT COUNT(*) FROM tasks WHERE COALESCE(active, true)),
    'points_in_circulation', (SELECT COALESCE(SUM(nectar_points), 0) FROM profiles),
    'co2e_saved_kg',      (SELECT ROUND(COALESCE(SUM(total_co2e_saved), 0)::numeric, 2) FROM profiles),
    'tokens_held',        (SELECT COUNT(*) FROM user_tokens),
    'tokens_viewed',      (SELECT COUNT(*) FROM user_tokens WHERE viewed IS TRUE),
    'milestones_reached', (SELECT COUNT(*) FROM user_milestones),
    'collaborations',     (SELECT COUNT(*) FROM collaborations),
    'invites_pending',    (SELECT COUNT(*) FROM collaboration_invites),
    'inquiries_open',     (SELECT COUNT(*) FROM contact_inquiries WHERE COALESCE(status, 'unread') <> 'resolved'),
    'inquiries_total',    (SELECT COUNT(*) FROM contact_inquiries),
    'broadcasts',         (SELECT COUNT(*) FROM communications),
    'impact_logs',        (SELECT COUNT(*) FROM sigma_logs),
    'tier_distribution',  (SELECT COALESCE(jsonb_object_agg(t.member_tier::text, t.n), '{}'::jsonb)
                             FROM (SELECT member_tier, COUNT(*) AS n FROM profiles GROUP BY member_tier) t)
  ) INTO v_totals;

  RETURN jsonb_build_object('success', true,
    'data', jsonb_build_object(
      'window_days', v_days,
      'totals',      v_totals,
      'signups_by_day',     v_signups,
      'completions_by_day', v_done,
      'themes',      v_themes
    ));
END;
$function$;

-- ---------------------------------------------------------------------
-- PRIVILEGES — second layer behind the in-function admin_ok() gate
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_get_subscriptions(integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_member_subscription(uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_member_tier(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_subscription(text, jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_analytics(integer)             FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_get_subscriptions(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_member_subscription(uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_member_tier(uuid, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_subscription(text, jsonb)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_analytics(integer)             TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- DEFERRED — needs a schema addition, therefore needs approval first:
--   * tier history ("when did this member become Steward") — no audit table yet;
--     it arrives with migration 04.
--   * writing to Stripe (refund, cancel, resume) needs the secret key, which by
--     policy never enters this application. Those actions stay in the Stripe
--     dashboard; this CRM mirrors and corrects state only.
-- =====================================================================
