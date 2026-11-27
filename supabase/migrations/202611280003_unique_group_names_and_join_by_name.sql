-- Require globally unique group names (case-insensitive, ignoring surrounding spaces)
-- and allow authenticated students to join by the exact group name.
create unique index if not exists study_groups_name_unique_idx
  on public.study_groups (lower(btrim(name)));

create or replace function public.join_group_by_name(
  p_group_name text,
  p_display_name text default ''
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target_group_id text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if nullif(btrim(p_group_name), '') is null then
    raise exception 'Group name is required';
  end if;

  select id into target_group_id
  from public.study_groups
  where lower(btrim(name)) = lower(btrim(p_group_name))
  limit 1;

  if target_group_id is null then
    raise exception 'Group not found';
  end if;

  insert into public.group_members(group_id, user_id, role, display_name)
  values (target_group_id, auth.uid(), 'student', left(coalesce(p_display_name, ''), 120))
  on conflict (group_id, user_id) do nothing;

  return target_group_id;
end;
$$;

revoke all on function public.join_group_by_name(text, text) from public, anon;
grant execute on function public.join_group_by_name(text, text) to authenticated;
