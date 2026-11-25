-- Backfill login aliases for accounts created before the alias table existed.
insert into public.username_logins(username, auth_email, user_id)
select lower(trim(p.username)), u.email, u.id
from public.profiles p
join auth.users u on u.id = p.id
where p.username is not null
  and p.username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,23}$'
  and u.email is not null
on conflict do nothing;

-- A username is occupied if it belongs to any profile, even if an older account
-- has not yet signed in since the alias table was introduced.
create or replace function public.resolve_login_email(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select auth_email from public.username_logins where username = lower(trim(p_username)) limit 1),
    (select u.email
       from public.profiles p
       join auth.users u on u.id = p.id
      where lower(p.username) = lower(trim(p_username))
      limit 1)
  );
$$;
revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;
