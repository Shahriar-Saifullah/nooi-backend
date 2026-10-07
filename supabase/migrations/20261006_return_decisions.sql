-- Phase 03 — Return decisions and refunds
-- ============================================================================
-- order_returns records that a customer asked for a refund. It has no record of
-- what anyone decided, who decided it, or whether money actually moved.
--
-- The money part needs more care than the vendor approval did. Approving a
-- vendor twice is a no-op; refunding twice sends real money twice, and Stripe
-- will happily do it. So the status flow has an intermediate state:
--
--   requested → refunding → refunded
--                    ↓
--                 requested   (Stripe failed; released for another attempt)
--
--   requested → declined
--
-- A refund claims the row by moving it to 'refunding' in a conditional UPDATE
-- before calling Stripe. A second admin pressing Refund finds the row no longer
-- 'requested' and is told so. If Stripe then fails, the row goes back to
-- 'requested' rather than being stranded — an admin can retry, and nobody has
-- been refunded twice to achieve it.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Decision fields -----------------------------------------------------------

ALTER TABLE public.order_returns
  ADD COLUMN IF NOT EXISTS decided_by       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note    TEXT,
  ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN public.order_returns.stripe_refund_id IS
  'Set only once Stripe confirms. Its presence is the proof money moved — '
  'status alone is not, because a status can be written without a refund.';

COMMENT ON COLUMN public.order_returns.decision_note IS
  'Why it was declined. The customer sees this, so it has to be written for '
  'them rather than as an internal note.';

-- The valid states, written down. Without this a typo produces a return that
-- no query finds and no screen shows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_returns_status_check') THEN
    ALTER TABLE public.order_returns ADD CONSTRAINT order_returns_status_check
      CHECK (status IN ('requested', 'refunding', 'refunded', 'declined'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_returns_status
  ON public.order_returns (status, created_at);
CREATE INDEX IF NOT EXISTS idx_order_returns_order
  ON public.order_returns (order_id);

-- 2. Claim a return for refunding ----------------------------------------------
-- The guard against paying twice. Moves 'requested' → 'refunding' and reports
-- whether this caller is the one that got it. Only that caller should then talk
-- to Stripe.

CREATE OR REPLACE FUNCTION public.claim_return_for_refund(
  p_return_id UUID,
  p_admin_id  UUID
) RETURNS TABLE (claimed BOOLEAN, current_status TEXT, amount NUMERIC) AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.order_returns
  SET status     = 'refunding',
      decided_by = p_admin_id,
      updated_at = now()
  WHERE id = p_return_id
    AND status = 'requested';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY
  SELECT (v_updated > 0), orr.status::TEXT, orr.refund_amount
  FROM public.order_returns orr
  WHERE orr.id = p_return_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Settle a claimed return ---------------------------------------------------
-- Called after Stripe answers. On success it records the refund id, marks the
-- order item returned and puts the stock back. On failure it returns the row to
-- 'requested' so someone can try again.

CREATE OR REPLACE FUNCTION public.settle_return_refund(
  p_return_id   UUID,
  p_succeeded   BOOLEAN,
  p_refund_id   TEXT DEFAULT NULL,
  p_note        TEXT DEFAULT NULL
) RETURNS TABLE (final_status TEXT) AS $$
DECLARE
  v_return RECORD;
BEGIN
  SELECT * INTO v_return FROM public.order_returns WHERE id = p_return_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND';
  END IF;

  IF NOT p_succeeded THEN
    -- Release rather than strand. Nobody was refunded, so the request is
    -- exactly as valid as it was a moment ago.
    UPDATE public.order_returns
    SET status        = 'requested',
        decided_by    = NULL,
        decision_note = p_note,
        updated_at    = now()
    WHERE id = p_return_id;

    RETURN QUERY SELECT 'requested'::TEXT;
    RETURN;
  END IF;

  UPDATE public.order_returns
  SET status           = 'refunded',
      stripe_refund_id = p_refund_id,
      decided_at       = now(),
      updated_at       = now()
  WHERE id = p_return_id;

  -- The item is no longer the customer's.
  UPDATE public.order_items
  SET item_status = 'returned'
  WHERE id = v_return.order_item_id;

  -- Returned goods go back on the shelf. A refunded item that stays
  -- out of stock is lost revenue nobody notices.
  UPDATE public.product_variants pv
  SET stock_quantity = pv.stock_quantity + oi.quantity
  FROM public.order_items oi
  WHERE oi.id = v_return.order_item_id
    AND pv.id = oi.variant_id;

  RETURN QUERY SELECT 'refunded'::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4. Decline -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.decline_return(
  p_return_id UUID,
  p_admin_id  UUID,
  p_note      TEXT
) RETURNS TABLE (applied BOOLEAN, current_status TEXT) AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.order_returns
  SET status        = 'declined',
      decided_by    = p_admin_id,
      decided_at    = now(),
      decision_note = p_note,
      updated_at    = now()
  WHERE id = p_return_id
    AND status = 'requested';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY
  SELECT (v_updated > 0), orr.status::TEXT
  FROM public.order_returns orr
  WHERE orr.id = p_return_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 5. Lock them down ------------------------------------------------------------
-- These move money and stock. Only the backend may call them.

REVOKE EXECUTE ON FUNCTION public.claim_return_for_refund(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_return_for_refund(UUID, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.settle_return_refund(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_return_refund(UUID, BOOLEAN, TEXT, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION public.decline_return(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.decline_return(UUID, UUID, TEXT) TO service_role;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='order_returns'
--   AND column_name IN ('decided_by','decided_at','decision_note',
--                       'stripe_refund_id','updated_at');
--   expect 5 rows
--
-- SELECT proname, has_function_privilege('authenticated', oid, 'EXECUTE') AS can_call
-- FROM pg_proc WHERE proname IN
--   ('claim_return_for_refund','settle_return_refund','decline_return');
--   expect can_call = false for all three
