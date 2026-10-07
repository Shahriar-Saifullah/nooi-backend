-- Phase 03 — Order intervention
-- ============================================================================
-- Cancelling an order refunds money, restores stock and stops shipments. Like a
-- refund, it needs an intermediate state so two admins cannot both start one:
--
--   paid → cancelling → cancelled
--             ↓
--           paid        (Stripe failed; released for another attempt)
--
-- Overriding a status does not move money, so it is a plain conditional update.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Record the override reason -------------------------------------------------
-- An override without a reason is indistinguishable from a mistake six weeks
-- later. The audit log carries the full note; this keeps the latest one on the
-- order itself so it is visible without a second query.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS intervention_note TEXT,
  ADD COLUMN IF NOT EXISTS intervened_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS intervened_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_refund_id  TEXT;

COMMENT ON COLUMN public.orders.cancel_refund_id IS
  'Stripe refund issued when the order was cancelled. Its presence is the '
  'proof money moved — status alone is not.';

-- 2. Claim an order for cancellation --------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_order_cancellation(
  p_order_id UUID,
  p_admin_id UUID
) RETURNS TABLE (claimed BOOLEAN, current_status TEXT, refundable NUMERIC) AS $$
DECLARE
  v_updated INT;
  v_already NUMERIC;
BEGIN
  UPDATE public.orders
  SET status        = 'cancelling',
      intervened_by = p_admin_id,
      intervened_at = now()
  WHERE id = p_order_id
    AND status IN ('paid', 'fulfilled');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- What has already gone back, so a cancellation after a partial return does
  -- not refund the same money twice.
  SELECT COALESCE(SUM(oi.total_price), 0) INTO v_already
  FROM public.order_returns orr
  JOIN public.order_items oi ON oi.id = orr.order_item_id
  WHERE orr.order_id = p_order_id
    AND orr.status = 'refunded';

  RETURN QUERY
  SELECT
    (v_updated > 0),
    o.status::TEXT,
    GREATEST(o.total_amount - v_already, 0)
  FROM public.orders o
  WHERE o.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Settle a cancellation -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_order_cancellation(
  p_order_id  UUID,
  p_succeeded BOOLEAN,
  p_refund_id TEXT DEFAULT NULL,
  p_note      TEXT DEFAULT NULL
) RETURNS TABLE (final_status TEXT) AS $$
BEGIN
  IF NOT p_succeeded THEN
    -- Nobody was refunded, so the order is exactly as it was.
    UPDATE public.orders
    SET status            = 'paid',
        intervention_note = p_note,
        intervened_by     = NULL,
        intervened_at     = NULL
    WHERE id = p_order_id;

    RETURN QUERY SELECT 'paid'::TEXT;
    RETURN;
  END IF;

  UPDATE public.orders
  SET status            = 'cancelled',
      cancel_refund_id  = p_refund_id,
      intervention_note = p_note,
      intervened_at     = now()
  WHERE id = p_order_id;

  -- Stock goes back for anything not already returned. An item already
  -- refunded through a return has had its stock restored once; doing it again
  -- would invent inventory that does not exist.
  UPDATE public.product_variants pv
  SET stock_quantity = pv.stock_quantity + oi.quantity
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND pv.id = oi.variant_id
    AND oi.item_status NOT IN ('returned', 'cancelled');

  UPDATE public.order_items
  SET item_status = 'cancelled'
  WHERE order_id = p_order_id
    AND item_status NOT IN ('returned', 'cancelled');

  -- Nothing should be dispatched for a cancelled order. Delivered shipments
  -- stay delivered — that already happened and rewriting it would be a lie.
  UPDATE public.order_shipments
  SET shipment_status = 'cancelled'
  WHERE order_id = p_order_id
    AND shipment_status <> 'delivered';

  RETURN QUERY SELECT 'cancelled'::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4. Override a status ------------------------------------------------------------
-- No money moves, so no two-phase dance — but still conditional, so an override
-- cannot quietly undo a cancellation someone else just made.

CREATE OR REPLACE FUNCTION public.override_order_status(
  p_order_id   UUID,
  p_admin_id   UUID,
  p_new_status TEXT,
  p_note       TEXT
) RETURNS TABLE (applied BOOLEAN, final_status TEXT) AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_new_status NOT IN ('paid', 'fulfilled', 'processing') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_new_status;
  END IF;

  UPDATE public.orders
  SET status            = p_new_status,
      intervention_note = p_note,
      intervened_by     = p_admin_id,
      intervened_at     = now()
  WHERE id = p_order_id
    -- A cancelled order is not reopened by an override. Refunded money does
    -- not come back because someone changed a dropdown.
    AND status NOT IN ('cancelled', 'cancelling');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY
  SELECT (v_updated > 0), o.status::TEXT
  FROM public.orders o WHERE o.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 5. Lock down -------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.claim_order_cancellation(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_order_cancellation(UUID, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.settle_order_cancellation(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_order_cancellation(UUID, BOOLEAN, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.override_order_status(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.override_order_status(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- SELECT proname, has_function_privilege('authenticated', oid, 'EXECUTE') AS can_call
-- FROM pg_proc WHERE proname IN
--   ('claim_order_cancellation','settle_order_cancellation','override_order_status');
--   expect can_call = false for all three
