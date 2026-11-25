-- Return invite codes only to the authenticated leader of each corresponding group.
create or replace function public.get_my_group_invite_codes()
returns table(group_id text, code text)
language sql
stable
security definer
set search_path = public
as $$
  select i.group_id, i.code
  from public.invite_codes i
  join public.group_members m
    on m.group_id = i.group_id
   and m.user_id = auth.uid()
   and m.role = 'leader'
  where i.created_by = auth.uid();
$$;
revoke all on function public.get_my_group_invite_codes() from public, anon;
grant execute on function public.get_my_group_invite_codes() to authenticated;
