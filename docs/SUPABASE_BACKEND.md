# Supabase backend

STUDIUM uses Supabase as its only backend. No legacy data import is required.

## One-time project setup

1. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in local `.env` and GitHub Actions Variables.
2. Disable email confirmation in Supabase Auth because users register and sign in with a generated `<username>@studium.invalid` alias.
3. Apply the SQL migrations in `supabase/migrations` in numerical order.
4. Confirm the private `group-materials` bucket exists and its RLS policies are installed.

## Database layout

- `profiles`: account profile and unique username.
- `study_groups`: group metadata.
- `group_members`: group membership and roles.
- `study_groups.name`: globally unique group name (case-insensitive; surrounding spaces are ignored).
- `invite_codes`: retained for compatibility with existing data; new groups no longer create or use invitation codes.
- `group_records`: JSONB records for tasks, schedule, progress, attendance and materials.
- Storage bucket `group-materials`: private group files, addressed by `<group-id>/<material-id>/<filename>`.

## Security

All tables use Row Level Security. Members can read records for their groups. Leaders manage shared records. Students can create and update only their own task suggestions, task progress and attendance responses. Group joins are performed by the `join_group_by_name` RPC, which resolves an exact group-name match without exposing a public group directory. The database enforces name uniqueness. Never expose the Supabase service-role key in client code.
