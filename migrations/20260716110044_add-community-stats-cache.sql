-- Server-maintained singleton snapshot for public community aggregates.
-- The leaderboard refresh edge function already pays for the all-time grouped
-- scan, so it writes the model totals here and the public read path stays O(1).

CREATE TABLE IF NOT EXISTS public.tokentracker_community_stats (
  id text PRIMARY KEY CHECK (id = 'total'),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  top_models jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(top_models) = 'array'),
  from_day date NOT NULL,
  to_day date NOT NULL,
  generated_at timestamptz NOT NULL
);

ALTER TABLE public.tokentracker_community_stats ENABLE ROW LEVEL SECURITY;

-- This table is never read directly by browser roles. Public access goes
-- through tokentracker-community-models, while writes use the service role.
REVOKE ALL ON TABLE public.tokentracker_community_stats FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tokentracker_community_stats TO project_admin;
