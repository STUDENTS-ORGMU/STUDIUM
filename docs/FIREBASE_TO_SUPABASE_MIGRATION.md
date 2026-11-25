# Firebase → Supabase migration

## Current safety status
Supabase SDK and a first-pass schema are staged. **The live app still uses Firebase Auth and Firestore.** Do not remove Firebase settings or delete Firebase data before a verified import and a separate cutover release.

## Configure the project
Copy the Project URL and publishable key from Supabase Dashboard → Project Settings → API (or Connect) into local `.env`:
```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```
The publishable key is suitable for browser code only with correct RLS. Never expose a Supabase secret/service_role key in Vite, GitHub Pages variables, or source control.

## Apply SQL
Run `supabase/migrations/202611260001_initial_schema.sql` in Supabase SQL Editor. It creates profiles, groups, memberships, invite codes, a JSONB compatibility table, RLS and a private Storage bucket.

## Data and accounts
1. Export Firestore with Firebase Admin SDK in a trusted local environment. Never commit exports; they contain personal data.
2. Build a manifest with full document path, document ID, collection, parent group ID, raw fields and timestamps.
3. Create/import Supabase Auth accounts through a trusted server-side Admin API process. Firebase passwords are not directly migratable through the normal client SDK; plan password reset/re-enrolment. Never copy plaintext passwords.
4. Create a Firebase UID → Supabase Auth UUID mapping. Preserve old IDs in `legacy_firebase_uid` and references in JSONB until reconciled.
5. Import profiles, groups, memberships, invite codes and all group subcollections, preserving Firestore document IDs.
6. Move file bytes from Firestore chunk documents into private Storage paths `<group-id>/<material-id>/<filename>`; verify sizes and hashes.
7. Compare counts per collection and sample profiles, memberships, schedule, tasks, task progress, attendance, links and file downloads.

No production importer or automatic backend switch is enabled yet: the actual export format and UID mapping must be validated before a repeatable importer is safe.

## Cutover blockers / acceptance tests
- Implement a server-side invite-code join RPC; the initial exact-code lookup policy is permissive for authenticated SELECT and must be tightened before launch.
- Replace generic leader-only writes on `group_records` with per-collection policies. Students need narrowly scoped writes for task suggestions, progress and attendance responses.
- Test leader/student accounts and prove cross-group reads and unauthorized writes fail.
- Verify every source/destination count and file hash.
- Keep Firebase as rollback until the new release passes real-user testing.

The initial JSONB compatibility table intentionally avoids losing undocumented Firestore fields. Normalize it only after a complete data inventory.
