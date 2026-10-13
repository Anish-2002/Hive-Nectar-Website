-- ============================================================================
-- 10 — EXECUTE-PRIVILEGE HARDENING FOR EVERY ADMIN FUNCTION
-- Additive. It changes only *who may call* functions that already refuse
-- non-administrators inside their own bodies; it alters no data and no
-- member-facing behaviour.
-- ============================================================================
-- Why: every admin_* function is SECURITY DEFINER and checks is_admin()/admin_ok()
-- before it does anything, so an anonymous caller could never get a row out of
-- one — but PUBLIC still held EXECUTE on 43 of them. That keeps them listed in
-- the PostgREST OpenAPI document and leaves the refusal to a check inside the
-- function body instead of to the privilege system. This makes the privilege
-- system the FIRST gate, which is where it belongs: an unauthorised call is
-- rejected before the function runs at all.
--
-- Three predicates keep their anon grant on purpose. admin_ok / admin_can /
-- admin_role_of are read by RLS policies and by the retired static admin page,
-- and they disclose nothing beyond the caller's own role.
--
-- Verified after applying: anon EXECUTE on admin_* drops from 43 to 3,
-- authenticated keeps all 65, and admin_ok() called as anon still returns false
-- instead of raising.

begin;

do $$
declare
  r     record;
  kept  text[] := array['admin_ok', 'admin_can', 'admin_role_of'];
  n_rev int := 0;
  n_grt int := 0;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname as name
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname like 'admin\_%'
      and p.prokind = 'f'
      and p.prorettype <> 'pg_catalog.trigger'::regtype
  loop
    if not (r.name = any(kept)) then
      execute format('revoke all on function %s from public', r.sig);
      execute format('revoke all on function %s from anon', r.sig);
      n_rev := n_rev + 1;
    end if;
    execute format('grant execute on function %s to authenticated', r.sig);
    n_grt := n_grt + 1;
  end loop;
  raise notice 'admin_*: % revoked from public/anon, % granted to authenticated', n_rev, n_grt;
end $$;

-- Internal helpers that are not admin_*-prefixed. assert_admin_can is the guard
-- every module calls; log_admin_action is the audit writer. Neither is an API.
revoke all on function public.assert_admin_can(text) from public, anon;
revoke all on function public.log_admin_action(text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
