-- ============================================================================
-- 2026-10-13 — Profiles: public/private visibility, alias, leaderboard,
--               member search, and directed partner invites.
--
-- WHY: profiles RLS is own-row-only ("Users can view own profile"), so every
--      cross-user read MUST go through a SECURITY DEFINER RPC. The frontend
--      cannot select other people's rows at all.
--
-- ADDITIVE + RE-RUNNABLE. Only ADDs columns/functions. No deletes, no drops
--      of data. Safe to run twice.
-- ============================================================================

-- ── 1. Visibility + alias columns ───────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS alias     text;

-- Backfill an alias for every existing row so a private user always has one.
UPDATE public.profiles
   SET alias = 'Meadow Bee #' || upper(substr(replace(id::text, '-', ''), 1, 4))
 WHERE alias IS NULL OR btrim(alias) = '';

-- Keep aliases populated for NEW rows too (signup inserts go straight to profiles).
CREATE OR REPLACE FUNCTION public.ensure_profile_alias()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.alias IS NULL OR btrim(NEW.alias) = '' THEN
    NEW.alias := 'Meadow Bee #' || upper(substr(replace(NEW.id::text, '-', ''), 1, 4));
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_ensure_profile_alias ON public.profiles;
CREATE TRIGGER trg_ensure_profile_alias
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_profile_alias();

-- ── 2. One display-name rule used by every RPC ──────────────────────────────
-- Public  → real name.  Private → alias only.  Never leak a private name.
CREATE OR REPLACE FUNCTION public.profile_display_name(
  p_is_public boolean, p_first text, p_last text, p_alias text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN p_is_public THEN COALESCE(NULLIF(btrim(concat_ws(' ', p_first, p_last)), ''), p_alias, 'A Meadow Bee')
    ELSE COALESCE(NULLIF(btrim(p_alias), ''), 'A Meadow Bee')
  END;
$fn$;

-- ── 3. Leaderboard (top → bottom by nectar) ─────────────────────────────────
DROP FUNCTION IF EXISTS public.get_leaderboard(integer);
CREATE OR REPLACE FUNCTION public.get_leaderboard(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_rows jsonb;
  v_me   jsonb;
  v_n    integer;
BEGIN
  WITH ranked AS (
    SELECT id, nectar_points, total_tasks_completed, tier, member_tier, is_public,
           first_name, last_name, alias, avatar_url,
           RANK() OVER (ORDER BY nectar_points DESC, join_date ASC) AS rnk
      FROM public.profiles
  )
  SELECT jsonb_agg(jsonb_build_object(
           'id',         r.id,
           'rank',       r.rnk,
           'nectar',     floor(r.nectar_points / 100.0)::int,
           'display',    public.profile_display_name(r.is_public, r.first_name, r.last_name, r.alias),
           'avatar',     CASE WHEN r.is_public THEN r.avatar_url ELSE NULL END,
           'tier',       COALESCE(r.tier, 'Tier 0'),
           'member_tier',COALESCE(r.member_tier, 0),
           'tasks_done', COALESCE(r.total_tasks_completed, 0),
           'is_public',  r.is_public,
           'is_me',      r.id = v_uid
         ) ORDER BY r.rnk)
    INTO v_rows
    FROM ranked r
   WHERE r.rnk <= GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));

  WITH ranked AS (
    SELECT id, nectar_points,
           RANK() OVER (ORDER BY nectar_points DESC, join_date ASC) AS rnk
      FROM public.profiles
  )
  SELECT jsonb_build_object('rank', r.rnk, 'nectar', floor(r.nectar_points / 100.0)::int)
    INTO v_me
    FROM ranked r
   WHERE r.id = v_uid;

  SELECT count(*) INTO v_n FROM public.profiles;

  RETURN jsonb_build_object(
    'ok',        true,
    'rows',      COALESCE(v_rows, '[]'::jsonb),
    'me',        v_me,
    'total',     COALESCE(v_n, 0)
  );
END $fn$;

-- ── 4. Friend search — PUBLIC profiles only ─────────────────────────────────
DROP FUNCTION IF EXISTS public.search_public_profiles(text, integer);
CREATE OR REPLACE FUNCTION public.search_public_profiles(p_query text DEFAULT '', p_limit integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_q text := btrim(COALESCE(p_query, ''));
BEGIN
  IF length(v_q) < 2 THEN
    RETURN jsonb_build_object('ok', true, 'need_more', true, 'rows', '[]'::jsonb);
  END IF;
  -- treat user input as a literal (no wildcard injection)
  v_q := replace(replace(v_q, '\', '\\'), '%', '\%');
  v_q := replace(v_q, '_', '\_');

  RETURN jsonb_build_object('ok', true, 'need_more', false, 'rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id',         p.id,
             'display',    COALESCE(NULLIF(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
                                     p.alias, 'A Meadow Bee'),
             'avatar',     p.avatar_url,
             'nectar',     floor(p.nectar_points / 100.0)::int,
             'tier',       COALESCE(p.tier, 'Tier 0'),
             'member_tier',COALESCE(p.member_tier, 0),
             'tasks_done', COALESCE(p.total_tasks_completed, 0),
             'is_me',      p.id = auth.uid()
           ) ORDER BY p.nectar_points DESC)
      FROM public.profiles p
     WHERE p.is_public
       AND p.id <> COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
       AND (p.first_name ILIKE '%' || v_q || '%'
         OR p.last_name  ILIKE '%' || v_q || '%'
         OR concat_ws(' ', p.first_name, p.last_name) ILIKE '%' || v_q || '%'
         OR COALESCE(p.username, '') ILIKE '%' || v_q || '%')
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 60))
  ), '[]'::jsonb));
END $fn$;

-- ── 5. One member's public card ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_public_profile(uuid);
CREATE OR REPLACE FUNCTION public.get_public_profile(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r      public.profiles%ROWTYPE;
  v_rank integer;
BEGIN
  SELECT * INTO r FROM public.profiles WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT rnk INTO v_rank
    FROM (SELECT id, RANK() OVER (ORDER BY nectar_points DESC, join_date ASC) AS rnk
            FROM public.profiles) t
   WHERE t.id = p_id;

  IF r.is_public THEN
    RETURN jsonb_build_object(
      'ok', true, 'is_public', true, 'id', r.id,
      'display',     COALESCE(NULLIF(btrim(concat_ws(' ', r.first_name, r.last_name)), ''),
                              r.alias, 'A Meadow Bee'),
      'avatar',      r.avatar_url,
      'nectar',      floor(r.nectar_points / 100.0)::int,
      'tier',        COALESCE(r.tier, 'Tier 0'),
      'member_tier', COALESCE(r.member_tier, 0),
      'tasks_done',  COALESCE(r.total_tasks_completed, 0),
      'co2e',        COALESCE(r.total_co2e_saved, 0),
      'stage',       r.current_stage,
      'member_status', r.member_status,
      'level',       r.user_level,
      'join_date',   r.join_date,
      'rank',        COALESCE(v_rank, 0),
      'is_me',       r.id = auth.uid()
    );
  END IF;

  -- Private member: alias + standing only. No name, avatar, tier or task count.
  RETURN jsonb_build_object(
    'ok', true, 'is_public', false, 'id', r.id,
    'display', COALESCE(NULLIF(btrim(r.alias), ''), 'A Meadow Bee'),
    'avatar',  NULL,
    'nectar',  floor(r.nectar_points / 100.0)::int,
    'rank',    COALESCE(v_rank, 0),
    'private', true,
    'is_me',   r.id = auth.uid()
  );
END $fn$;

-- ── 6. Directed partner invites (email → member) ────────────────────────────
ALTER TABLE public.collaboration_invites ADD COLUMN IF NOT EXISTS invitee_id    uuid;
ALTER TABLE public.collaboration_invites ADD COLUMN IF NOT EXISTS invitee_email text;

-- Look up an email WITHOUT echoing it back. Collective tier only.
DROP FUNCTION IF EXISTS public.lookup_member_for_invite(text);
CREATE OR REPLACE FUNCTION public.lookup_member_for_invite(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(COALESCE(p_email, '')));
  r       public.profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'auth');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = v_uid AND COALESCE(member_tier, 0) >= 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tier');
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_email');
  END IF;

  SELECT * INTO r FROM public.profiles WHERE lower(email) = v_email LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'member', false);
  END IF;
  IF r.id = v_uid THEN
    RETURN jsonb_build_object('ok', true, 'member', true, 'self', true);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'member', true, 'self', false, 'id', r.id,
    'display', public.profile_display_name(r.is_public, r.first_name, r.last_name, r.alias),
    'is_public', r.is_public,
    'already_partner', EXISTS (
      SELECT 1 FROM public.collaborations c
       WHERE (c.user_a_id = v_uid AND c.user_b_id = r.id)
          OR (c.user_b_id = v_uid AND c.user_a_id = r.id)),
    'pending_invite', EXISTS (
      SELECT 1 FROM public.collaboration_invites i
       WHERE i.inviter_id = v_uid AND i.invitee_id = r.id AND i.status = 'pending')
  );
END $fn$;

-- Create (or reuse) an invite aimed at one email. Works for members AND
-- non-members: a non-member gets the same join link, which asks them to sign up.
DROP FUNCTION IF EXISTS public.create_directed_collab_invite(text);
CREATE OR REPLACE FUNCTION public.create_directed_collab_invite(p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_id    uuid;
  v_code  text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'auth');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = v_uid AND COALESCE(member_tier, 0) >= 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tier');
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_email');
  END IF;

  SELECT id INTO v_id FROM public.profiles WHERE lower(email) = v_email LIMIT 1;
  IF v_id = v_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self');
  END IF;

  -- Reuse a live pending invite for the same target so we don't spam rows.
  SELECT invite_code INTO v_code
    FROM public.collaboration_invites
   WHERE inviter_id = v_uid
     AND status = 'pending'
     AND expires_at > now()
     AND ((v_id IS NOT NULL AND invitee_id = v_id)
       OR (v_id IS NULL AND lower(COALESCE(invitee_email, '')) = v_email))
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_code IS NULL THEN
    INSERT INTO public.collaboration_invites (inviter_id, invitee_id, invitee_email, status)
    VALUES (v_uid, v_id, v_email, 'pending')
    RETURNING invite_code INTO v_code;
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', v_code, 'member', v_id IS NOT NULL,
                            'display', CASE WHEN v_id IS NULL THEN NULL ELSE
                              public.profile_display_name(
                                COALESCE((SELECT is_public FROM public.profiles WHERE id = v_id), false),
                                (SELECT first_name FROM public.profiles WHERE id = v_id),
                                (SELECT last_name  FROM public.profiles WHERE id = v_id),
                                (SELECT alias      FROM public.profiles WHERE id = v_id)) END);
END $fn$;

-- ── 7. Set my own visibility (+ alias when going private) ───────────────────
DROP FUNCTION IF EXISTS public.set_profile_visibility(boolean, text);
CREATE OR REPLACE FUNCTION public.set_profile_visibility(p_public boolean, p_alias text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_alias text := NULLIF(btrim(COALESCE(p_alias, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'auth');
  END IF;

  IF NOT COALESCE(p_public, false) THEN
    -- going private: an alias is mandatory, so nobody can identify you
    IF v_alias IS NULL OR length(v_alias) < 3 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'alias_required');
    END IF;
  END IF;

  IF v_alias IS NOT NULL AND (length(v_alias) > 24 OR v_alias ~ '[<>]') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'alias_invalid');
  END IF;
  IF v_alias IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE id = v_uid AND alias = v_alias) THEN
    IF EXISTS (SELECT 1 FROM public.profiles
                WHERE lower(alias) = lower(v_alias) AND id <> v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'alias_taken');
    END IF;
  END IF;

  UPDATE public.profiles
     SET is_public = COALESCE(p_public, false),
         alias     = COALESCE(v_alias, alias,
                              'Meadow Bee #' || upper(substr(replace(v_uid::text, '-', ''), 1, 4))),
         updated_at = now()
   WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true,
    'is_public', COALESCE(p_public, false),
    'alias', (SELECT alias FROM public.profiles WHERE id = v_uid));
END $fn$;

-- ── 8. Grants — authenticated only (never anon) ─────────────────────────────
DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_leaderboard(integer)',
    'public.search_public_profiles(text, integer)',
    'public.get_public_profile(uuid)',
    'public.lookup_member_for_invite(text)',
    'public.create_directed_collab_invite(text)',
    'public.set_profile_visibility(boolean, text)',
    'public.profile_display_name(boolean, text, text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $do$;

-- ── 9. Schema cache refresh (PostgREST serves stale signatures without it) ──
NOTIFY pgrst, 'reload schema';
