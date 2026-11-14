-- 20261113_favourites.sql
-- Favourites: library pieces (catalogue ids, e.g. "sofa-3seat") and
-- marketplace products (product ids), per user.
-- Safe to run more than once.

BEGIN;

CREATE TABLE IF NOT EXISTS public.favourites (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('library', 'product')),
  ref        text NOT NULL CHECK (length(ref) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_favourites_user ON public.favourites (user_id, created_at DESC);

ALTER TABLE public.favourites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS favourites_own ON public.favourites;
CREATE POLICY favourites_own ON public.favourites
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

COMMIT;
