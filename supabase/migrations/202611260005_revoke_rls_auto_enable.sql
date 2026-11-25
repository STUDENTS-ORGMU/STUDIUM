-- Disable the project helper RPC from the public Data API.
-- It is not used by the client or by any RLS policy.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
