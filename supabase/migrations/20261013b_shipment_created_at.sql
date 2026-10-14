-- Phase 03 — order_shipments.created_at
-- ============================================================================
-- The table was created without one. Every other table on this project has it,
-- and the vendor fulfilment queue sorts on it: oldest first, so a shipment
-- cannot sit for three weeks while fresher ones get picked.
--
-- Backfilled from the parent order, which is accurate — create_order_atomic
-- writes the order and its shipments in the same transaction.
--
-- Safe to re-run.
-- ============================================================================

ALTER TABLE public.order_shipments
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE public.order_shipments s
SET created_at = o.created_at
FROM public.orders o
WHERE o.id = s.order_id
  AND s.created_at IS NULL;

-- Only after backfilling, or the NOT NULL would reject the existing rows.
ALTER TABLE public.order_shipments
  ALTER COLUMN created_at SET DEFAULT now();

UPDATE public.order_shipments SET created_at = now() WHERE created_at IS NULL;

ALTER TABLE public.order_shipments
  ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipments_created_at
  ON public.order_shipments (created_at);

NOTIFY pgrst, 'reload schema';

-- Verify --------------------------------------------------------------------
-- SELECT count(*) FROM order_shipments WHERE created_at IS NULL;  -- expect 0
