-- Phase 03 — Link vendors to retailers
-- ============================================================================
-- `vendor_profiles` is an account that signs in. `retailers` is a source of
-- products. Nothing connects them, so there is no way to ask what a vendor has
-- sold — which blocks the vendor directory's figures, and blocks vendor payouts
-- (NOOI-67) entirely.
--
-- Shape: retailers.vendor_id → vendor_profiles.id, nullable.
--
--   Nullable because not every retailer is a self-service vendor. NOOI-50 is
--   retailer API ingestion — Shopify, WooCommerce, CSV feeds — where Nooi holds
--   a catalogue from a partner who never logs in. All four seeded retailers are
--   that shape. Merging the two tables would mean inventing a login for a
--   partner who does not have one.
--
--   On retailers rather than on vendor_profiles because one business can run
--   several storefronts. The seed already has that case: Atlas Woodworks and
--   Atlas Outlet Jeddah share CR 1010203040. A vendor_profiles.retailer_id
--   could not express it; this direction can.
--
-- The row is created when a vendor is approved. That is the moment that already
-- means something — a pending vendor needs no storefront, and approving them is
-- precisely the act of granting one.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. The link ------------------------------------------------------------------

ALTER TABLE public.retailers
  ADD COLUMN IF NOT EXISTS vendor_id UUID
    REFERENCES public.vendor_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.retailers.vendor_id IS
  'The vendor account that owns this storefront. NULL for ingested partner '
  'catalogues, which have no login. One vendor may own several retailers.';

CREATE INDEX IF NOT EXISTS idx_retailers_vendor_id
  ON public.retailers (vendor_id) WHERE vendor_id IS NOT NULL;

-- ON DELETE SET NULL, not CASCADE: deleting a vendor account must never delete
-- the storefront, because order_items reference the retailer. Losing it would
-- orphan the order history of every customer who bought from them.

-- 2. Create the storefront on approval -----------------------------------------
-- decide_vendor_application already runs as one transaction. Extending it keeps
-- "approved" and "has a storefront" from ever disagreeing — a vendor approved
-- without a retailer row can list nothing, and would be found by a confused
-- support email rather than by the system.

CREATE OR REPLACE FUNCTION public.decide_vendor_application(
  p_vendor_id        UUID,
  p_admin_id         UUID,
  p_status           TEXT,
  p_rejection_reason TEXT DEFAULT NULL
) RETURNS TABLE (applied BOOLEAN, final_status TEXT, decided_by UUID, decided_at TIMESTAMPTZ) AS $$
DECLARE
  v_updated INT;
  v_vendor  RECORD;
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

  -- On approval, give them a storefront if they have none. Guarded by
  -- v_updated so a repeated call cannot create a second one, and by the NOT
  -- EXISTS so a vendor who already has a retailer keeps it.
  IF v_updated > 0 AND p_status = 'approved' THEN
    SELECT business_name, store_name, city, country
      INTO v_vendor
    FROM public.vendor_profiles
    WHERE id = p_vendor_id;

    IF NOT EXISTS (SELECT 1 FROM public.retailers WHERE vendor_id = p_vendor_id) THEN
      INSERT INTO public.retailers (name, vendor_id, city, country, api_adapter_type, commission_rate)
      VALUES (
        COALESCE(NULLIF(v_vendor.store_name, ''), v_vendor.business_name),
        p_vendor_id,
        v_vendor.city,
        v_vendor.country,
        -- Self-service: they add products through the vendor portal rather than
        -- through an ingestion feed.
        'self_serve',
        -- A placeholder until commission is negotiated. Deliberately not zero,
        -- which would read as "agreed, free" rather than "not set yet".
        10.00
      );
    END IF;
  END IF;

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

-- 3. Backfill ------------------------------------------------------------------
-- The one already-approved seed vendor. Deliberately not matched by name across
-- the board: name matching between two tables that were never linked produces
-- confident wrong answers, and a mis-linked retailer would attribute one
-- vendor's sales to another.

INSERT INTO public.retailers (name, vendor_id, city, country, api_adapter_type, commission_rate)
SELECT
  COALESCE(NULLIF(vp.store_name, ''), vp.business_name),
  vp.id,
  vp.city,
  vp.country,
  'self_serve',
  10.00
FROM public.vendor_profiles vp
WHERE vp.status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM public.retailers r WHERE r.vendor_id = vp.id);

COMMIT;

-- Verify ----------------------------------------------------------------------
-- Approved vendors should each have exactly one storefront; the four seeded
-- partner catalogues should still have none.
--
-- SELECT vp.business_name, vp.status, r.name AS storefront, r.commission_rate
-- FROM public.vendor_profiles vp
-- LEFT JOIN public.retailers r ON r.vendor_id = vp.id
-- ORDER BY vp.status, vp.business_name;
--
-- SELECT name, vendor_id IS NULL AS ingested FROM public.retailers ORDER BY name;
--   expect the four seeded retailers with ingested = true
