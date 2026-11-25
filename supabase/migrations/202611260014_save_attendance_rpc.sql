-- Save student attendance responses through a narrow SECURITY DEFINER RPC.
-- This avoids broadening table write permissions and validates the caller's membership.
create or replace function public.save_my_attendance_response(
  p_group_id text,
  p_lesson_id text,
  p_lesson_date date,
  p_part_key text,
  p_response text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_record_id text;
  v_data jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_response not in ('will_attend','will_miss') then raise exception 'Invalid attendance response'; end if;
  if not exists (
    select 1 from public.group_members m
    where m.group_id = p_group_id and m.user_id = v_user_id
  ) then raise exception 'You are not a member of this group'; end if;

  v_record_id := p_lesson_id || '_' || v_user_id::text ||
    case when nullif(p_part_key,'') is null then '' else '_' || p_part_key end;
  v_data := jsonb_build_object(
    'lessonId', p_lesson_id,
    'userId', v_user_id::text,
    'lessonDate', p_lesson_date::text,
    'response', p_response,
    'updatedAt', now()
  );
  if nullif(p_part_key,'') is not null then
    v_data := v_data || jsonb_build_object('partKey', p_part_key);
  end if;

  insert into public.group_records(group_id,collection_name,record_id,owner_user_id,data,updated_at)
  values(p_group_id,'attendanceResponses',v_record_id,v_user_id,v_data,now())
  on conflict(group_id,collection_name,record_id)
  do update set owner_user_id=excluded.owner_user_id,data=excluded.data,updated_at=now();
end;
$$;
revoke all on function public.save_my_attendance_response(text,text,date,text,text) from public, anon;
grant execute on function public.save_my_attendance_response(text,text,date,text,text) to authenticated;
