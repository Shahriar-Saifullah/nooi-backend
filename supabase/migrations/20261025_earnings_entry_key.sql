-- Fix: vendor earnings were never written
-- ============================================================================
-- 20261024 made "one sale row per order item" and "one shipping row per
-- shipment" PARTIAL unique indexes. Supabase's upsert (ON CONFLICT
-- (order_item_id)) cannot target a partial index, so every insert failed with
-- "no unique or exclusion constraint matching the ON CONFLICT specification"
-- and orders got no earnings rows.
--
-- Now: one plain unique column, entry_key ('sale:<item>' / 'shipping:<shipment>'),
-- and the ledger is written by ONE SQL function, record_order_earnings, used
-- by checkout and by the backfill below.

BEGIN;

ALTER TABLE public.vendor_earnings ADD COLUMN IF NOT EXISTS entry_key TEXT;

UPDATE public.vendor_earnings
SET entry_key = CASE kind WHEN 'sale' THEN 'sale:' || order_item_id
                          WHEN 'shipping' THEN 'shipping:' || shipment_id END
WHERE entry_key IS NULL AND kind IN ('sale', 'shipping');

DROP INDEX IF EXISTS public.uq_earnings_sale;
DROP INDEX IF EXISTS public.uq_earnings_shipping;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_earnings_entry_key_key') THEN
    ALTER TABLE public.vendor_earnings ADD CONSTRAINT vendor_earnings_entry_key_key UNIQUE (entry_key);
  END IF;
END $$;

-- What each vendor earns on an order: item price less the storefront's
-- commission (taken now), plus their shipping charge from the checkout
-- snapshot. Idempotent. Returns the number of rows added.
CREATE OR REPLACE FUNCTION public.record_order_earnings(p_order_id UUID)
RETURNS INT AS $$
DECLARE
  v_currency TEXT;
  v_pi       TEXT;
  v_snap     JSONB;
  v_a        INT;
  v_b        INT;
BEGIN
  SELECT COALESCE(currency, 'SAR'), payment_intent_id INTO v_currency, v_pi
  FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  SELECT snapshot_json INTO v_snap FROM public.checkout_attempts
  WHERE payment_intent_id = v_pi ORDER BY created_at DESC LIMIT 1;

  INSERT INTO public.vendor_earnings (
    entry_key, vendor_id, retailer_id, order_id, order_item_id, shipment_id,
    kind, currency, gross_minor, commission_rate, commission_minor, net_minor)
  SELECT 'sale:' || oi.id, r.vendor_id, r.id, oi.order_id, oi.id, sh.id,
         'sale', v_currency, g.gross, COALESCE(r.commission_rate, 0), c.comm, g.gross - c.comm
  FROM public.order_items oi
  JOIN public.retailers r ON r.id = oi.retailer_id
  LEFT JOIN LATERAL (
    SELECT s.id FROM public.order_shipments s
    WHERE s.order_id = oi.order_id AND s.retailer_id = oi.retailer_id LIMIT 1) sh ON TRUE
  CROSS JOIN LATERAL (SELECT round(oi.total_price * 100)::BIGINT AS gross) g
  CROSS JOIN LATERAL (SELECT GREATEST(0, round(g.gross
      * LEAST(GREATEST(COALESCE(r.commission_rate, 0), 0), 100) / 100))::BIGINT AS comm) c
  WHERE oi.order_id = p_order_id AND r.vendor_id IS NOT NULL
  ON CONFLICT (entry_key) DO NOTHING;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  INSERT INTO public.vendor_earnings (
    entry_key, vendor_id, retailer_id, order_id, order_item_id, shipment_id,
    kind, currency, gross_minor, commission_rate, commission_minor, net_minor)
  SELECT 'shipping:' || s.id, r.vendor_id, r.id, s.order_id, NULL, s.id,
         'shipping', v_currency, x.gross, 0, 0, x.gross
  FROM public.order_shipments s
  JOIN public.retailers r ON r.id = s.retailer_id
  CROSS JOIN LATERAL (SELECT round(COALESCE((
      SELECT (grp->'shipping'->>'shipping_amount')::NUMERIC
      FROM jsonb_array_elements(COALESCE(v_snap->'retailers', '[]'::JSONB)) grp
      WHERE grp->>'retailer_id' = s.retailer_id::TEXT LIMIT 1), 0) * 100)::BIGINT AS gross) x
  WHERE s.order_id = p_order_id AND r.vendor_id IS NOT NULL AND x.gross > 0
  ON CONFLICT (entry_key) DO NOTHING;
  GET DIAGNOSTICS v_b = ROW_COUNT;

  RETURN v_a + v_b;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.record_order_earnings(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_order_earnings(UUID) TO service_role;

-- Backfill every live order that is missing its earnings, then release
-- whatever is already approved + delivered.
DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT id FROM public.orders WHERE status NOT IN ('cancelled', 'cancelling') LOOP
    PERFORM public.record_order_earnings(o.id);
  END LOOP;
  PERFORM public.release_vendor_earnings(NULL, 0);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
