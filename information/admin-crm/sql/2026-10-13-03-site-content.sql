-- 2026-10-13-03-site-content.sql
-- Admin CRM, migration 03: editorial control over the public site's content
-- tables. Until now these five tables had NO administrative path at all --
-- the only way to change a nav label, a hub item or a policy brief was to edit
-- production data by hand.
--
-- Scope: administration only. Member pages read these tables directly with the
-- anon key and keep doing exactly that; nothing here changes a member-facing
-- query, permission or default. The three functions below are additive and
-- gated by admin_ok().
--
-- Conventions copied from migrations 01 and 02:
--   * SECURITY DEFINER, gate first, return jsonb {success, ...}
--   * REVOKE ... FROM public, anon (leaves postgres / authenticated / service_role)
--   * NOTIFY pgrst at the end so PostgREST reloads its schema cache
--
-- Kinds: hub | nav | social | policy | founder
--
-- Note on clearing a field: the admin form re-sends every value it loaded, so a
-- field the editor blanked arrives as an omitted key and is written as NULL.
-- Required columns are validated before the write rather than left to raise a
-- 23502, so the UI can show a sentence instead of a Postgres error.

-- ─────────────────────────────────────────────────────────── read

create or replace function public.admin_get_site_content(p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if not public.admin_ok() then
    return jsonb_build_object('success', false, 'error', 'Forbidden');
  end if;

  case p_kind
    when 'hub' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.order_index nulls last, t.created_at), '[]'::jsonb)
        into v_rows from public.hub_content t;
    when 'nav' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.order_index nulls last, t.label), '[]'::jsonb)
        into v_rows from public.navigation_menu t;
    when 'social' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.order_index nulls last, t.name), '[]'::jsonb)
        into v_rows from public.social_links t;
    when 'policy' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.name), '[]'::jsonb)
        into v_rows from public.policy_briefs t;
    when 'founder' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.order_index nulls last, t.name), '[]'::jsonb)
        into v_rows from public.founders t;
    else
      return jsonb_build_object('success', false,
        'error', 'Unknown content kind: ' || coalesce(p_kind, '(null)'));
  end case;

  return jsonb_build_object('success', true, 'data', coalesce(v_rows, '[]'::jsonb));
end;
$$;

-- ─────────────────────────────────────────────────────────── write

create or replace function public.admin_save_site_item(p_kind text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  text;
  v_row jsonb;
begin
  if not public.admin_ok() then
    return jsonb_build_object('success', false, 'error', 'Forbidden');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('success', false, 'error', 'p_data must be a JSON object');
  end if;

  v_id := nullif(btrim(coalesce(p_data -> 'id', 'null'::jsonb) #>> '{}'), '');

  case p_kind

    when 'hub' then
      if coalesce(p_data ->> 'title', '') = ''
         or coalesce(p_data ->> 'category_slug', '') = ''
         or coalesce(p_data ->> 'source_url', '') = '' then
        return jsonb_build_object('success', false,
          'error', 'A hub item needs title, category_slug and source_url.');
      end if;
      if v_id is null then
        insert into public.hub_content
          (title, category_slug, media_type, source_url, description, thumbnail_url, order_index)
        values
          (p_data ->> 'title', p_data ->> 'category_slug', p_data ->> 'media_type',
           p_data ->> 'source_url', p_data ->> 'description', p_data ->> 'thumbnail_url',
           coalesce(nullif(p_data ->> 'order_index', '')::int, 0))
        returning to_jsonb(hub_content.*) into v_row;
      else
        update public.hub_content set
          title         = p_data ->> 'title',
          category_slug = p_data ->> 'category_slug',
          media_type    = p_data ->> 'media_type',
          source_url    = p_data ->> 'source_url',
          description   = p_data ->> 'description',
          thumbnail_url = p_data ->> 'thumbnail_url',
          order_index   = coalesce(nullif(p_data ->> 'order_index', '')::int, 0)
        where id::text = v_id
        returning to_jsonb(hub_content.*) into v_row;
      end if;

    when 'nav' then
      if coalesce(p_data ->> 'label', '') = '' or coalesce(p_data ->> 'path', '') = '' then
        return jsonb_build_object('success', false,
          'error', 'A navigation entry needs label and path.');
      end if;
      if v_id is null then
        insert into public.navigation_menu (label, icon, path, order_index, is_active)
        values (p_data ->> 'label', p_data ->> 'icon', p_data ->> 'path',
                coalesce(nullif(p_data ->> 'order_index', '')::int, 0),
                coalesce((p_data ->> 'is_active')::boolean, true))
        returning to_jsonb(navigation_menu.*) into v_row;
      else
        update public.navigation_menu set
          label       = p_data ->> 'label',
          icon        = p_data ->> 'icon',
          path        = p_data ->> 'path',
          order_index = coalesce(nullif(p_data ->> 'order_index', '')::int, 0),
          -- a checkbox that was not rendered leaves the flag alone rather than
          -- silently hiding a link from every visitor
          is_active   = coalesce((p_data ->> 'is_active')::boolean, is_active)
        where id::text = v_id
        returning to_jsonb(navigation_menu.*) into v_row;
      end if;

    when 'social' then
      if coalesce(p_data ->> 'name', '') = '' or coalesce(p_data ->> 'url', '') = '' then
        return jsonb_build_object('success', false,
          'error', 'A social link needs name and url.');
      end if;
      if v_id is null then
        insert into public.social_links (name, url, icon, order_index, is_active, description)
        values (p_data ->> 'name', p_data ->> 'url', p_data ->> 'icon',
                coalesce(nullif(p_data ->> 'order_index', '')::int, 0),
                coalesce((p_data ->> 'is_active')::boolean, true),
                p_data ->> 'description')
        returning to_jsonb(social_links.*) into v_row;
      else
        update public.social_links set
          name        = p_data ->> 'name',
          url         = p_data ->> 'url',
          icon        = p_data ->> 'icon',
          order_index = coalesce(nullif(p_data ->> 'order_index', '')::int, 0),
          is_active   = coalesce((p_data ->> 'is_active')::boolean, is_active),
          description = p_data ->> 'description'
        where id::text = v_id
        returning to_jsonb(social_links.*) into v_row;
      end if;

    when 'policy' then
      if coalesce(p_data ->> 'name', '') = '' then
        return jsonb_build_object('success', false, 'error', 'A policy brief needs a name.');
      end if;
      if v_id is null then
        insert into public.policy_briefs
          (doc_id, name, short_description, status, file_url, source_url)
        values
          (p_data ->> 'doc_id', p_data ->> 'name', p_data ->> 'short_description',
           coalesce(p_data ->> 'status', 'published'), p_data ->> 'file_url',
           p_data ->> 'source_url')
        returning to_jsonb(policy_briefs.*) into v_row;
      else
        update public.policy_briefs set
          doc_id            = p_data ->> 'doc_id',
          name              = p_data ->> 'name',
          short_description = p_data ->> 'short_description',
          status            = coalesce(p_data ->> 'status', status),
          file_url          = p_data ->> 'file_url',
          source_url        = p_data ->> 'source_url'
        where id::text = v_id
        returning to_jsonb(policy_briefs.*) into v_row;
      end if;

    when 'founder' then
      if coalesce(p_data ->> 'name', '') = ''
         or coalesce(p_data ->> 'position', '') = ''
         or coalesce(p_data ->> 'bio', '') = '' then
        return jsonb_build_object('success', false,
          'error', 'A founder entry needs name, position and bio.');
      end if;
      if v_id is null then
        insert into public.founders (name, position, bio, avatar_url, order_index)
        values (p_data ->> 'name', p_data ->> 'position', p_data ->> 'bio',
                p_data ->> 'avatar_url',
                coalesce(nullif(p_data ->> 'order_index', '')::int, 0))
        returning to_jsonb(founders.*) into v_row;
      else
        update public.founders set
          name        = p_data ->> 'name',
          position    = p_data ->> 'position',
          bio         = p_data ->> 'bio',
          avatar_url  = p_data ->> 'avatar_url',
          order_index = coalesce(nullif(p_data ->> 'order_index', '')::int, 0)
        where id::text = v_id
        returning to_jsonb(founders.*) into v_row;
      end if;

    else
      return jsonb_build_object('success', false,
        'error', 'Unknown content kind: ' || coalesce(p_kind, '(null)'));
  end case;

  if v_row is null then
    return jsonb_build_object('success', false, 'error',
      'No ' || p_kind || ' row has that id — it may have been deleted in another tab.');
  end if;

  return jsonb_build_object('success', true, 'data', v_row);
end;
$$;

-- ─────────────────────────────────────────────────────────── delete

create or replace function public.admin_delete_site_item(p_kind text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int := 0;
begin
  if not public.admin_ok() then
    return jsonb_build_object('success', false, 'error', 'Forbidden');
  end if;
  if coalesce(btrim(p_id), '') = '' then
    return jsonb_build_object('success', false, 'error', 'p_id is required');
  end if;

  -- id::text comparison: a malformed id returns "nothing deleted" instead of
  -- raising invalid_text_representation at the caller
  case p_kind
    when 'hub'     then delete from public.hub_content     where id::text = btrim(p_id); get diagnostics v_n = row_count;
    when 'nav'     then delete from public.navigation_menu where id::text = btrim(p_id); get diagnostics v_n = row_count;
    when 'social'  then delete from public.social_links    where id::text = btrim(p_id); get diagnostics v_n = row_count;
    when 'policy'  then delete from public.policy_briefs   where id::text = btrim(p_id); get diagnostics v_n = row_count;
    when 'founder' then delete from public.founders        where id::text = btrim(p_id); get diagnostics v_n = row_count;
    else
      return jsonb_build_object('success', false,
        'error', 'Unknown content kind: ' || coalesce(p_kind, '(null)'));
  end case;

  if v_n = 0 then
    return jsonb_build_object('success', false, 'error', 'Nothing matched that id.');
  end if;
  return jsonb_build_object('success', true, 'data', jsonb_build_object('deleted', v_n));
end;
$$;

-- ─────────────────────────────────────────────────────────── grants

revoke all on function public.admin_get_site_content(text)          from public, anon;
revoke all on function public.admin_save_site_item(text, jsonb)     from public, anon;
revoke all on function public.admin_delete_site_item(text, text)    from public, anon;

notify pgrst, 'reload schema';
