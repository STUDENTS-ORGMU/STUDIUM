-- STUDIUM: multi-group schema.
-- Run this migration once in Supabase SQL Editor. Client code uses only the publishable/anon key.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  study_cycle_start date not null default date_trunc('week', current_date)::date,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('leader', 'student')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  subject text not null check (char_length(btrim(subject)) between 1 and 120),
  weekday smallint not null check (weekday between 1 and 6),
  week_number smallint not null default 1 check (week_number in (1, 2)),
  starts_at time not null,
  ends_at time,
  room text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create table if not exists public.task_suggestions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  submitted_by uuid not null references auth.users(id) on delete cascade,
  subject text not null default '',
  title text not null check (char_length(btrim(title)) between 1 and 180),
  description text not null default '',
  lesson_date date,
  due_date date,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (due_date is null or lesson_date is null or due_date >= lesson_date)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  subject text not null default '',
  title text not null check (char_length(btrim(title)) between 1 and 180),
  description text not null default '',
  lesson_date date,
  due_date date,
  created_by uuid not null references auth.users(id),
  source_suggestion_id uuid unique references public.task_suggestions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date is null or lesson_date is null or due_date >= lesson_date)
);

create table if not exists public.student_task_progress (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create table if not exists public.attendance_responses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_date date not null,
  response text not null check (response in ('will_attend', 'will_miss')),
  updated_at timestamptz not null default now(),
  unique (lesson_id, lesson_date, user_id)
);

-- Actual attendance is separate from students' preliminary responses.
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  lesson_date date not null,
  status text not null check (status in ('present', 'absent', 'late', 'excused')),
  note text not null default '',
  marked_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (lesson_id, lesson_date, student_id)
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  subject text not null default '',
  title text not null,
  description text not null default '',
  external_url text,
  storage_path text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (nullif(external_url, '') is not null or nullif(storage_path, '') is not null)
);

create table if not exists public.lectures (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  subject text not null default '',
  title text not null,
  description text not null default '',
  external_url text,
  storage_path text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (nullif(external_url, '') is not null or nullif(storage_path, '') is not null)
);

create index if not exists idx_group_members_user on public.group_members(user_id);
create index if not exists idx_lessons_group_schedule on public.lessons(group_id, weekday, week_number, starts_at);
create index if not exists idx_tasks_group_due on public.tasks(group_id, due_date);
create index if not exists idx_suggestions_group_status on public.task_suggestions(group_id, status, created_at desc);
create index if not exists idx_attendance_responses_group_date on public.attendance_responses(group_id, lesson_date);
create index if not exists idx_attendance_records_group_date on public.attendance_records(group_id, lesson_date);

-- Keep profile creation inside the Auth signup transaction.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- SECURITY DEFINER helpers avoid recursive RLS evaluation on group_members.
create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()
  );
$$;

create or replace function public.is_group_leader(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid() and gm.role = 'leader'
  );
$$;

create or replace function public.can_view_profile(p_profile_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_profile_id = auth.uid() or exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = p_profile_id
  );
$$;

create or replace function public.create_group(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then raise exception 'Необходима авторизация'; end if;
  if p_name is null or char_length(btrim(p_name)) < 2 or char_length(btrim(p_name)) > 80 then
    raise exception 'Название группы должно содержать от 2 до 80 символов';
  end if;
  insert into public.groups(name, created_by)
  values (btrim(p_name), auth.uid())
  returning id into v_group_id;
  insert into public.group_members(group_id, user_id, role)
  values (v_group_id, auth.uid(), 'leader');
  return v_group_id;
end;
$$;

create or replace function public.join_group(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then raise exception 'Необходима авторизация'; end if;
  select id into v_group_id
  from public.groups
  where invite_code = upper(btrim(coalesce(p_invite_code, '')));
  if v_group_id is null then raise exception 'Код приглашения не найден'; end if;
  insert into public.group_members(group_id, user_id, role)
  values (v_group_id, auth.uid(), 'student')
  on conflict (group_id, user_id) do nothing;
  return v_group_id;
end;
$$;

create or replace function public.review_task_suggestion(
  p_suggestion_id uuid,
  p_approve boolean,
  p_title text default null,
  p_subject text default null,
  p_description text default null,
  p_lesson_date date default null,
  p_due_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suggestion public.task_suggestions%rowtype;
  v_task_id uuid;
begin
  if auth.uid() is null then raise exception 'Необходима авторизация'; end if;

  select * into v_suggestion
  from public.task_suggestions
  where id = p_suggestion_id
  for update;

  if not found then raise exception 'Предложение не найдено'; end if;
  if not public.is_group_leader(v_suggestion.group_id) then
    raise exception 'Только староста может рассматривать предложения';
  end if;
  if v_suggestion.status <> 'pending' then
    raise exception 'Это предложение уже рассмотрено';
  end if;

  if p_approve then
    insert into public.tasks (
      group_id, subject, title, description, lesson_date, due_date, created_by, source_suggestion_id
    ) values (
      v_suggestion.group_id,
      coalesce(nullif(btrim(p_subject), ''), v_suggestion.subject),
      coalesce(nullif(btrim(p_title), ''), v_suggestion.title),
      coalesce(p_description, v_suggestion.description),
      coalesce(p_lesson_date, v_suggestion.lesson_date),
      coalesce(p_due_date, v_suggestion.due_date),
      auth.uid(),
      v_suggestion.id
    ) returning id into v_task_id;

    update public.task_suggestions
    set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
    where id = v_suggestion.id;
    return v_task_id;
  else
    update public.task_suggestions
    set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
    where id = v_suggestion.id;
    return null;
  end if;
end;
$$;

-- Enable RLS on every application table.
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.lessons enable row level security;
alter table public.task_suggestions enable row level security;
alter table public.tasks enable row level security;
alter table public.student_task_progress enable row level security;
alter table public.attendance_responses enable row level security;
alter table public.attendance_records enable row level security;
alter table public.materials enable row level security;
alter table public.lectures enable row level security;

-- Profiles.
drop policy if exists profiles_read_group on public.profiles;
create policy profiles_read_group on public.profiles for select to authenticated
using (public.can_view_profile(id));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

-- Groups and membership.
drop policy if exists groups_read_member on public.groups;
create policy groups_read_member on public.groups for select to authenticated
using (public.is_group_member(id));
drop policy if exists groups_update_leader on public.groups;
create policy groups_update_leader on public.groups for update to authenticated
using (public.is_group_leader(id)) with check (public.is_group_leader(id));
drop policy if exists members_read_group on public.group_members;
create policy members_read_group on public.group_members for select to authenticated
using (public.is_group_member(group_id));

-- Lessons.
drop policy if exists lessons_read_member on public.lessons;
create policy lessons_read_member on public.lessons for select to authenticated
using (public.is_group_member(group_id));
drop policy if exists lessons_insert_leader on public.lessons;
create policy lessons_insert_leader on public.lessons for insert to authenticated
with check (public.is_group_leader(group_id) and created_by = auth.uid());
drop policy if exists lessons_update_leader on public.lessons;
create policy lessons_update_leader on public.lessons for update to authenticated
using (public.is_group_leader(group_id)) with check (public.is_group_leader(group_id));
drop policy if exists lessons_delete_leader on public.lessons;
create policy lessons_delete_leader on public.lessons for delete to authenticated
using (public.is_group_leader(group_id));

-- Published homework.
drop policy if exists tasks_read_member on public.tasks;
create policy tasks_read_member on public.tasks for select to authenticated
using (public.is_group_member(group_id));
drop policy if exists tasks_insert_leader on public.tasks;
create policy tasks_insert_leader on public.tasks for insert to authenticated
with check (public.is_group_leader(group_id) and created_by = auth.uid());
drop policy if exists tasks_update_leader on public.tasks;
create policy tasks_update_leader on public.tasks for update to authenticated
using (public.is_group_leader(group_id)) with check (public.is_group_leader(group_id));
drop policy if exists tasks_delete_leader on public.tasks;
create policy tasks_delete_leader on public.tasks for delete to authenticated
using (public.is_group_leader(group_id));

-- Suggestions can only be created by their author. Moderation is RPC-only.
drop policy if exists suggestions_read_own_or_leader on public.task_suggestions;
create policy suggestions_read_own_or_leader on public.task_suggestions for select to authenticated
using (submitted_by = auth.uid() or public.is_group_leader(group_id));
drop policy if exists suggestions_insert_member on public.task_suggestions;
create policy suggestions_insert_member on public.task_suggestions for insert to authenticated
with check (
  submitted_by = auth.uid()
  and status = 'pending'
  and reviewed_by is null
  and public.is_group_member(group_id)
);

-- Personal progress. Leaders may read progress for their group, students only their own.
drop policy if exists progress_read_self_or_leader on public.student_task_progress;
create policy progress_read_self_or_leader on public.student_task_progress for select to authenticated
using (
  user_id = auth.uid()
  or exists (select 1 from public.tasks t where t.id = task_id and public.is_group_leader(t.group_id))
);
drop policy if exists progress_insert_self on public.student_task_progress;
create policy progress_insert_self on public.student_task_progress for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (select 1 from public.tasks t where t.id = task_id and public.is_group_member(t.group_id))
);
drop policy if exists progress_update_self on public.student_task_progress;
create policy progress_update_self on public.student_task_progress for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (select 1 from public.tasks t where t.id = task_id and public.is_group_member(t.group_id))
);
drop policy if exists progress_delete_self on public.student_task_progress;
create policy progress_delete_self on public.student_task_progress for delete to authenticated
using (user_id = auth.uid());

-- Preliminary attendance responses are separate from the official register.
drop policy if exists attendance_responses_read_self_or_leader on public.attendance_responses;
create policy attendance_responses_read_self_or_leader on public.attendance_responses for select to authenticated
using (user_id = auth.uid() or public.is_group_leader(group_id));
drop policy if exists attendance_responses_insert_self on public.attendance_responses;
create policy attendance_responses_insert_self on public.attendance_responses for insert to authenticated
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
  and exists (
    select 1 from public.lessons l
    where l.id = lesson_id and l.group_id = attendance_responses.group_id
  )
);
drop policy if exists attendance_responses_update_self on public.attendance_responses;
create policy attendance_responses_update_self on public.attendance_responses for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and public.is_group_member(group_id)
  and exists (
    select 1 from public.lessons l
    where l.id = lesson_id and l.group_id = attendance_responses.group_id
  )
);

-- Official attendance can be viewed and edited only by leaders.
drop policy if exists attendance_records_read_leader on public.attendance_records;
create policy attendance_records_read_leader on public.attendance_records for select to authenticated
using (public.is_group_leader(group_id));
drop policy if exists attendance_records_insert_leader on public.attendance_records;
create policy attendance_records_insert_leader on public.attendance_records for insert to authenticated
with check (
  public.is_group_leader(group_id)
  and marked_by = auth.uid()
  and exists (
    select 1 from public.group_members gm
    where gm.group_id = attendance_records.group_id and gm.user_id = attendance_records.student_id
  )
  and exists (
    select 1 from public.lessons l
    where l.id = attendance_records.lesson_id and l.group_id = attendance_records.group_id
  )
);
drop policy if exists attendance_records_update_leader on public.attendance_records;
create policy attendance_records_update_leader on public.attendance_records for update to authenticated
using (public.is_group_leader(group_id))
with check (
  public.is_group_leader(group_id)
  and marked_by = auth.uid()
  and exists (
    select 1 from public.group_members gm
    where gm.group_id = attendance_records.group_id and gm.user_id = attendance_records.student_id
  )
);
drop policy if exists attendance_records_delete_leader on public.attendance_records;
create policy attendance_records_delete_leader on public.attendance_records for delete to authenticated
using (public.is_group_leader(group_id));

-- Materials and lectures are visible to group members, managed by leaders.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['materials', 'lectures'] loop
    execute format('drop policy if exists %I on public.%I', tbl || '_read_member', tbl);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_group_member(group_id))', tbl || '_read_member', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_insert_leader', tbl);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_group_leader(group_id) and created_by = auth.uid())', tbl || '_insert_leader', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_update_leader', tbl);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_group_leader(group_id)) with check (public.is_group_leader(group_id))', tbl || '_update_leader', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_delete_leader', tbl);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_group_leader(group_id))', tbl || '_delete_leader', tbl);
  end loop;
end $$;

-- Explicit function privileges. Security checks are performed inside SECURITY DEFINER functions.
revoke all on function public.handle_new_user() from public;
revoke all on function public.is_group_member(uuid) from public;
revoke all on function public.is_group_leader(uuid) from public;
revoke all on function public.can_view_profile(uuid) from public;
revoke all on function public.create_group(text) from public;
revoke all on function public.join_group(text) from public;
revoke all on function public.review_task_suggestion(uuid, boolean, text, text, text, date, date) from public;
grant execute on function public.is_group_member(uuid) to authenticated;
grant execute on function public.is_group_leader(uuid) to authenticated;
grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.create_group(text) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.review_task_suggestion(uuid, boolean, text, text, text, date, date) to authenticated;

-- Table privileges; RLS remains the authorization boundary.
grant select, update on public.profiles to authenticated;
grant select, update on public.groups to authenticated;
grant select on public.group_members to authenticated;
grant select, insert, update, delete on public.lessons to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert on public.task_suggestions to authenticated;
grant select, insert, update, delete on public.student_task_progress to authenticated;
grant select, insert, update on public.attendance_responses to authenticated;
grant select, insert, update, delete on public.attendance_records to authenticated;
grant select, insert, update, delete on public.materials to authenticated;
grant select, insert, update, delete on public.lectures to authenticated;
