-- Phase 03 — Vendor review workflow
-- ============================================================================
-- What the admin vendor-approval screen needs and vendor_profiles doesn't have.
--
-- Scope note: cr_number and vat_number also appeared in db_separation_plan.md,
-- which was shelved. They belong here regardless — the admin approval screen is
-- what READS them, and a legal panel with nowhere to read from is a screen that
-- always says "Not provided". The vendor signup form populating them is a
-- separate job on the vendor side; until it does, these stay null and the
-- screen degrades to "Not provided", which the design already handles.
--
-- Run AFTER 20260912_roles_and_vendor_tables.sql, which creates vendor_profiles
-- and adds profiles.role. Section 0 corrects three flaws in that migration.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 0. Corrections to 20260912_roles_and_vendor_tables.sql ----------------------
-- That migration had never actually been applied, so these are fixes made
-- before the problems existed rather than after — much the better order.
--
--   a) Its vendor UPDATE policy has USING but no WITH CHECK. Postgres then
--      reuses the USING expression for the new row, and that expression is
--      only `auth.uid() = id` — which a vendor editing their own row always
--      satisfies, including a row where they have just set status='approved'.
--      The entire admin approval flow bypassed with one PATCH against
--      PostgREST, using the anon key that ships in the frontend bundle.
--
--   b) Its "Approved vendors are viewable" SELECT policy has no TO clause, so
--      it applies to PUBLIC — which includes anon. Every approved vendor's
--      tax_id, phone, business_email and address readable by anyone.
--
--   c) role and status are bare VARCHAR(20) with the valid values only in a
--      comment. 'vender' or 'Admin' inserts happily and then matches no guard
--      anywhere, producing an account with silently no permissions.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('user', 'vendor', 'admin', 'super_admin'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_profiles_status_check') THEN
    ALTER TABLE public.vendor_profiles ADD CONSTRAINT vendor_profiles_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));
  END IF;
END $$;

-- (a) A vendor may edit their own details, never their own approval state.
-- Column-level REVOKE composes with RLS rather than fighting it.
REVOKE UPDATE (status, verified_at, rejection_reason)
  ON public.vendor_profiles FROM authenticated, anon;

-- (b) Signed-in users only, and never the anon key.
DROP POLICY IF EXISTS "Approved vendors are viewable" ON public.vendor_profiles;
CREATE POLICY "Approved vendors are viewable"
  ON public.vendor_profiles FOR SELECT
  TO authenticated
  USING (status = 'approved');

-- RLS filters rows, not columns. These are business identifiers and contact
-- details that a browsing customer has no reason to hold.
REVOKE SELECT (tax_id, business_email, phone, address)
  ON public.vendor_profiles FROM anon;

-- 1. Legal identifiers --------------------------------------------------------
-- Commercial registration and VAT. Gulf vendors are registered entities and an
-- approver needs to see both to make a decision.

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS cr_number  TEXT,
  ADD COLUMN IF NOT EXISTS vat_number TEXT;

-- Duplicate detection reads this on every application open, so index it.
-- NOT unique: a legitimate second outlet can share a CR, which is exactly why
-- the screen warns rather than blocks.
CREATE INDEX IF NOT EXISTS idx_vendor_profiles_cr_number
  ON public.vendor_profiles (cr_number) WHERE cr_number IS NOT NULL;

-- A tax authority identifier. Never leaves the backend.
REVOKE SELECT (cr_number, vat_number) ON public.vendor_profiles FROM anon;

-- 2. Legal documents ----------------------------------------------------------
-- Array of { kind, label, path, uploaded_at }. `path` is a Supabase Storage key
-- in a PRIVATE bucket, never a public URL — these are trade licences and bank
-- letters. The admin screen resolves them to short-lived signed URLs at view
-- time, so a leaked response body is worthless an hour later.

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS legal_documents JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.vendor_profiles.legal_documents IS
  'Storage keys in a private bucket, not URLs. Resolve to signed URLs on demand.';

-- 3. Decision audit -----------------------------------------------------------
-- "Approved by Maha K. at 13:20." Without this, a disputed approval has no
-- answer to "who did this and when" — which is the first question asked when a
-- vendor turns out to be fraudulent.

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_decided_at
  ON public.vendor_profiles (decided_at DESC) WHERE decided_at IS NOT NULL;

-- 4. Advisory review lock -----------------------------------------------------
-- Two admins opening the same application is normal in a shared queue. This
-- shows the second one that someone is already looking, so they don't waste
-- twenty minutes on a decision that's already been made.
--
-- Advisory on purpose: a hard lock strands an application when someone closes
-- their laptop. Claims go stale after ten minutes and anyone can take over.
-- Correctness comes from the decision being atomic (see claim_vendor_review
-- and the conditional update in the decide endpoint), not from the lock.

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS reviewing_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewing_at TIMESTAMPTZ;

-- 5. Claim a review -----------------------------------------------------------
-- Returns the admin who now holds the claim. Conditional UPDATE so two
-- simultaneous opens can't both believe they hold it.

CREATE OR REPLACE FUNCTION public.claim_vendor_review(
  p_vendor_id UUID,
  p_admin_id  UUID,
  p_takeover  BOOLEAN DEFAULT false
) RETURNS TABLE (holder UUID, claimed_at TIMESTAMPTZ, was_claimed BOOLEAN) AS $$
DECLARE
  v_stale_before TIMESTAMPTZ := now() - INTERVAL '10 minutes';
  v_updated INT;
BEGIN
  UPDATE public.vendor_profiles
  SET reviewing_by = p_admin_id,
      reviewing_at = now()
  WHERE id = p_vendor_id
    AND status = 'pending'
    AND (
      p_takeover
      OR reviewing_by IS NULL
      OR reviewing_by = p_admin_id
      OR reviewing_at < v_stale_before
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY
  SELECT vp.reviewing_by, vp.reviewing_at, (v_updated > 0)
  FROM public.vendor_profiles vp
  WHERE vp.id = p_vendor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_vendor_review(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_vendor_review(UUID, UUID, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_vendor_review(UUID, UUID, BOOLEAN) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_vendor_review(UUID, UUID, BOOLEAN) TO service_role;

-- 6. Decide, atomically -------------------------------------------------------
-- "The first decision submitted wins." That has to be enforced here, not in the
-- UI: the status change only applies if the application is still pending, so a
-- second admin pressing Approve a moment later changes nothing and is told why.

CREATE OR REPLACE FUNCTION public.decide_vendor_application(
  p_vendor_id        UUID,
  p_admin_id         UUID,
  p_status           TEXT,
  p_rejection_reason TEXT DEFAULT NULL
) RETURNS TABLE (applied BOOLEAN, final_status TEXT, decided_by UUID, decided_at TIMESTAMPTZ) AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_status NOT IN ('approved', 'rejected', 'suspended') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status;
  END IF;

  UPDATE public.vendor_profiles
  SET status           = p_status,
      decided_by       = p_admin_id,
      decided_at       = now(),
      verified_at      = CASE WHEN p_status = 'approved' THEN now() ELSE verified_at END,
      rejection_reason = CASE WHEN p_status = 'rejected' THEN p_rejection_reason ELSE NULL END,
      reviewing_by     = NULL,
      reviewing_at     = NULL,
      updated_at       = now()
  WHERE id = p_vendor_id
    AND status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY
  SELECT (v_updated > 0), vp.status, vp.decided_by, vp.decided_at
  FROM public.vendor_profiles vp
  WHERE vp.id = p_vendor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) TO service_role;

-- 7. Admin audit log ----------------------------------------------------------
-- Screen A12. Every consequential admin action lands here: approvals,
-- rejections, refunds, role changes, order interventions. Append-only — an
-- audit log an admin can edit is not an audit log.

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  summary     TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity     ON public.admin_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor      ON public.admin_audit_log (actor_id);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Service role only. Admins read it through the backend, which decides what
-- they may see; nobody writes it from a browser.
DROP POLICY IF EXISTS "Service role manages audit log" ON public.admin_audit_log;
CREATE POLICY "Service role manages audit log"
  ON public.admin_audit_log FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

COMMIT;

-- Verify ----------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='vendor_profiles'
--   AND column_name IN ('cr_number','vat_number','legal_documents',
--                       'decided_by','decided_at','reviewing_by','reviewing_at')
-- ORDER BY column_name;
--   expect 7 rows
--
-- SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS anon
-- FROM pg_proc WHERE proname IN ('claim_vendor_review','decide_vendor_application');
--   expect anon = false for both