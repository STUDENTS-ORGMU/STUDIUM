alter table public.profiles
  add column if not exists appearance_theme text not null default 'mono',
  add column if not exists appearance_mode text not null default 'light';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_appearance_theme_check') then
    alter table public.profiles add constraint profiles_appearance_theme_check
      check (appearance_theme in ('mono','bluegray','beige','olive','slate','sand','forest','lavender'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_appearance_mode_check') then
    alter table public.profiles add constraint profiles_appearance_mode_check
      check (appearance_mode in ('light','dark'));
  end if;
end $$;

grant update (appearance_theme, appearance_mode) on table public.profiles to authenticated;
