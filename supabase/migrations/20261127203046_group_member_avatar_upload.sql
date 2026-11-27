alter table public.group_members add column if not exists avatar_path text;

drop policy if exists "Users can upload own avatar objects" on storage.objects;
create policy "Users can upload own avatar objects"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'avatars'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (
      public.is_group_leader((storage.foldername(name))[1])
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = (storage.foldername(name))[1]
          and gm.user_id::text = (storage.foldername(name))[2]
      )
    )
  )
);

drop policy if exists "Users can update own avatar objects" on storage.objects;
create policy "Users can update own avatar objects"
on storage.objects for update to authenticated
using (
  bucket_id = 'avatars'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (
      public.is_group_leader((storage.foldername(name))[1])
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = (storage.foldername(name))[1]
          and gm.user_id::text = (storage.foldername(name))[2]
      )
    )
  )
)
with check (
  bucket_id = 'avatars'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (
      public.is_group_leader((storage.foldername(name))[1])
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = (storage.foldername(name))[1]
          and gm.user_id::text = (storage.foldername(name))[2]
      )
    )
  )
);

drop policy if exists "Users can delete own avatar objects" on storage.objects;
create policy "Users can delete own avatar objects"
on storage.objects for delete to authenticated
using (
  bucket_id = 'avatars'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (
      public.is_group_leader((storage.foldername(name))[1])
      and exists (
        select 1 from public.group_members gm
        where gm.group_id = (storage.foldername(name))[1]
          and gm.user_id::text = (storage.foldername(name))[2]
      )
    )
  )
);
