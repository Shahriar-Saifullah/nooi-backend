-- Phase 03 — Shop taxonomy and lead time
-- ============================================================================
-- Adds what the marketplace design needs and the schema doesn't have.
--
-- 1. Shop groups
--    The design's category chips are Seating / Tables / Storage / Lighting /
--    Beds — grouped by what a thing IS. products.category holds living /
--    bedroom / dining / kitchen / bath — grouped by which ROOM it goes in.
--    Both are useful and they're different axes, so neither replaces the other.
--
--    The group is derived from furniture_types rather than stored on products,
--    so a vendor sets type_id (which they must anyway, for the canvas bridge)
--    and the grouping follows. One less field to get wrong on a listing form,
--    and regrouping later is an UPDATE here rather than a backfill across
--    every product.
--
--    Column is `shop_group`, not `group` — the latter is reserved in SQL and
--    would need quoting at every call site.
--
-- 2. Lead time
--    Cards show "21 days" on every product. Resolution order at query time:
--      products.lead_time_days
--        → retailers.shipping_policy_json->>'lead_time_days'
--          → 14 (global default)
--    Nullable so vendors aren't forced to fill it before they know it.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Shop groups on furniture_types -------------------------------------------

ALTER TABLE public.furniture_types
  ADD COLUMN IF NOT EXISTS shop_group TEXT,
  ADD COLUMN IF NOT EXISTS group_sort INT DEFAULT 99;

UPDATE public.furniture_types SET shop_group = v.grp, group_sort = v.srt
FROM (VALUES
  ('sofa',          'Seating',       1),
  ('armchair',      'Seating',       1),
  ('dining-chair',  'Seating',       1),
  ('bar-stool',     'Seating',       1),

  ('coffee-table',  'Tables',        2),
  ('dining-table',  'Tables',        2),
  ('side-table',    'Tables',        2),
  ('kitchen-island','Tables',        2),

  ('bookshelf',     'Storage',       3),
  ('tv-stand',      'Storage',       3),
  ('wardrobe',      'Storage',       3),
  ('dresser',       'Storage',       3),
  ('nightstand',    'Storage',       3),
  ('sideboard',     'Storage',       3),

  ('bed',           'Beds',          4),

  ('floor-lamp',    'Lighting',      5),
  ('chandelier',    'Lighting',      5),

  ('rug',           'Decor',         6),
  ('plant',         'Decor',         6),
  ('vase',          'Decor',         6),
  ('book',          'Decor',         6),
  ('tray',          'Decor',         6),
  ('wall-clock',    'Decor',         6),
  ('picture-frame', 'Decor',         6),

  ('outdoor-chair', 'Outdoor',       7),
  ('outdoor-table', 'Outdoor',       7),
  ('patio-set',     'Outdoor',       7),

  ('bathtub',       'Bath',          8),
  ('sink',          'Bath',          8),
  ('toilet',        'Bath',          8),

  ('fridge',        'Kitchen',       9),

  ('staircase',     'Architectural', 10)
) AS v(id, grp, srt)
WHERE furniture_types.id = v.id;

-- Anything added later without a mapping still shows up rather than vanishing
-- from the grid.
UPDATE public.furniture_types
SET shop_group = 'Other', group_sort = 98
WHERE shop_group IS NULL;

ALTER TABLE public.furniture_types
  ALTER COLUMN shop_group SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_furniture_types_shop_group
  ON public.furniture_types(shop_group);

-- 2. Lead time ----------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS lead_time_days INT
  CHECK (lead_time_days IS NULL OR (lead_time_days >= 0 AND lead_time_days <= 365));

COMMENT ON COLUMN public.products.lead_time_days IS
  'Days from order to delivery. NULL falls back to the retailer''s '
  'shipping_policy_json->>''lead_time_days'', then to 14.';

-- Give the seeded products a spread so the UI has something to sort and filter
-- on. Only touches rows that are still NULL, so real vendor data is never
-- overwritten.
UPDATE public.products p
SET lead_time_days = CASE ft.shop_group
  WHEN 'Seating'  THEN 21
  WHEN 'Beds'     THEN 18
  WHEN 'Tables'   THEN 28
  WHEN 'Storage'  THEN 30
  WHEN 'Lighting' THEN 5
  WHEN 'Decor'    THEN 7
  ELSE 14
END
FROM public.furniture_types ft
WHERE ft.id = p.type_id AND p.lead_time_days IS NULL;

-- 3. Convenience view for the grid --------------------------------------------
-- Resolves the lead-time fallback chain and the group in one place, so the
-- controller doesn't reimplement it and the two can't drift apart.

CREATE OR REPLACE VIEW public.products_shop AS
SELECT
  p.*,
  ft.shop_group,
  ft.group_sort,
  ft.name AS type_name,
  COALESCE(
    p.lead_time_days,
    NULLIF(r.shipping_policy_json->>'lead_time_days', '')::INT,
    14
  ) AS effective_lead_time_days
FROM public.products p
LEFT JOIN public.furniture_types ft ON ft.id = p.type_id
LEFT JOIN public.retailers       r  ON r.id  = p.retailer_id;

-- The view inherits RLS from products, but be explicit about who reads it.
REVOKE ALL ON public.products_shop FROM PUBLIC;
GRANT SELECT ON public.products_shop TO anon, authenticated, service_role;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- Chip counts for the grid — this is the query the facets endpoint will run.
--
-- SELECT shop_group, group_sort, count(*) AS n
-- FROM public.products_shop
-- GROUP BY shop_group, group_sort
-- ORDER BY group_sort;
--
-- Expect Seating 9, Tables 7, Storage 3, Beds 2, Lighting 2, Decor 1
-- from the dev seed.
