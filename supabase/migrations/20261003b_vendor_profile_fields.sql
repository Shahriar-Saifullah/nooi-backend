-- Phase 03 — Vendor profile display fields
-- ============================================================================
-- Two columns the approval screen reads that neither 20260912 nor the review
-- workflow migration added. They originated in db_separation_plan.md, which was
-- shelved — but the admin side needs them regardless of what happens to the
-- rest of that plan.
--
--   fulfillment_type  the "Type" column in the application queue and the
--                     "{{ type }} · {{ city }}" line in the detail header. An
--                     approver treats a factory and a dropshipper differently,
--                     so it belongs on the row, not buried in a description.
--
--   store_name        the customer-facing storefront name. business_name is the
--                     legal entity, and the two differ often enough that
--                     collapsing them loses information at approval time.
--
--   submitted_at      when the vendor sent the application. created_at is when
--                     the row appeared, which is the same thing today but stops
--                     being so the moment an application can be saved as a
--                     draft and submitted later. The queue sorts and ages on
--                     this, so it needs to mean "submitted", not "created".
--
-- Safe to re-run.
-- ============================================================================

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS store_name       TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfillment_type TEXT DEFAULT 'factory'
    CHECK (fulfillment_type IS NULL
           OR fulfillment_type IN ('factory', 'warehouse', 'dropship', 'studio'));

-- Existing rows predate the column; their creation time is the best available
-- answer and is correct for every application submitted so far.
UPDATE public.vendor_profiles
SET submitted_at = created_at
WHERE submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_submitted_at
  ON public.vendor_profiles (submitted_at DESC NULLS LAST);

COMMENT ON COLUMN public.vendor_profiles.store_name IS
  'Customer-facing storefront name. business_name is the legal entity.';

-- PostgREST caches the column list, and the seed failed on exactly that cache
-- rather than on the database. Without this the next run fails identically even
-- though the columns now exist.
NOTIFY pgrst, 'reload schema';