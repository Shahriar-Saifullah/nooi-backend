-- Phase 03 — Allow cancelling a processing order
-- ============================================================================
-- claim_order_cancellation accepted only 'paid' and 'fulfilled'. But
-- override_order_status can set 'processing', so an order could be moved into a
-- state from which it could never be cancelled — and the endpoint then reported
-- "already_handled", which is not what happened and sends an admin looking for
-- a colleague who did nothing.
--
-- An order being prepared is exactly the kind you most want to cancel: the
-- goods have not shipped and nobody has to send anything back.
--
-- Safe to re-run.
-- ============================================================================

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
    -- Every live state. Only 'cancelled', 'cancelling' and 'refunded' are
    -- excluded: those are already settled, and a second cancellation would
    -- either do nothing or refund twice.
    AND status IN ('paid', 'processing', 'fulfilled');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

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

REVOKE EXECUTE ON FUNCTION public.claim_order_cancellation(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_order_cancellation(UUID, UUID) TO service_role;
