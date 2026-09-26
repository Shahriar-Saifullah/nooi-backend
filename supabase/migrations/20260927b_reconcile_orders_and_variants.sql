-- Phase 03 — Reconcile orders + complete skipped sections
-- ============================================================================
-- Run AFTER 20260927_rebuild_products_and_match_columns.sql, and BEFORE
-- 20260920_phase03_payment_and_notification_extensions.sql.
--
-- Background
-- ----------
-- Two legacy tables predated Phase 03 and shadowed it. Because
-- 20260916_phase03_ecommerce_tables.sql uses CREATE TABLE IF NOT EXISTS
-- throughout, both were skipped in silence:
--
--   products  (fixed by the previous script)
--   orders    (id, user_id, items, stripe_payment_id, total, status, ...)
--
-- The legacy orders table stores line items as a blob and names the Stripe
-- reference stripe_payment_id. Phase 03 expects normalised order_items and
-- payment_intent_id, which is why 20260920 failed on "payment_intent_id does
-- not exist".
--
-- This script also completes the two sections the previous run skipped when
-- product_variants did not yet exist: the queryable dimension columns and the
-- product_id foreign keys.
--
-- One deliberate change from the original Phase 03 definition: status defaults
-- to 'pending', not 'paid'. An order row should not claim to be paid before a
-- payment provider has confirmed anything.
--
-- Safe to re-run. Refuses to drop an orders table that holds rows.
-- ============================================================================

BEGIN;

-- 1. Replace the legacy orders table ------------------------------------------

DO $$
DECLARE
  n BIGINT;
  is_legacy BOOLEAN;
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='orders'
      AND column_name='stripe_payment_id'
  ) INTO is_legacy;

  IF NOT is_legacy THEN
    RAISE NOTICE 'orders is already the Phase 03 shape — leaving it alone.';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.orders' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Legacy orders table holds % row(s) — these could be real customer orders. '
      'Stopping. Export them, then re-run.', n;
  END IF;

  EXECUTE 'DROP TABLE public.orders CASCADE';
  RAISE NOTICE 'Dropped empty legacy orders table.';
END $$;

CREATE TABLE IF NOT EXISTS public.orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number         TEXT UNIQUE NOT NULL,
  user_id              UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending',
  subtotal             NUMERIC(10,2) NOT NULL,
  tax_amount           NUMERIC(10,2) DEFAULT 0.00,
  shipping_amount      NUMERIC(10,2) DEFAULT 0.00,
  total_amount         NUMERIC(10,2) NOT NULL,
  currency             TEXT DEFAULT 'USD',
  shipping_address     JSONB NOT NULL,
  payment_intent_id    TEXT,
  invoice_url          TEXT,
  payment_method       TEXT DEFAULT 'stripe',
  payment_status       TEXT DEFAULT 'pending',
  stripe_client_secret TEXT,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- 2. Re-point the order foreign keys ------------------------------------------
-- DROP ... CASCADE above removed these constraints. The referencing tables and
-- their rows are untouched.

DO $$
DECLARE
  t TEXT;
  c TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_items','order_shipments','order_returns']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    c := t || '_order_id_fkey';

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c) THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c);
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (order_id) '
      'REFERENCES public.orders(id) ON DELETE CASCADE', t, c);

    RAISE NOTICE 'Re-pointed %.order_id at orders.', t;
  END LOOP;
END $$;

-- 3. Complete the product foreign keys skipped on the first run ---------------

DO $$
DECLARE
  t TEXT;
  c TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_variants','order_items','product_reviews','affiliate_clicks']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='product_id'
    ) THEN CONTINUE; END IF;

    c := t || '_product_id_fkey';

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c) THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c);
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (product_id) '
      'REFERENCES public.products(id) ON DELETE CASCADE', t, c);

    RAISE NOTICE 'Re-pointed %.product_id at products.', t;
  END LOOP;
END $$;

-- 4. Queryable dimensions, skipped on the first run ---------------------------
-- dimensions_cm is JSONB and cannot be range-queried with an index. The fit
-- check is a range query over every candidate variant.

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS width_cm  NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS depth_cm  NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(7,2);

UPDATE public.product_variants
SET width_cm  = COALESCE(width_cm,  NULLIF(dimensions_cm->>'width','')::NUMERIC),
    depth_cm  = COALESCE(depth_cm,  NULLIF(dimensions_cm->>'depth','')::NUMERIC),
    height_cm = COALESCE(height_cm, NULLIF(dimensions_cm->>'height','')::NUMERIC)
WHERE dimensions_cm IS NOT NULL
  AND (width_cm IS NULL OR depth_cm IS NULL OR height_cm IS NULL);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON public.product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_width      ON public.product_variants(width_cm);

CREATE OR REPLACE FUNCTION public.sync_variant_dimensions()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.dimensions_cm IS NOT NULL THEN
    NEW.width_cm  := COALESCE(NEW.width_cm,  NULLIF(NEW.dimensions_cm->>'width','')::NUMERIC);
    NEW.depth_cm  := COALESCE(NEW.depth_cm,  NULLIF(NEW.dimensions_cm->>'depth','')::NUMERIC);
    NEW.height_cm := COALESCE(NEW.height_cm, NULLIF(NEW.dimensions_cm->>'height','')::NUMERIC);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS tr_sync_variant_dimensions ON public.product_variants;
CREATE TRIGGER tr_sync_variant_dimensions
  BEFORE INSERT OR UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.sync_variant_dimensions();

COMMIT;

-- Next ------------------------------------------------------------------------
-- 1. Run 20260920_phase03_payment_and_notification_extensions.sql — it will now
--    succeed: payment_intent_id exists, so the unique constraint applies, and
--    it goes on to create notifications, the cart RLS policies and
--    reserve_product_stock.
-- 2. Run seed_products_dev.sql.
--
-- Verify:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='orders' ORDER BY ordinal_position;

-- 5. Retailer foreign key on products -----------------------------------------
-- Added after the fact. On the first run of the previous script, `retailers`
-- did not yet exist, so this constraint was skipped. Without it the PostgREST
-- embed in getCanvasProductLink fails with PGRST200 — "Could not find a
-- relationship between 'products' and 'retailers' in the schema cache" — even
-- though plain SQL against both tables works fine.

DO $$
BEGIN
  IF to_regclass('public.retailers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_retailer_id_fkey')
  THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_retailer_id_fkey
      FOREIGN KEY (retailer_id) REFERENCES public.retailers(id) ON DELETE CASCADE;
    RAISE NOTICE 'Added products_retailer_id_fkey.';
  END IF;
END $$;

-- PostgREST caches foreign-key metadata. Without this the embed keeps failing
-- until the cache happens to refresh.
NOTIFY pgrst, 'reload schema';
