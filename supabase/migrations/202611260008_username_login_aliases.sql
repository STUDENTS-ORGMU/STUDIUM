-- Keep username-based login stable even after a user changes their username.
create table if not exists public.username_logins (
  username text primary key,
  auth_email text not null unique,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint username_logins_username_format check (username = lower(trim(username)) and username ~ '^[a-z0-9][a-z0-9._-]{2,23}$')
);
alter table public.username_logins enable row level security;
revoke all on table public.username_logins from anon, authenticated;
grant insert, update on table public.username_logins to authenticated;
drop policy if exists "user registers own login alias" on public.username_logins;
create policy "user registers own login alias" on public.username_logins
for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "user updates own login alias" on public.username_logins;
create policy "user updates own login alias" on public.username_logins
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create or replace function public.resolve_login_email(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select auth_email
  from public.username_logins
  where username = lower(trim(p_username))
  limit 1;
$$;
revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;
