-- Supabase projects created after the Data API exposure change require
-- explicit table privileges in addition to RLS policies.
grant usage on schema public to authenticated;
grant select, insert, update, delete on table
  public.profiles,
  public.study_groups,
  public.group_members,
  public.invite_codes,
  public.group_records
to authenticated;
