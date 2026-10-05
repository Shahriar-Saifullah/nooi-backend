-- Phase 03 — Fix decide_vendor_application return type
-- ============================================================================
-- Approving an application failed with:
--   "structure of query does not match function result type"
--
-- RETURNS TABLE declares final_status as TEXT, but vendor_profiles.status is
-- VARCHAR(20). Postgres does not coerce between them in a RETURN QUERY — the
-- column types have to match the declared output types exactly.
--
-- The bug has been present since the function was written. It only surfaced
-- now because this is the first decision made through the screen: the seed
-- wrote statuses directly, and the earlier smoke test exercised
-- claim_vendor_review, whose columns happen to line up.
--
-- Everything else is unchanged, including the storefront creation added in
-- 20261005.
--
-- Safe to re-run.
-- ============================================================================

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
  -- v_updated so a repeated call cannot create a second one.
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
        'self_serve',
        10.00
      );
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    (v_updated > 0),
    -- The fix: VARCHAR(20) does not satisfy a declared TEXT output.
    vp.status::TEXT,
    vp.decided_by,
    vp.decided_at
  FROM public.vendor_profiles vp
  WHERE vp.id = p_vendor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) TO service_role;

-- Verify: approve a pending application from the console, then
--
-- SELECT vp.business_name, vp.status, vp.decided_at, p.full_name AS decided_by,
--        r.name AS storefront
-- FROM public.vendor_profiles vp
-- LEFT JOIN public.profiles p  ON p.id = vp.decided_by
-- LEFT JOIN public.retailers r ON r.vendor_id = vp.id
-- WHERE vp.id = '<the id from the URL>';
