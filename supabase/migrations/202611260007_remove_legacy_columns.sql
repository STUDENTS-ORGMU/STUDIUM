-- No legacy backend identity mapping is needed for this clean Supabase start.
alter table public.profiles
  drop column if exists legacy_firebase_uid,
  drop column if exists legacy_auth_email;
alter table public.study_groups
  drop column if exists legacy_created_by;
alter table public.group_members
  drop column if exists legacy_firebase_uid;
alter table public.group_records
  drop column if exists legacy_owner_uid;
