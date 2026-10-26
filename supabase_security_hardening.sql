-- =============================================================================
-- Nasab (نَسَب) — Security hardening
-- Run this AFTER supabase_relational_schema.sql.
--
-- Result:
--   * everyone (anon) can read trees / persons / unions / tree_links
--   * nobody can write directly with the anon key
--   * only a signed-in editor whose app_metadata.role = 'editor' can write
--   * the public viewer is therefore read-only
--   * editor login attempts are rate-limited by the editor-login Edge Function
--
-- Before running:
--   1. Create the shared editor user in Supabase Dashboard → Authentication → Users.
--   2. Replace EDITOR_EMAIL below with that user's email and run the commented
--      UPDATE at the bottom of this file.
--   3. Set the Edge Function secrets and deploy `editor-login` (see
--      SECURITY_HARDENING.md).
-- =============================================================================

-- ── Helper: is the current JWT an editor? ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'editor', false);
$$;

GRANT EXECUTE ON FUNCTION public.is_editor() TO anon, authenticated;

-- ── Remove every existing policy on the data tables ──────────────────────────
-- The old schema shipped `FOR ALL USING (true)` policies, which allowed anyone
-- with the public anon key to insert/update/delete every row.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('trees', 'persons', 'unions', 'tree_links', 'sessions')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

ALTER TABLE public.trees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tree_links ENABLE ROW LEVEL SECURITY;

-- ── Public read access (the archive is intentionally public) ─────────────────
CREATE POLICY "Public read trees" ON public.trees
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read persons" ON public.persons
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read unions" ON public.unions
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Public read tree_links" ON public.tree_links
  FOR SELECT TO anon, authenticated
  USING (true);

-- ── Editor-only writes ───────────────────────────────────────────────────────
CREATE POLICY "Editor insert trees" ON public.trees
  FOR INSERT TO authenticated
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor update trees" ON public.trees
  FOR UPDATE TO authenticated
  USING (public.is_editor())
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor delete trees" ON public.trees
  FOR DELETE TO authenticated
  USING (public.is_editor());

CREATE POLICY "Editor insert persons" ON public.persons
  FOR INSERT TO authenticated
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor update persons" ON public.persons
  FOR UPDATE TO authenticated
  USING (public.is_editor())
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor delete persons" ON public.persons
  FOR DELETE TO authenticated
  USING (public.is_editor());

CREATE POLICY "Editor insert unions" ON public.unions
  FOR INSERT TO authenticated
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor update unions" ON public.unions
  FOR UPDATE TO authenticated
  USING (public.is_editor())
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor delete unions" ON public.unions
  FOR DELETE TO authenticated
  USING (public.is_editor());

CREATE POLICY "Editor insert tree_links" ON public.tree_links
  FOR INSERT TO authenticated
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor update tree_links" ON public.tree_links
  FOR UPDATE TO authenticated
  USING (public.is_editor())
  WITH CHECK (public.is_editor());

CREATE POLICY "Editor delete tree_links" ON public.tree_links
  FOR DELETE TO authenticated
  USING (public.is_editor());

-- ── Legacy `sessions` table, only if it exists ───────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.sessions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY "Public read sessions" ON public.sessions FOR SELECT TO anon, authenticated USING (true)';
    EXECUTE 'CREATE POLICY "Editor insert sessions" ON public.sessions FOR INSERT TO authenticated WITH CHECK (public.is_editor())';
    EXECUTE 'CREATE POLICY "Editor update sessions" ON public.sessions FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor())';
    EXECUTE 'CREATE POLICY "Editor delete sessions" ON public.sessions FOR DELETE TO authenticated USING (public.is_editor())';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.sessions FROM anon';
    EXECUTE 'GRANT SELECT ON public.sessions TO anon, authenticated';
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON public.sessions TO authenticated';
  END IF;
END $$;

-- ── Table privileges (defence in depth; RLS still decides row access) ────────
REVOKE INSERT, UPDATE, DELETE ON public.trees, public.persons, public.unions, public.tree_links FROM anon;
GRANT SELECT ON public.trees, public.persons, public.unions, public.tree_links TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.trees, public.persons, public.unions, public.tree_links TO authenticated;

-- ── Rate limiting for the editor-login Edge Function ─────────────────────────
CREATE TABLE IF NOT EXISTS public.editor_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_editor_login_attempts_ip
  ON public.editor_login_attempts (ip_hash, attempted_at DESC);

ALTER TABLE public.editor_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.editor_login_attempts FROM anon, authenticated;
-- No policies are created: only the service role (used by the Edge Function)
-- can read or write this table.

-- ── Keep the linked_from column in sync for list queries ─────────────────────
-- Some deployments created `trees` before this column was added, and
-- CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
ALTER TABLE public.trees ADD COLUMN IF NOT EXISTS linked_from JSONB;

-- Older rows stored the link only inside state. Backfill it once.
UPDATE public.trees
SET linked_from = state -> 'linkedFrom'
WHERE linked_from IS NULL
  AND state ? 'linkedFrom';

-- ── Mark the shared editor account (run manually, once) ──────────────────────
-- 1. Create the user in Authentication → Users (email + strong password).
-- 2. Replace the email below and run this UPDATE.
-- 3. The user must sign in again for the app_metadata claim to appear in the JWT;
--    editor-login always performs a fresh sign-in, so this is automatic.
--
-- UPDATE auth.users
-- SET raw_app_meta_data =
--       coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"editor"}'::jsonb
-- WHERE email = 'EDITOR_EMAIL';

-- Verify the editor account:
-- SELECT email, raw_app_meta_data
-- FROM auth.users
-- WHERE raw_app_meta_data ->> 'role' = 'editor';
