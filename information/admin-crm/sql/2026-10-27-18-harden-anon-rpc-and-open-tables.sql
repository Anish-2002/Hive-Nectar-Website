-- 2026-10-27-18 — Harden anon-exposed RPCs and RLS-off tables
-- Applied live to gxboojbfmpejbjolfmjq on 2026-10-27. Idempotent.
--
-- Findings this closes (all reachable with the public anon key alone):
--   * get_partner_profiles(uuid[])  -> returned email/username/avatar of ANY profile id
--   * is_admin(uuid)               -> true/false admin oracle
--   * mark_token_viewed(uuid,uuid) -> wrote another member's viewed flag (no caller check)
--   * achievements / challenges / impact_conversion / theme_stats
--       RLS off + anon INSERT,UPDATE,DELETE (impact_conversion holds live CO2 factors)
--
-- Not revoked on purpose: get_all_config() stays callable by anon - the public
-- site reads site_url/sender_name before any session exists, and it holds no secrets.
-- Keep it that way: never add a secret to app_config.

BEGIN;

-- 1. Missing caller guard
CREATE OR REPLACE FUNCTION public.mark_token_viewed(p_user_id uuid, p_token_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;
    UPDATE user_tokens
       SET viewed = true
     WHERE user_id = p_user_id AND token_id = p_token_id;
END;
$fn$;

-- 2. Signed-in only
REVOKE EXECUTE ON FUNCTION public.is_admin(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_partner_profiles(uuid[]) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.get_partner_profiles(uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.mark_token_viewed(uuid, uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.mark_token_viewed(uuid, uuid) TO authenticated;

-- 3. Open tables: RLS on, writes revoked. impact_conversion keeps its public
--    SELECT policy (reference data the UI may read); the other three deny all.
ALTER TABLE public.achievements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.impact_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_stats       ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.achievements, public.challenges, public.impact_conversion, public.theme_stats
  FROM anon, authenticated;

GRANT SELECT
  ON public.achievements, public.challenges, public.impact_conversion, public.theme_stats
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verification (expect 401 permission denied for every anon call):
--   POST /rest/v1/rpc/is_admin               {"p_user_id":"<uuid>"}
--   POST /rest/v1/rpc/get_partner_profiles   {"p_ids":["<uuid>"]}
--   POST /rest/v1/rpc/mark_token_viewed      {"p_user_id":"<uuid>","p_token_id":"<uuid>"}
--   POST /rest/v1/impact_conversion          [{"impact_type_id":"probe","impact_type":"x"}]
-- Expect 200: POST /rest/v1/rpc/get_all_config {}
