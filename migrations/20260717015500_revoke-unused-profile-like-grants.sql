-- Profile likes are only accessed through the edge function after it resolves
-- authenticated or anonymous identities. RLS currently denies direct access,
-- but retaining table grants is unnecessary privilege and makes a future RLS
-- policy mistake immediately exploitable.
REVOKE ALL ON public.tokentracker_profile_likes FROM anon, authenticated;
