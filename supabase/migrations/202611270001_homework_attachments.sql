-- Allow authenticated members to upload homework attachments into their own group's folder.
-- Members can upload but cannot replace/delete files; leaders retain existing management policies.
drop policy if exists "group members upload homework attachments" on storage.objects;
create policy "group members upload homework attachments"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'group-materials'
  and (storage.foldername(name))[2] = 'homework'
  and public.is_group_member((storage.foldername(name))[1])
);
