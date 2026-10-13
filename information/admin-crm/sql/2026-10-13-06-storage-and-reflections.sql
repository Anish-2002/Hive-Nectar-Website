-- ============================================================================
-- 06 — MEDIA UPLOADS (Storage) + REFLECTION TABLE HARDENING
-- Hive Nectar admin CRM · 2026-10-13 · additive migration
-- ----------------------------------------------------------------------------
-- WHY
--   The CRM must let an administrator upload artwork for tokens, milestones and
--   badges, and manage media generally, WITHOUT opening the Supabase dashboard.
--   Live audit (2026-10-13) found:
--     * `badges_admin_insert` (storage.objects, INSERT, authenticated) has an EMPTY
--       `with check` expression and NO bucket_id filter  ->  ANY signed-in member can
--       insert an object into ANY bucket. Over-permissive.
--     * `Badges` has INSERT only  ->  a re-upload (upsert) cannot overwrite.
--     * `Jar`, `Policies`, `Theme image` have NO policies at all  ->  admin upload
--       to those buckets is currently impossible.
--     * `public.task_sigma_logs` (member reflections) has RLS DISABLED and 0 policies
--       ->  any authenticated client can read AND write every member's reflections.
--       This migration adds an owner-scoped UPDATE path for the new
--       Pending/Submitted reflection UI, so the table is closed in the same step.
--
-- WHAT THIS DOES NOT TOUCH
--   No member-facing behaviour. `Token` policies are already correct and are left
--   alone. No table columns are changed. No RPC is changed: `admin_save_token` and
--   `admin_save_milestone` already carry `icon_url` through both their INSERT and
--   their UPDATE branch.
--
-- ROLLBACK
--   drop policy badges_admin_insert on storage.objects;  (then restore the old
--   unscoped form) and `alter table public.task_sigma_logs disable row level security;`
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Badges: replace the unscoped INSERT with a properly scoped admin trio
-- ---------------------------------------------------------------------------
drop policy if exists badges_admin_insert on storage.objects;
drop policy if exists badges_admin_update on storage.objects;
drop policy if exists badges_admin_delete on storage.objects;

create policy badges_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'Badges' and public.storage_admin());

create policy badges_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'Badges' and public.storage_admin())
  with check (bucket_id = 'Badges' and public.storage_admin());

create policy badges_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'Badges' and public.storage_admin());


-- ---------------------------------------------------------------------------
-- 2. Admin write access on the remaining content buckets
--    Jar (lid decorations) · Policies (policy files) · Theme image (theme art)
--    All three are public:true, so objects are served without a SELECT policy.
-- ---------------------------------------------------------------------------
do $do$
declare
  b text;
  slug text;
begin
  foreach b in array array['Jar', 'Policies', 'Theme image']
  loop
    slug := lower(replace(b, ' ', '_'));

    execute format('drop policy if exists %I on storage.objects', slug || '_admin_insert');
    execute format('drop policy if exists %I on storage.objects', slug || '_admin_update');
    execute format('drop policy if exists %I on storage.objects', slug || '_admin_delete');

    execute format(
      'create policy %I on storage.objects for insert to authenticated '
      'with check (bucket_id = %L and public.storage_admin())',
      slug || '_admin_insert', b);

    execute format(
      'create policy %I on storage.objects for update to authenticated '
      'using (bucket_id = %L and public.storage_admin()) '
      'with check (bucket_id = %L and public.storage_admin())',
      slug || '_admin_update', b, b);

    execute format(
      'create policy %I on storage.objects for delete to authenticated '
      'using (bucket_id = %L and public.storage_admin())',
      slug || '_admin_delete', b);
  end loop;
end
$do$;


-- ---------------------------------------------------------------------------
-- 3. task_sigma_logs: close a fully-open table (owner-only access)
--    Members read/insert/update/delete ONLY their own reflections; admins may
--    read all rows. The admin CRM reads through SECURITY DEFINER RPCs anyway.
-- ---------------------------------------------------------------------------
alter table public.task_sigma_logs enable row level security;

drop policy if exists task_sigma_logs_select_own on public.task_sigma_logs;
drop policy if exists task_sigma_logs_insert_own on public.task_sigma_logs;
drop policy if exists task_sigma_logs_update_own on public.task_sigma_logs;
drop policy if exists task_sigma_logs_delete_own on public.task_sigma_logs;

create policy task_sigma_logs_select_own on public.task_sigma_logs
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy task_sigma_logs_insert_own on public.task_sigma_logs
  for insert to authenticated
  with check (user_id = auth.uid());

create policy task_sigma_logs_update_own on public.task_sigma_logs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy task_sigma_logs_delete_own on public.task_sigma_logs
  for delete to authenticated
  using (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- PostgREST schema cache
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
