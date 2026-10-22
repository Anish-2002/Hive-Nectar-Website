-- 17 - reflections queue de-duplication (read layer only)
--
-- admin_get_reflections LEFT JOINed public.user_tasks on (task_id, user_id) and
-- public.member_reviews on (source, source_id). public.user_tasks currently holds
-- duplicate (task_id, user_id) pairs, so the join fanned out and the same
-- reflection came back twice (a row id repeated, React warned about duplicate
-- keys) while "total" counted 3.
--
-- The read layer is made tolerant instead of touching member data: the joins
-- become lateral single-row lookups and the count is DISTINCT. No member row,
-- task row, nectar or achievement value is modified.

CREATE OR REPLACE FUNCTION public.admin_get_reflections(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows  jsonb;
  v_total bigint;
begin
  perform public.assert_admin_can('review.read');
  if p_status is not null and p_status not in ('new', 'in_review', 'needs_clarification', 'reviewed', 'flagged', 'unreviewed') then
    return jsonb_build_object('success', false, 'error', 'Invalid status');
  end if;

  select count(distinct l.id) into v_total
    from public.task_sigma_logs l
    left join lateral (
           select r.* from public.member_reviews r
            where r.source = 'task_reflection' and r.source_id = l.id::text
            order by r.updated_at desc nulls last
            limit 1
         ) r on true
   where p_status is null
      or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
      or r.status = p_status;

  select coalesce(jsonb_agg(x.obj order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select l.created_at,
             jsonb_build_object(
               'id', l.id,
               'kind', 'task_reflection',
               'created_at', l.created_at,
               'user_id', l.user_id,
               'user_email', p.email,
               'user_name', coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.username, p.email),
               'task_id', l.task_id,
               'task_title', t.task_title,
               'task_stage', t.stage,
               'theme_id', t.theme_id,
               'completed_at', ut.completed_at,
               'define', l.define, 'measure', l.measure, 'analysis', l.analysis,
               'improve', l.improve, 'control', l.control,
               'review_id', r.id,
               'review_status', coalesce(r.status, 'unreviewed'),
               'assignee_id', r.assignee_id,
               'reviewer_id', r.reviewer_id,
               'reviewed_at', r.reviewed_at,
               'clarification_requested_at', r.clarification_requested_at,
               'flagged_reason', r.flagged_reason,
               'internal_notes', r.internal_notes,
               'member_response', r.member_response,
               'member_response_delivery', r.member_response_delivery,
               'nominated_recognition_id', r.nominated_recognition_id
             ) as obj
        from public.task_sigma_logs l
        left join public.tasks t on t.id = l.task_id
        left join lateral (
           select ut.completed_at from public.user_tasks ut
            where ut.task_id = l.task_id and ut.user_id = l.user_id
            order by ut.completed_at desc nulls last
            limit 1
         ) ut on true
        left join public.profiles p on p.id = l.user_id
        left join lateral (
           select r.* from public.member_reviews r
            where r.source = 'task_reflection' and r.source_id = l.id::text
            order by r.updated_at desc nulls last
            limit 1
         ) r on true
       where p_status is null
          or (p_status = 'unreviewed' and (r.status is null or r.status = 'new'))
          or r.status = p_status
       order by l.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
      offset greatest(0, coalesce(p_offset, 0))
    ) x;

  return jsonb_build_object(
    'success', true, 'count', coalesce(jsonb_array_length(v_rows), 0),
    'total', v_total, 'rows', v_rows,
    'note', 'Reflections are stored in task_sigma_logs (DMAIC columns). Reading a reflection never changes nectar or achievements.'
  );
end;
$function$

NOTIFY pgrst, 'reload schema';
