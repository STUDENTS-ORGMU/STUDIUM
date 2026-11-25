-- Require a fresh password sign-in before changing the login identifier.
create or replace function public.change_my_username(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  next_username text := lower(trim(p_username));
  current_email text;
  authenticated_at bigint := coalesce((auth.jwt() ->> 'auth_time')::bigint, 0);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if authenticated_at < extract(epoch from now())::bigint - 300 then
    raise exception 'Recent authentication required';
  end if;
  if next_username !~ '^[a-z0-9][a-z0-9._-]{2,23}$' then
    raise exception 'Invalid username';
  end if;

  update public.profiles
  set username = next_username, updated_at = now()
  where id = auth.uid();
  if not found then raise exception 'Profile not found'; end if;

  update public.username_logins
  set username = next_username
  where user_id = auth.uid();

  if not found then
    select email into current_email from auth.users where id = auth.uid();
    if current_email is null then raise exception 'Auth email not found'; end if;
    insert into public.username_logins(username, auth_email, user_id)
    values(next_username, current_email, auth.uid());
  end if;
end;
$$;
revoke all on function public.change_my_username(text) from public, anon;
grant execute on function public.change_my_username(text) to authenticated;
