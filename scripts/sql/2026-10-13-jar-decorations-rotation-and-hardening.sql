-- ─────────────────────────────────────────────────────────────────────────────
-- Jar lid decorator — persist rotation + close the save_jar_decorations IDOR
-- 2026-10-13  ·  project gxboojbfmpejbjolfmjq  ·  run in the Supabase SQL editor
--   (or: POST https://api.supabase.com/v1/projects/<ref>/database/query)
--
-- WHAT THIS FIXES
--   1. user_jar_decorations had no column for a sticker's rotation, so the
--      decorated page could only mirror spin angle in localStorage per device.
--   2. save_jar_decorations is SECURITY DEFINER and was EXECUTE-granted to
--      `anon` with NO ownership check: any caller holding the public anon key
--      could DELETE + INSERT another user's rows for any user_id (confirmed
--      live: an unauthenticated DELETE returned 204).
--
-- SAFE TO RE-RUN (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) rotation, the missing transform component ───────────────────────────────
ALTER TABLE public.user_jar_decorations
  ADD COLUMN IF NOT EXISTS rotation real NOT NULL DEFAULT 0;

-- 2) ownership gate + rotation on write ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_jar_decorations(
  p_user_id uuid,
  p_decorations jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', current_user);
BEGIN
  -- No JWT (plain anon key) may not write decorations at all: the table's RLS
  -- policies require an authenticated own-row session, and this function is
  -- SECURITY DEFINER so it would otherwise bypass them.
  IF v_uid IS NULL AND v_role <> 'service_role' THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- A signed-in user may only write their own lid. service_role (v_uid NULL) is
  -- allowed through for maintenance.
  IF v_uid IS NOT NULL AND p_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'forbidden: cannot write another user''s jar' USING ERRCODE = '42501';
  END IF;

  DELETE FROM user_jar_decorations WHERE user_id = p_user_id;

  INSERT INTO user_jar_decorations (user_id, milestone_id, token_id, x_pos, y_pos, scale, rotation)
  SELECT
      p_user_id,
      CASE WHEN item->>'milestone_id' IS NOT NULL AND item->>'milestone_id' ~ '^\d+$'
           THEN (item->>'milestone_id')::BIGINT
           ELSE NULL
      END,
      CASE WHEN item->>'token_id' IS NOT NULL AND item->>'token_id' ~ '^[0-9a-f-]+$'
           THEN (item->>'token_id')::UUID
           ELSE NULL
      END,
      GREATEST(0, LEAST(100, COALESCE((item->>'x_pos')::REAL, 50))),
      GREATEST(0, LEAST(100, COALESCE((item->>'y_pos')::REAL, 50))),
      GREATEST(0.1, LEAST(4, COALESCE((item->>'scale')::REAL, 1))),
      COALESCE((item->>'rotation')::REAL, 0)
  FROM jsonb_array_elements(p_decorations) AS item;
END;
$function$;

-- 3) least privilege on the function ─────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.save_jar_decorations(uuid, jsonb) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.save_jar_decorations(uuid, jsonb) TO authenticated, service_role;

-- 4) PostgREST schema cache ─────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (exact pre-2026-10-13 definition, no ownership check):
--
--   CREATE OR REPLACE FUNCTION public.save_jar_decorations(p_user_id uuid, p_decorations jsonb)
--   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
--   AS $function$
--   BEGIN
--       DELETE FROM user_jar_decorations WHERE user_id = p_user_id;
--       INSERT INTO user_jar_decorations (user_id, milestone_id, token_id, x_pos, y_pos, scale)
--       SELECT p_user_id,
--              CASE WHEN item->>'milestone_id' IS NOT NULL AND item->>'milestone_id' ~ '^\d+$'
--                   THEN (item->>'milestone_id')::BIGINT ELSE NULL END,
--              CASE WHEN item->>'token_id' IS NOT NULL AND item->>'token_id' ~ '^[0-9a-f-]+$'
--                   THEN (item->>'token_id')::UUID ELSE NULL END,
--              COALESCE((item->>'x_pos')::REAL, 50),
--              COALESCE((item->>'y_pos')::REAL, 50),
--              COALESCE((item->>'scale')::REAL, 1)
--       FROM jsonb_array_elements(p_decorations) AS item;
--   END;
--   $function$;
--   GRANT EXECUTE ON FUNCTION public.save_jar_decorations(uuid, jsonb) TO anon;
--   ALTER TABLE public.user_jar_decorations DROP COLUMN IF EXISTS rotation;
--   NOTIFY pgrst, 'reload schema';
-- ─────────────────────────────────────────────────────────────────────────────
