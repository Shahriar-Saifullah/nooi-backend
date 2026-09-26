-- Phase 03 Migration: Atomic Order Creation, Checkout Snapshots, and Webhook Idempotency

-- 1. Checkout Attempts Table
CREATE TABLE IF NOT EXISTS public.checkout_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cart_snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  payment_intent_id TEXT UNIQUE,
  snapshot_json JSONB NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  grand_total_cents BIGINT NOT NULL,
  shipping_address JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_checkout_attempts_user_status ON public.checkout_attempts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_checkout_attempts_pi ON public.checkout_attempts(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_checkout_attempts_cart_hash ON public.checkout_attempts(cart_snapshot_hash, user_id);

-- Partial unique index for active attempts per user and cart hash
CREATE UNIQUE INDEX IF NOT EXISTS checkout_attempts_user_active_hash_idx 
  ON public.checkout_attempts(user_id, cart_snapshot_hash) 
  WHERE status = 'active';

ALTER TABLE public.checkout_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own checkout attempts" ON public.checkout_attempts;
CREATE POLICY "Users can view own checkout attempts"
  ON public.checkout_attempts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on checkout_attempts" ON public.checkout_attempts;
CREATE POLICY "Service role full access on checkout_attempts"
  ON public.checkout_attempts FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- 2. Webhook Events Table (Retryable Idempotency Log)
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing', -- 'processing' | 'completed' | 'failed'
  result TEXT,
  error_message TEXT,
  attempts INT DEFAULT 1,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_stripe_id ON public.webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON public.webhook_events(status);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on webhook_events" ON public.webhook_events;
CREATE POLICY "Service role full access on webhook_events"
  ON public.webhook_events FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- 3. Restore Stock Helper Function
CREATE OR REPLACE FUNCTION restore_product_stock(
  p_variant_id UUID,
  p_quantity INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.product_variants
  SET stock_quantity = stock_quantity + p_quantity
  WHERE id = p_variant_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Atomic Order Creation Function
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
      'standard',
      'TRK-' || upper(substring(gen_random_uuid()::TEXT, 1, 8)),
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
