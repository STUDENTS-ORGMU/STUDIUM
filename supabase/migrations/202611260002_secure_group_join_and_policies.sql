-- Tighten group membership onboarding.
drop policy if exists "user joins as self" on public.group_members;
create or replace function public.join_group_with_invite(p_code text, p_display_name text default '')
returns text language plpgsql security definer set search_path=public as $join$
declare target_group_id text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select group_id into target_group_id from public.invite_codes
  where code=upper(trim(p_code)) limit 1;
  if target_group_id is null then raise exception 'Invalid invite code'; end if;
  insert into public.group_members(group_id,user_id,role,display_name)
  values(target_group_id,auth.uid(),'student',left(coalesce(p_display_name,''),120))
  on conflict(group_id,user_id) do nothing;
  return target_group_id;
end;
$join$;
revoke all on function public.join_group_with_invite(text,text) from public,anon;
grant execute on function public.join_group_with_invite(text,text) to authenticated;
revoke all on function public.is_group_member(text) from public,anon;
revoke all on function public.is_group_leader(text) from public,anon;
grant execute on function public.is_group_member(text) to authenticated;
grant execute on function public.is_group_leader(text) to authenticated;
revoke all on function public.lookup_invite_code(text) from public,anon,authenticated;
create index if not exists group_records_owner_user_idx on public.group_records(owner_user_id);
create index if not exists invite_codes_created_by_idx on public.invite_codes(created_by);
create index if not exists invite_codes_group_id_idx on public.invite_codes(group_id);
create index if not exists study_groups_created_by_idx on public.study_groups(created_by);
drop policy if exists "profile self insert" on public.profiles;
create policy "profile self insert" on public.profiles for insert to authenticated
with check(id=(select auth.uid()));
drop policy if exists "profile self update" on public.profiles;
create policy "profile self update" on public.profiles for update to authenticated
using(id=(select auth.uid())) with check(id=(select auth.uid()));
drop policy if exists "creator insert group" on public.study_groups;
create policy "creator insert group" on public.study_groups for insert to authenticated
with check(created_by=(select auth.uid()));
