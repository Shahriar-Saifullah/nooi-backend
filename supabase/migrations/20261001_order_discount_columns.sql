-- Phase 03 — Discount columns on orders
-- ============================================================================
-- Without these, a discounted order stores a total_amount that its own
-- subtotal + shipping + tax do not add up to. Any invoice, receipt or refund
-- calculation reading that row would be wrong, and there would be no record of
-- which code was used.
--
-- Added as columns rather than changing create_order_atomic's signature: that
-- function is referenced by the checkout tests, and the webhook can write these
-- in the same breath as consuming the promotion.
--
-- Safe to re-run.
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_code  TEXT,
  ADD COLUMN IF NOT EXISTS promotion_id    UUID REFERENCES public.promotions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.orders.discount_amount IS
  'Amount taken off the goods subtotal. total_amount = subtotal - discount_amount + shipping_amount + tax_amount.';

CREATE INDEX IF NOT EXISTS idx_orders_promotion_id
  ON public.orders(promotion_id) WHERE promotion_id IS NOT NULL;
