-- Phase 03 — Returnability
-- ============================================================================
-- Only in-stock items can be returned, within 30 days of delivery. Made to
-- order and custom-size pieces are final sale: a sofa built to someone's
-- dimensions cannot be resold, so a refund is a total loss on goods that were
-- made specifically for that customer.
--
-- A real column rather than reading specs_json->>'kind', which is free text
-- written by the listing form. A renamed option or a typo there would silently
-- make a bespoke piece refundable, and nobody would find out until someone
-- demanded their money back on something that cannot go back on the shelf.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_returnable BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.products.is_returnable IS
  'False for made-to-order and custom pieces. Set from the listing type at '
  'creation — never inferred from specs_json at request time.';

-- Backfill from what the listing form has written so far. The 31 seeded
-- products have no `kind` and stay returnable, which is correct — they are
-- catalogue stock.
UPDATE public.products
SET is_returnable = false
WHERE specs_json->>'kind' IN ('Made to order', 'Custom size');

-- The shopper needs to know before buying, and the vendor needs to know before
-- listing, so this is read on the product page as well as enforced server-side.
CREATE INDEX IF NOT EXISTS idx_products_returnable
  ON public.products (is_returnable) WHERE is_returnable = false;

COMMIT;

-- Verify ----------------------------------------------------------------------
-- SELECT p.title, p.specs_json->>'kind' AS kind, p.is_returnable
-- FROM public.products p ORDER BY p.is_returnable, p.title;
--   expect false for every 'Made to order' and 'Custom size' row
