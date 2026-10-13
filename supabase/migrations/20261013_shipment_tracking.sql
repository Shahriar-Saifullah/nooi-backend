-- Phase 03 — Real shipment tracking
-- ============================================================================
-- Groundwork for carrier tracking (NOOI-61). Three things are wrong today.
--
-- 1. Every shipment is born with a fake tracking number.
--    create_order_atomic wrote carrier_code 'standard' and
--    'TRK-' || random hex at checkout, before anything had shipped. The shopper
--    sees a number no carrier recognises, and a poller cannot tell a shipment
--    awaiting dispatch from one in transit, because both carry a number.
--    Fixed below: both stay NULL until a vendor dispatches.
--
-- 2. Nothing records when a shipment was last checked.
--    The tracking design has a "no update since X" warning, which needs a
--    last-polled timestamp to exist at all.
--
-- 3. There is no state for an exception.
--    The five statuses are all forward progress. A failed delivery attempt, a
--    customs hold or a bad address has nowhere to go — and those are exactly
--    the cases where a shopper needs telling. Kept as a separate field rather
--    than a sixth status, because a shipment in exception is still somewhere in
--    the chain: "held at customs, last seen in transit" is two facts, not one.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Dispatch is what creates a tracking number ------------------------------

ALTER TABLE public.order_shipments ALTER COLUMN carrier_code    DROP NOT NULL;
ALTER TABLE public.order_shipments ALTER COLUMN tracking_number DROP NOT NULL;

COMMENT ON COLUMN public.order_shipments.tracking_number IS
  'NULL until the vendor dispatches. Its presence is what makes a shipment '
  'pollable — never generate a placeholder.';

-- Clear the fabricated ones. Matched on carrier_code = ''standard'', which only
-- the old function wrote; a real carrier is ARAMEX, DHL, SMSA and so on.
UPDATE public.order_shipments
SET tracking_number = NULL,
    carrier_code    = NULL
WHERE carrier_code = 'standard'
  AND tracking_number LIKE 'TRK-%';

-- 2. Carrier tracking fields --------------------------------------------------

ALTER TABLE public.order_shipments
  ADD COLUMN IF NOT EXISTS service_code     TEXT,
  ADD COLUMN IF NOT EXISTS tracking_url     TEXT,
  ADD COLUMN IF NOT EXISTS dispatched_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_polled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS poll_failures    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exception_code   TEXT,
  ADD COLUMN IF NOT EXISTS exception_note   TEXT,
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN public.order_shipments.last_polled_at IS
  'When the carrier was last asked. Without it there is no way to say "no '
  'update in three days", which is the difference between a quiet shipment and '
  'a lost one.';

COMMENT ON COLUMN public.order_shipments.poll_failures IS
  'Consecutive failures. A number that keeps failing is usually wrong rather '
  'than unlucky — back off and surface it rather than polling it forever.';

COMMENT ON COLUMN public.order_shipments.exception_code IS
  'Carrier exception: delivery_attempted, address_issue, customs_hold, damaged, '
  'lost. Separate from shipment_status so a held parcel keeps its last known '
  'position.';

-- 3. The statuses, written down -----------------------------------------------
-- Without this a typo produces a shipment no screen renders and no query finds.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_shipments_status_check') THEN
    ALTER TABLE public.order_shipments ADD CONSTRAINT order_shipments_status_check
      CHECK (shipment_status IN (
        'label_pending', 'label_created', 'in_transit',
        'out_for_delivery', 'delivered', 'cancelled'
      ));
  END IF;
END $do$;

-- 4. What the poller reads ----------------------------------------------------
-- Only shipments with a real tracking number, not yet settled, oldest check
-- first. This index is the whole query plan for the polling job.

CREATE INDEX IF NOT EXISTS idx_shipments_pollable
  ON public.order_shipments (last_polled_at NULLS FIRST)
  WHERE tracking_number IS NOT NULL
    AND shipment_status NOT IN ('delivered', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_shipments_retailer
  ON public.order_shipments (retailer_id, shipment_status);

-- Tracking events arrive repeatedly for the same scan when polling. Without a
-- uniqueness rule the timeline accumulates duplicates every poll.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_events_unique
  ON public.order_tracking_events (shipment_id, status, timestamp);

-- 5. create_order_atomic, without the invented tracking number ----------------

CREATE OR REPLACE FUNCTION create_order_atomic(
  p_user_id UUID,
  p_checkout_attempt_id UUID,
  p_order_number TEXT,
  p_shipping_address JSONB,
  p_items JSONB,              -- Array of {variant_id, product_id, retailer_id, unit_price, quantity, total_price, cart_item_id}
  p_retailer_groups JSONB,    -- Array of {retailer_id, shipping_amount, estimated_delivery}
  p_subtotal NUMERIC,
  p_shipping_total NUMERIC,
  p_tax_total NUMERIC,
  p_grand_total NUMERIC,
  p_currency TEXT,
  p_payment_intent_id TEXT
) RETURNS UUID AS $$
DECLARE
  v_order_id UUID;
  v_item JSONB;
  v_group JSONB;
  v_ok BOOLEAN;
  v_cart_ids UUID[];
BEGIN
  -- Step A: Reserve stock atomically for each variant
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT reserve_product_stock(
      (v_item->>'variant_id')::UUID,
      (v_item->>'quantity')::INT
    ) INTO v_ok;

    IF NOT v_ok THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT:variant=%', (v_item->>'variant_id');
    END IF;
  END LOOP;

  -- Step B: Insert the order (status is 'paid' because webhook confirmed payment)
  INSERT INTO public.orders (
    order_number,
    user_id,
    status,
    payment_method,
    payment_status,
    subtotal,
    tax_amount,
    shipping_amount,
    total_amount,
    currency,
    shipping_address,
    payment_intent_id
  ) VALUES (
    p_order_number,
    p_user_id,
    'paid',
    'stripe',
    'succeeded',
    p_subtotal,
    p_tax_total,
    p_shipping_total,
    p_grand_total,
    p_currency,
    p_shipping_address,
    p_payment_intent_id
  ) RETURNING id INTO v_order_id;

  -- Step C: Insert order items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.order_items (
      order_id,
      retailer_id,
      product_id,
      variant_id,
      unit_price,
      quantity,
      total_price,
      item_status
    ) VALUES (
      v_order_id,
      (v_item->>'retailer_id')::UUID,
      (v_item->>'product_id')::UUID,
      (v_item->>'variant_id')::UUID,
      (v_item->>'unit_price')::NUMERIC,
      (v_item->>'quantity')::INT,
      (v_item->>'total_price')::NUMERIC,
      'processing'
    );
  END LOOP;

  -- Step D: Insert order shipments (one per retailer group)
  FOR v_group IN SELECT * FROM jsonb_array_elements(p_retailer_groups)
  LOOP
    -- carrier_code and tracking_number stay NULL until the vendor dispatches.
    --
    -- This used to write 'standard' and a random 'TRK-xxxxxxxx'. Both looked
    -- real and neither was: the shopper saw a tracking number no carrier had
    -- heard of, and carrier polling would have had no way to tell a shipment
    -- awaiting dispatch from one already moving — every shipment carries a
    -- number, so every shipment looks dispatched.
    INSERT INTO public.order_shipments (
      order_id,
      retailer_id,
      carrier_code,
      tracking_number,
      shipment_status,
      estimated_delivery
    ) VALUES (
      v_order_id,
      (v_group->>'retailer_id')::UUID,
      NULL,
      NULL,
      'label_pending',
      COALESCE((v_group->>'estimated_delivery')::TIMESTAMPTZ, now() + INTERVAL '5 days')
    );
  END LOOP;

  -- Step E: Delete ONLY purchased cart items (not all user cart items)
  SELECT array_agg((v_item->>'cart_item_id')::UUID)
  INTO v_cart_ids
  FROM jsonb_array_elements(p_items)
  WHERE v_item->>'cart_item_id' IS NOT NULL;

  IF v_cart_ids IS NOT NULL AND array_length(v_cart_ids, 1) > 0 THEN
    DELETE FROM public.cart_items
    WHERE id = ANY(v_cart_ids)
      AND user_id = p_user_id;
  END IF;

  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.create_order_atomic(UUID, UUID, TEXT, JSONB, JSONB, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_order_atomic(UUID, UUID, TEXT, JSONB, JSONB, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT) TO service_role;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- No shipment should carry a fabricated number any more:
--   SELECT count(*) FROM order_shipments WHERE tracking_number LIKE 'TRK-%';
--     expect 0
--
-- And the next order should create shipments with none at all:
--   SELECT shipment_status, carrier_code, tracking_number
--   FROM order_shipments
--   WHERE order_id = (SELECT id FROM orders ORDER BY created_at DESC LIMIT 1);
--     expect label_pending, NULL, NULL
