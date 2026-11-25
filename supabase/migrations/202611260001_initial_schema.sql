-- STUDIUM Supabase-only schema foundation.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text unique, full_name text not null default '', patronymic text not null default '',
 data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.study_groups (
 id text primary key, name text not null,
 created_by uuid references public.profiles(id) on delete set null,
 data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.group_members (
 group_id text not null references public.study_groups(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,
 role text not null check(role in ('leader','student')), display_name text not null default '',
 legacy_firebase_uid text, data jsonb not null default '{}'::jsonb,
 joined_at timestamptz not null default now(), primary key(group_id,user_id)
);
create table if not exists public.invite_codes (
 code text primary key, group_id text not null references public.study_groups(id) on delete cascade,
 created_by uuid references public.profiles(id) on delete set null,
 data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
-- Shared JSONB record store for tasks, taskSuggestions, taskProgress, lessons,
-- attendanceResponses, attendanceRecords, materials, lectures and future collections.
create table if not exists public.group_records (
 group_id text not null references public.study_groups(id) on delete cascade,
 collection_name text not null, record_id text not null,
 owner_user_id uuid references public.profiles(id) on delete set null,
 data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(group_id,collection_name,record_id)
);
create index if not exists group_records_collection_idx on public.group_records(group_id,collection_name);
create index if not exists group_records_data_gin_idx on public.group_records using gin(data);
create index if not exists group_members_user_idx on public.group_members(user_id);

create or replace function public.is_group_member(target_group_id text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.group_members m where m.group_id=target_group_id and m.user_id=auth.uid());
$$;
create or replace function public.is_group_leader(target_group_id text)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.group_members m where m.group_id=target_group_id and m.user_id=auth.uid() and m.role='leader');
$$;

alter table public.profiles enable row level security;
alter table public.study_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.invite_codes enable row level security;
alter table public.group_records enable row level security;

drop policy if exists "profile self or group peer read" on public.profiles;
create policy "profile self or group peer read" on public.profiles for select to authenticated using (
 id=auth.uid() or exists(select 1 from public.group_members a join public.group_members b on a.group_id=b.group_id where a.user_id=auth.uid() and b.user_id=profiles.id)
);
drop policy if exists "profile self insert" on public.profiles;
create policy "profile self insert" on public.profiles for insert to authenticated with check(id=auth.uid());
drop policy if exists "profile self update" on public.profiles;
create policy "profile self update" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());

drop policy if exists "group member read" on public.study_groups;
create policy "group member read" on public.study_groups for select to authenticated using(public.is_group_member(id));
drop policy if exists "creator insert group" on public.study_groups;
create policy "creator insert group" on public.study_groups for insert to authenticated with check(created_by=auth.uid());
drop policy if exists "leader update group" on public.study_groups;
create policy "leader update group" on public.study_groups for update to authenticated using(public.is_group_leader(id)) with check(public.is_group_leader(id));

drop policy if exists "member list in group" on public.group_members;
create policy "member list in group" on public.group_members for select to authenticated using(public.is_group_member(group_id));
drop policy if exists "leader manages members" on public.group_members;
create policy "leader manages members" on public.group_members for all to authenticated using(public.is_group_leader(group_id)) with check(public.is_group_leader(group_id));
drop policy if exists "user joins as self" on public.group_members;
create policy "user joins as self" on public.group_members for insert to authenticated with check(user_id=auth.uid() and role='student');

-- Do not grant table SELECT on invite_codes: expose only exact-code lookup via RPC.
drop policy if exists "authenticated exact invite lookup" on public.invite_codes;
create or replace function public.lookup_invite_code(p_code text)
returns text language sql stable security definer set search_path=public as 'select group_id from public.invite_codes where code = p_code limit 1';
revoke all on function public.lookup_invite_code(text) from public;
grant execute on function public.lookup_invite_code(text) to authenticated;
drop policy if exists "leader manages invite codes" on public.invite_codes;
create policy "leader manages invite codes" on public.invite_codes for all to authenticated using(public.is_group_leader(group_id)) with check(public.is_group_leader(group_id));

drop policy if exists "members read records" on public.group_records;
create policy "members read records" on public.group_records for select to authenticated using(public.is_group_member(group_id));
drop policy if exists "leaders insert records" on public.group_records;
create policy "leaders insert records" on public.group_records for insert to authenticated with check(public.is_group_leader(group_id));
drop policy if exists "leaders update records" on public.group_records;
create policy "leaders update records" on public.group_records for update to authenticated using(public.is_group_leader(group_id)) with check(public.is_group_leader(group_id));
drop policy if exists "leaders delete records" on public.group_records;
create policy "leaders delete records" on public.group_records for delete to authenticated using(public.is_group_leader(group_id));

insert into storage.buckets(id,name,public,file_size_limit)
values('group-materials','group-materials',false,52428800) on conflict(id) do nothing;
drop policy if exists "group members read files" on storage.objects;
create policy "group members read files" on storage.objects for select to authenticated using(bucket_id='group-materials' and public.is_group_member((storage.foldername(name))[1]));
drop policy if exists "leaders upload files" on storage.objects;
create policy "leaders upload files" on storage.objects for insert to authenticated with check(bucket_id='group-materials' and public.is_group_leader((storage.foldername(name))[1]));
drop policy if exists "leaders update files" on storage.objects;
create policy "leaders update files" on storage.objects for update to authenticated using(bucket_id='group-materials' and public.is_group_leader((storage.foldername(name))[1])) with check(bucket_id='group-materials' and public.is_group_leader((storage.foldername(name))[1]));
drop policy if exists "leaders delete files" on storage.objects;
create policy "leaders delete files" on storage.objects for delete to authenticated using(bucket_id='group-materials' and public.is_group_leader((storage.foldername(name))[1]));
