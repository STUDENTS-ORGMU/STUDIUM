-- Fix student attendance response writes. Ownership is determined by the
-- authenticated user ID embedded in the response, and group membership is
-- checked independently. This remains limited to the student's own response.
drop policy if exists "students insert own records" on public.group_records;
create policy "students insert own records" on public.group_records
for insert to authenticated
with check (
  public.is_group_member(group_id)
  and (
    (collection_name = 'taskSuggestions' and owner_user_id = (select auth.uid()) and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name in ('taskProgress','attendanceResponses') and data->>'userId' = (select auth.uid())::text)
  )
);

drop policy if exists "students update own records" on public.group_records;
create policy "students update own records" on public.group_records
for update to authenticated
using (
  public.is_group_member(group_id)
  and (
    (collection_name = 'taskSuggestions' and owner_user_id = (select auth.uid()) and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name in ('taskProgress','attendanceResponses') and data->>'userId' = (select auth.uid())::text)
  )
)
with check (
  public.is_group_member(group_id)
  and (
    (collection_name = 'taskSuggestions' and owner_user_id = (select auth.uid()) and data->>'submittedBy' = (select auth.uid())::text)
    or (collection_name in ('taskProgress','attendanceResponses') and data->>'userId' = (select auth.uid())::text)
  )
);
