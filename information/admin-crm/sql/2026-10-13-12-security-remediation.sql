-- =====================================================================
-- 12 - SECURITY REMEDIATION  (approved by the owner 2026-10-13)
--
-- Closes the four findings recorded in 06-CRM-AUDIT-AND-GAP-ANALYSIS.md 7.
-- Every change is additive or tightens authorisation only; no member-facing
-- behaviour, no schema change, no data migration. Re-runnable.
--
-- F1  handle_subscription_event(text,text,text,bigint,text)
--     was EXECUTE-able by anon (ACL carried a PUBLIC grant) with no check at
--     all: anyone on the internet could POST an RPC call and set any account's
--     tier to plus/steward/collective or cancel it - a revenue bypass.
--     Its only legitimate caller is the stripe-webhook edge function, which
--     authenticates with SUPABASE_SERVICE_ROLE_KEY (information/supabase/
--     functions/stripe-webhook/index.ts:11). No client code calls it (repo-wide
--     grep: no matches in js/, jsx/, html/). Fix: revoke PUBLIC/anon/
--     authenticated, keep service_role.
--
-- F2  downgrade_expired_subscriptions()
--     was callable by any signed-in member, letting any member trigger a
--     site-wide billing sweep. It is a cron/maintenance operation. Fix: real
--     role check for 'billing.manage' (super_admin holds it; a plain
--     'administrator' does not, matching the migration-09 permission model)
--     plus an audit row.
--
-- F3  reset_user_progress_by_id(uuid)
--     was callable by any signed-in member, who could wipe ANY member's task,
--     milestone, log, token and points history (11 tables + a profile reset).
--     Fix: require 'member.write' + audit.
--
-- F4  unlock_all_tasks_for_user(uuid)
--     was callable by any signed-in member, who could mark every task complete
--     for ANY member and rewrite their points/level. Fix: require
--     'member.write' + audit.
--
-- Deliberately NOT changed here (same class, but these are existing member
-- gameplay flows and altering them changes member-facing behaviour, which the
-- contract forbids without explicit approval):
--     award_theme_tokens, check_and_award_milestones  (already guarded by
--         "p_user_id IS DISTINCT FROM auth.uid()"),
--     get_admin_stats  (already guarded by is_admin()),
--     increment_theme_stage_progress(uuid,text,text[,integer]),
--     update_user_levels(uuid), reset_experienced_progress(uuid),
--     award_milestone, approve_badge_stage, submit_badge_stage.
--     is_admin()/storage_admin() keep their EXECUTE grants on purpose: 20 RLS
--     policies call them (incl. member-facing task_sigma_logs_select_own and
--     the storage policies); revoking would break member reads and uploads.
-- =====================================================================

-- ---------------------------------------------------------------- F1 -----
revoke all on function public.handle_subscription_event(text, text, text, bigint, text) from public;
revoke all on function public.handle_subscription_event(text, text, text, bigint, text) from anon;
revoke all on function public.handle_subscription_event(text, text, text, bigint, text) from authenticated;
grant  execute on function public.handle_subscription_event(text, text, text, bigint, text) to service_role;

-- ------------------------------------------------------------ F2, F3, F4 --
-- F2 -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.downgrade_expired_subscriptions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    downgraded INT := 0;
    profile RECORD;
BEGIN
    -- SECURITY REMEDIATION (migration 12): this function was callable by any
    -- signed-in member, who could then operate on another member's rows.
    perform public.assert_admin_can('billing.manage');
    FOR profile IN
        SELECT id, email, tier, subscription_status, subscription_current_period_end
        FROM profiles
        WHERE tier IS NOT NULL
          AND tier != 'free'
          AND subscription_status IN ('active', 'past_due', 'incomplete', 'canceled')
          AND (
              subscription_current_period_end IS NOT NULL
              AND subscription_current_period_end < NOW()
          )
    LOOP
        UPDATE profiles SET
            tier = 'free',
            subscription_status = 'expired',
            subscription_tier = NULL,
            stripe_subscription_id = NULL,
            subscription_current_period_end = NULL,
            subscription_cancel_at_period_end = false
        WHERE id = profile.id;

        downgraded := downgraded + 1;
    END LOOP;

    perform public.admin_log_action('billing.downgrade_expired',
                                    'profile', null::text,
                                    'migration 12 security remediation');

    RETURN jsonb_build_object('downgraded_count', downgraded);
END;
$function$;

-- F3 -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_user_progress_by_id(uid uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    -- SECURITY REMEDIATION (migration 12): this function was callable by any
    -- signed-in member, who could then operate on another member's rows.
    perform public.assert_admin_can('member.write');
    -- Delete all user progress data
    DELETE FROM public.user_tasks WHERE user_id = uid;
    DELETE FROM public.user_milestones WHERE user_id = uid;
    DELETE FROM public.sigma_logs WHERE user_id = uid;
    DELETE FROM public.task_sigma_logs WHERE user_id = uid;
    DELETE FROM public.user_task_group_stats WHERE user_id = uid;
    DELETE FROM public.task_comments WHERE user_id = uid;
    DELETE FROM public.task_feedback WHERE user_id = uid;
    DELETE FROM public.user_theme_progress WHERE user_id = uid;
    DELETE FROM public.user_badge_progress WHERE user_id = uid;
    DELETE FROM public.user_challenge_progress WHERE user_id = uid;
    DELETE FROM public.user_tokens WHERE user_id = uid;

    -- Reset profile to initial values
    UPDATE public.profiles
    SET 
        nectar_points = 0,
        experience = 0,
        referral_count = 0,
        prefers_experienced = false,
        tier = 'free',
        member_tier = 0,
        total_tasks_completed = 0,
        current_stage = 'Seed',
        total_co2e_saved = 0,
        member_status = 'New Bee',
        user_level = 'Novice',
        engagement_level = 'Seed'
    WHERE id = uid;

    perform public.admin_log_action('member.progress_reset',
                                    'profile', uid::text,
                                    'migration 12 security remediation');

    RETURN 'User progress reset successfully';
END;
$function$;

-- F4 -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unlock_all_tasks_for_user(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    task_record RECORD;
    point_total INTEGER := 0;
BEGIN
    -- SECURITY REMEDIATION (migration 12): this function was callable by any
    -- signed-in member, who could then operate on another member's rows.
    perform public.assert_admin_can('member.write');
    -- Delete any existing completions to avoid conflicts
    DELETE FROM user_tasks WHERE user_id = p_user_id;

    -- Loop through all tasks
    FOR task_record IN SELECT id, nectar_reward FROM tasks LOOP
        -- Insert a novice completion for each task
        INSERT INTO user_tasks (user_id, task_id, version, points_awarded, completed_at)
        VALUES (p_user_id, task_record.id, 'novice', COALESCE(task_record.nectar_reward, 0), NOW());
        
        point_total := point_total + COALESCE(task_record.nectar_reward, 0);
    END LOOP;

    -- Update the user's total points and tasks count
    UPDATE profiles
    SET nectar_points = point_total,
        total_tasks_completed = (SELECT COUNT(*) FROM tasks),
        experience = point_total % 100,
        user_level = CASE WHEN point_total >= 100 THEN 'Experienced' ELSE 'Novice' END,
        engagement_level = CASE
            WHEN point_total < 50 THEN 'Seed'
            WHEN point_total < 200 THEN 'Sprout'
            WHEN point_total < 500 THEN 'Bloom'
            ELSE 'Harvest'
        END
    WHERE id = p_user_id;

    perform public.admin_log_action('member.tasks_unlocked',
                                    'profile', p_user_id::text,
                                    'migration 12 security remediation');

    RETURN 'All tasks unlocked successfully for user ' || p_user_id;
END;
$function$;


-- ------------------------------------------------------------- verify ----
-- postgres/service_role keep EXECUTE; anon and authenticated lose it on the
-- two maintenance functions; the two member-mutating helpers stay callable by
-- `authenticated` so an administrator's browser session still works - the
-- refusal now happens inside the function, before any row is touched.

NOTIFY pgrst, 'reload schema';
