-- =====================================================================
-- Hive Nectar admin CRM — migration 01: Communications
-- =====================================================================
-- Replaces the broken legacy broadcast path with gated admin RPCs.
--
-- WHY THIS EXISTS
--   js/admin-crm.js:372 inserts { title, content, author_id, created_at } into
--   public.communications. That table's `message` column is NOT NULL with no
--   default, and every member reader (js/comms.js, js/notification.js) renders
--   post.message — not post.content. The legacy insert therefore cannot succeed,
--   and the "Broadcast sent!" toast is reported before the error is handled.
--
--   This migration writes `message` (canonical, rendered by members) and mirrors
--   it into `content` for compatibility with anything that reads the old column.
--
-- MEMBER-FACING CONTRACT — MUST NOT BREAK
--   members read communications with select('*'), order by created_at desc, and
--   subscribe to realtime changes on this table. Fields members actually use:
--     message     body text            (comms.js, notification.js)
--     title       headline, falls back to post_type
--     post_type   category filter + notification header
--     icon        optional per-post icon; board falls back to post_type
--     created_at  ordering + the 24h messenger window
--   Nothing here changes those semantics; no column is added or altered.
--
-- HOUSE RULES APPLIED
--   SECURITY DEFINER, SET search_path TO 'public', jsonb return,
--   admin_ok() gate, anon EXECUTE revoked, NOTIFY pgrst at the end.
-- =====================================================================

-- ---------------------------------------------------------------------
-- READ: list communications, newest first
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_communications(
  p_limit  integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r     JSONB;
  total BIGINT;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb)
    INTO r
    FROM (
      SELECT *
        FROM communications
       ORDER BY created_at DESC
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
      OFFSET GREATEST(0, COALESCE(p_offset, 0))
    ) c;

  SELECT COUNT(*) INTO total FROM communications;

  RETURN jsonb_build_object('success', true, 'data', r, 'total', total);
END;
$function$;

-- ---------------------------------------------------------------------
-- WRITE: create or update a communication
--   p_data keys: id (uuid, optional), title, message, post_type, icon
--   `message` is required — the column is NOT NULL and members render it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_save_communication(p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id        uuid := NULLIF(p_data->>'id', '')::uuid;
  v_title     text := NULLIF(btrim(COALESCE(p_data->>'title', '')), '');
  v_message   text := NULLIF(btrim(COALESCE(p_data->>'message', '')), '');
  v_post_type text := NULLIF(btrim(COALESCE(p_data->>'post_type', '')), '');
  v_icon      text := NULLIF(btrim(COALESCE(p_data->>'icon', '')), '');
  v_uid       uuid := auth.uid();
  v_name      text;
  v_email     text;
  row_out     communications;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  IF v_message IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'message is required — members render this field');
  END IF;

  IF v_id IS NULL THEN
    SELECT p.username, p.email INTO v_name, v_email
      FROM profiles p WHERE p.id = v_uid;

    INSERT INTO communications (title, message, content, post_type, icon,
                                author_id, author_name, author_email)
    VALUES (v_title, v_message, v_message, v_post_type, v_icon,
            v_uid, v_name, v_email)
    RETURNING * INTO row_out;
  ELSE
    UPDATE communications
       SET title      = v_title,
           message    = v_message,
           content    = v_message,
           post_type  = v_post_type,
           icon       = v_icon
     WHERE id = v_id
    RETURNING * INTO row_out;

    IF row_out.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Communication not found');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'data', to_jsonb(row_out));
END;
$function$;

-- ---------------------------------------------------------------------
-- WRITE: delete a communication
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_communication(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  n integer;
BEGIN
  IF NOT admin_ok() THEN RETURN jsonb_build_object('success', false, 'error', 'Forbidden'); END IF;

  DELETE FROM communications WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Communication not found');
  END IF;

  RETURN jsonb_build_object('success', true, 'deleted', n);
END;
$function$;

-- ---------------------------------------------------------------------
-- PRIVILEGES
-- Postgres grants EXECUTE to PUBLIC by default, which the anon key inherits.
-- Revoke from PUBLIC and anon; grant only to authenticated and service_role.
-- The in-function admin_ok() gate is the primary control; this is the second.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_get_communications(integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_save_communication(jsonb)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_communication(uuid)          FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_get_communications(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_save_communication(jsonb)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_communication(uuid)           TO authenticated, service_role;

-- PostgREST serves a cached schema until it is told otherwise.
NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- DEFERRED — requires schema addition, therefore requires approval first:
--   * scheduling ("schedule eligible content") needs scheduled_at / published_at
--     columns on communications; none exist today.
--   * an edit history needs an audit table; none exists today.
-- =====================================================================
