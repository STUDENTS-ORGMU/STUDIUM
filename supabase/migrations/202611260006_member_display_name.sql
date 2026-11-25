-- Let users change their own visible group name without granting role escalation.
drop policy if exists "member updates own display name" on public.group_members;
create policy "member updates own display name" on public.group_members
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

revoke update on table public.group_members from authenticated;
grant update(display_name) on table public.group_members to authenticated;
