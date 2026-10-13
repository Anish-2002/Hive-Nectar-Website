-- =====================================================================================
-- 2026-10-13-01  Hive Nectar — admin-plane hardening (MINIMAL, user-approved)
-- =====================================================================================
-- Approving authority: user, 13 October 2026, "minimal first: revoke anon EXECUTE on
--   add_admin, remove_admin, reset_user_progress_by_id, unlock_all_tasks_for_user,
--   downgrade_expired_subscriptions, handle_new_user + add the internal admin guard to add_admin".
--
-- Scope of this file: EXACTLY 6 revokes and 1 guarded function replacement.
--   No table is altered. No row is written, updated or deleted. No member-facing
--   behaviour changes. No data semantics change.
--
-- WHY "FROM PUBLIC, anon" AND NOT JUST "FROM anon":
--   Every one of these functions carries the ACL entry "=X/postgres", i.e. EXECUTE granted to
--   PUBLIC. PUBLIC is inherited by every role, so anon holds EXECUTE *twice* (directly and via
--   PUBLIC). "REVOKE EXECUTE ... FROM anon" alone therefore removes one path and leaves the
--   inherited one working - a silent no-op. Revoking from PUBLIC removes the inherited path;
--   the explicit grants to authenticated and service_role (present in the same ACL, e.g.
--   "authenticated=X/postgres", "service_role=X/postgres") are preserved, so:
--     - the member app keeps working (it calls these signed in, as authenticated)
--     - the admin UI keeps working (it calls add_admin/remove_admin signed in as an admin)
--
-- Evidence and impact analysis: information/admin-crm/03-ADMIN-RPC-SIGNATURES.md
-- Rollback: GRANT EXECUTE ON FUNCTION ... TO PUBLIC, anon;  (guards are additive)
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. Remove anonymous reachability from the six functions that hand out privilege,
--    destroy data, or mutate subscriptions with no internal authorization check.
-- -------------------------------------------------------------------------------------
DO $$
DECLARE
    r        record;
    n        int := 0;
    missing  text := '';
BEGIN
    FOR r IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public'
          AND p.proname IN ('add_admin', 'remove_admin', 'reset_user_progress_by_id',
                            'unlock_all_tasks_for_user', 'downgrade_expired_subscriptions',
                            'handle_new_user')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon',
                       r.proname, r.args);
        RAISE NOTICE 'hardened: public.%(%)  -> anon/PUBLIC revoked',
                     r.proname, r.args;
        n := n + 1;
    END LOOP;

    IF n <> 6 THEN
        RAISE EXCEPTION 'expected exactly 6 functions, hardened % - aborting', n;
    END IF;
    RAISE NOTICE 'total functions hardened: %', n;
END $$;

-- -------------------------------------------------------------------------------------
-- 2. Guard the escalation path itself. The original body is preserved verbatim; one
--    guard is prepended and nothing else is touched.
--
--    Guard rationale:
--      is_admin()                                  -> a signed-in admin, unchanged behaviour
--      current_setting('role', true)='service_role' -> keeps the future CRM bridge working
--    current_user CANNOT be used here: inside a SECURITY DEFINER function owned by postgres,
--    current_user is always 'postgres'. The 'role' GUC is what SET ROLE (performed by the
--    API gateway after verifying the JWT) actually changes, so it reflects the real caller
--    and cannot be set by a client.
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_admin(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR current_setting('role', true) = 'service_role') THEN
    RETURN false;
  END IF;

  INSERT INTO admin_users (email) VALUES (p_email)
  ON CONFLICT (email) DO NOTHING;
  RETURN FOUND;
END;
$function$;

NOTIFY pgrst, 'reload schema';
