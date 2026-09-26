-- Phase 03 — Rebuild products + shop match columns
-- ============================================================================
-- SUPERSEDES the earlier 20260927_shop_match_columns.sql. Run this one instead.
--
-- Background
-- ----------
-- An empty legacy `products` table (id, name, price, model_url, product_url,
-- category, colours, in_stock) predated Phase 03. Because
-- 20260916_phase03_ecommerce_tables.sql used CREATE TABLE IF NOT EXISTS, the
-- real Phase 03 definition silently no-opped and was never applied. Every
-- marketplace query has therefore been failing and falling back to mock data.
--
-- The legacy table holds 0 rows and no code references its columns
-- (model_url, product_url, in_stock, colours appear nowhere in the backend),
-- so it is dropped rather than migrated.
--
-- DROP ... CASCADE here removes the legacy table and any FOREIGN KEY
-- CONSTRAINTS pointing at it. It does NOT drop the referencing tables —
-- product_variants, order_items, product_reviews and affiliate_clicks keep
-- their rows. Their constraints are recreated at the end against the new table.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Type vocabulary ----------------------------------------------------------
-- Mirrors FURNITURE_TYPES in lib/furniture/catalog.ts. This is the shared
-- language between a placed 3D model and a sellable product; without it the
-- only possible match is an exact canvas_model_id hit, which can never surface
-- "similar items from other vendors".

CREATE TABLE IF NOT EXISTS public.furniture_types (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL
);

INSERT INTO public.furniture_types (id, name, category) VALUES
  ('sofa','Sofa','living'), ('armchair','Armchair','living'),
  ('coffee-table','Coffee Table','living'), ('tv-stand','TV Stand','living'),
  ('bookshelf','Bookshelf','living'), ('floor-lamp','Floor Lamp','living'),
  ('rug','Rug','living'), ('bed','Bed','bedroom'),
  ('nightstand','Nightstand','bedroom'), ('wardrobe','Wardrobe','bedroom'),
  ('dresser','Dresser','bedroom'), ('dining-table','Dining Table','dining'),
  ('dining-chair','Dining Chair','dining'), ('sideboard','Sideboard','dining'),
  ('kitchen-island','Kitchen Island','kitchen'), ('bar-stool','Bar Stool','kitchen'),
  ('fridge','Refrigerator','kitchen'), ('bathtub','Bathtub','bath'),
  ('sink','Sink','bath'), ('toilet','Toilet','bath'),
  ('outdoor-chair','Patio Chair','outdoor'), ('outdoor-table','Patio Table','outdoor'),
  ('patio-set','Patio Set','outdoor'), ('plant','Plant','decor'),
  ('side-table','Side Table','decor'), ('vase','Vase','decor'),
  ('book','Book','decor'), ('tray','Tray','decor'),
  ('wall-clock','Wall Clock','decor'), ('picture-frame','Picture Frame','decor'),
  ('staircase','Staircase','structure'), ('chandelier','Chandelier','lighting')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, category = EXCLUDED.category;

ALTER TABLE public.furniture_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read furniture types" ON public.furniture_types;
CREATE POLICY "Anyone can read furniture types"
  ON public.furniture_types FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Service role manages furniture types" ON public.furniture_types;
CREATE POLICY "Service role manages furniture types"
  ON public.furniture_types FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- 2. Guard: refuse to drop a products table that holds data --------------------
-- If someone loaded rows between writing this and running it, stop rather than
-- destroy them.

DO $$
DECLARE
  n BIGINT;
  has_legacy BOOLEAN;
BEGIN
  IF to_regclass('public.products') IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='products' AND column_name='model_url'
  ) INTO has_legacy;

  IF NOT has_legacy THEN
    RETURN;  -- already the Phase 03 shape; nothing to replace
  END IF;

  EXECUTE 'SELECT count(*) FROM public.products' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Legacy products table holds % row(s). Stopping. Back them up and re-run.', n;
  END IF;

  EXECUTE 'DROP TABLE public.products CASCADE';
  RAISE NOTICE 'Dropped empty legacy products table.';
END $$;

-- 3. The real products table --------------------------------------------------

CREATE TABLE IF NOT EXISTS public.products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id     UUID,
  canvas_model_id TEXT NOT NULL,
  type_id         TEXT REFERENCES public.furniture_types(id),
  title           TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,
  tags            TEXT[] DEFAULT '{}',
  base_price      NUMERIC(10,2) NOT NULL,
  affiliate_url   TEXT,
  specs_json      JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- If the table already existed in Phase 03 shape, make sure type_id is there.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS type_id TEXT REFERENCES public.furniture_types(id);

-- retailer_id FK, only if retailers exists.
DO $$
BEGIN
  IF to_regclass('public.retailers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='products_retailer_id_fkey')
  THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_retailer_id_fkey
      FOREIGN KEY (retailer_id) REFERENCES public.retailers(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_canvas_model_id ON public.products(canvas_model_id);
CREATE INDEX IF NOT EXISTS idx_products_type_id         ON public.products(type_id);
CREATE INDEX IF NOT EXISTS idx_products_retailer_id     ON public.products(retailer_id);
CREATE INDEX IF NOT EXISTS idx_products_category        ON public.products(category);

-- Public catalog: everyone reads, only the backend writes.
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read products" ON public.products;
CREATE POLICY "Anyone can read products"
  ON public.products FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Service role manages products" ON public.products;
CREATE POLICY "Service role manages products"
  ON public.products FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- 4. Re-point the dependent foreign keys --------------------------------------
-- The CASCADE above removed these constraints along with the legacy table.
-- Recreate each one, but only where the table actually exists.

DO $$
DECLARE
  t TEXT;
  c TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_variants','order_items','product_reviews','affiliate_clicks']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'Skipping % — table not present.', t;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='product_id'
    ) THEN
      CONTINUE;
    END IF;

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

-- 5. Queryable dimensions on variants -----------------------------------------
-- dimensions_cm is JSONB and cannot be range-queried with an index. The fit
-- check ("18cm wider than the space you designed for") is a range query. The
-- JSONB column stays and is still populated, so nothing reading it breaks.

DO $$
BEGIN
  IF to_regclass('public.product_variants') IS NULL THEN
    RAISE NOTICE 'product_variants missing — skipping dimension columns.';
    RETURN;
  END IF;

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
END $$;

-- Keep the two dimension representations in step, so a vendor form that writes
-- only JSONB still produces rows the matcher can query.
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

DO $$
BEGIN
  IF to_regclass('public.product_variants') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tr_sync_variant_dimensions ON public.product_variants;
    CREATE TRIGGER tr_sync_variant_dimensions
      BEFORE INSERT OR UPDATE ON public.product_variants
      FOR EACH ROW EXECUTE FUNCTION public.sync_variant_dimensions();
  END IF;
END $$;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='products' ORDER BY ordinal_position;
--   expect: id, retailer_id, canvas_model_id, type_id, title, description,
--           category, tags, base_price, affiliate_url, specs_json, created_at
