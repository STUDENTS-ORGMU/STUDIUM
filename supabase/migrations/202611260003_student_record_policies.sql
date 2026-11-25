-- Let a newly created group's owner read it before the first membership row exists.
drop policy if exists "creator reads own group" on public.study_groups;
create policy "creator reads own group" on public.study_groups
for select to authenticated
using (created_by = (select auth.uid()));

-- STUDIUM: allow a group creator to bootstrap their leader membership,
-- and allow students to write only their own submissions and progress.
drop policy if exists "creator adds own leader membership" on public.group_members;
create policy "creator adds own leader membership" on public.group_members
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and role = 'leader'
  and exists (
    select 1 from public.study_groups g
    where g.id = group_members.group_id
      and g.created_by = (select auth.uid())
  )
);

drop policy if exists "students insert own records" on public.group_records;
create policy "students insert own records" on public.group_records
for insert to authenticated
with check (
  public.is_group_member(group_id)
  and owner_user_id = (select auth.uid())
  and (
    (collection_name = 'taskSuggestions' and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name = 'taskProgress' and data->>'userId' = (select auth.uid())::text)
    or (collection_name = 'attendanceResponses' and data->>'userId' = (select auth.uid())::text)
  )
);

drop policy if exists "students update own records" on public.group_records;
create policy "students update own records" on public.group_records
for update to authenticated
using (
  public.is_group_member(group_id)
  and owner_user_id = (select auth.uid())
  and (
    (collection_name = 'taskSuggestions' and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name = 'taskProgress' and data->>'userId' = (select auth.uid())::text)
    or (collection_name = 'attendanceResponses' and data->>'userId' = (select auth.uid())::text)
  )
)
with check (
  public.is_group_member(group_id)
  and owner_user_id = (select auth.uid())
  and (
    (collection_name = 'taskSuggestions' and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name = 'taskProgress' and data->>'userId' = (select auth.uid())::text)
    or (collection_name = 'attendanceResponses' and data->>'userId' = (select auth.uid())::text)
  )
);

drop policy if exists "students delete own suggestions and progress" on public.group_records;
create policy "students delete own suggestions and progress" on public.group_records
for delete to authenticated
using (
  public.is_group_member(group_id)
  and owner_user_id = (select auth.uid())
  and (
    (collection_name = 'taskSuggestions' and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name = 'taskProgress' and data->>'userId' = (select auth.uid())::text)
  )
);
