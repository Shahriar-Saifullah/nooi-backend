-- 20261107_round2_pricing_options.sql
-- Round 2 of the client feedback:
--   1. per-metre pricing: a listing can be priced per metre of width, with
--      the widths a shopper may order
--   2. vendor options: fabric / legs / handles / colour code / texture …
--      groups with swatches and extra prices (products.options)
--   3. cart lines and order lines carry the chosen config, so one product can
--      sit in the cart twice (two widths, two fabrics)
--   4. Nooi's kitchen price list (platform_settings.kitchen_prices)
-- Pricing rules: src/services/configure.ts and kitchenPricing.ts.
-- Safe to run more than once.

BEGIN;

-- 1–2. Listings ---------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS price_unit   text NOT NULL DEFAULT 'unit',
  ADD COLUMN IF NOT EXISTS min_width_cm int,
  ADD COLUMN IF NOT EXISTS max_width_cm int,
  -- [{ id, name, kind, choices: [{ id, name, code?, hex?, image?, price_delta }] }]
  ADD COLUMN IF NOT EXISTS options      jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_price_unit_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_price_unit_check
      CHECK (price_unit IN ('unit', 'metre'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_width_range_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_width_range_check
      CHECK (min_width_cm IS NULL OR max_width_cm IS NULL OR min_width_cm <= max_width_cm);
  END IF;
END $$;

-- 3. Cart and order lines -----------------------------------------------------

ALTER TABLE public.cart_items
  ADD COLUMN IF NOT EXISTS config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_key text  NOT NULL DEFAULT '';

-- One line per variant AND config (same sofa, two widths = two lines).
ALTER TABLE public.cart_items DROP CONSTRAINT IF EXISTS cart_items_user_variant_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_user_variant_config_key') THEN
    ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_user_variant_config_key
      UNIQUE (user_id, variant_id, config_key);
  END IF;
END $$;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- "240 cm wide · Fabric: Velvet green" — what the vendor makes
  ADD COLUMN IF NOT EXISTS config_label text;

-- create_order_atomic, now writing each line's config -------------------------
-- Same as 20261013_shipment_tracking.sql apart from the two config columns.

CREATE OR REPLACE FUNCTION create_order_atomic(
  p_user_id UUID,
  p_checkout_attempt_id UUID,
  p_order_number TEXT,
  p_shipping_address JSONB,
  p_items JSONB,              -- Array of {variant_id, product_id, retailer_id, unit_price, quantity, total_price, cart_item_id, config, config_label}
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
      item_status,
      config,
      config_label
    ) VALUES (
      v_order_id,
      (v_item->>'retailer_id')::UUID,
      (v_item->>'product_id')::UUID,
      (v_item->>'variant_id')::UUID,
      (v_item->>'unit_price')::NUMERIC,
      (v_item->>'quantity')::INT,
      (v_item->>'total_price')::NUMERIC,
      'processing',
      COALESCE(v_item->'config', '{}'::jsonb),
      NULLIF(v_item->>'config_label', '')
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

-- 4. Kitchen price list -------------------------------------------------------
-- NULL = the defaults in kitchenPricing.ts.
ALTER TABLE public.platform_settings ADD COLUMN IF NOT EXISTS kitchen_prices jsonb;

COMMIT;
