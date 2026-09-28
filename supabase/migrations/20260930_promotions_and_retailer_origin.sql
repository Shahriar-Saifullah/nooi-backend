-- Phase 03 — Promotions and retailer origin
-- ============================================================================
-- Adds what the cart design needs and the schema doesn't have.
--
-- 1. promotions / promotion_redemptions
--    The cart shows "Promo NOOI10  −$248". That requires a code to validate
--    against, rules to validate by, and a record of who redeemed what.
--
--    RLS is deliberately service-role only. A publicly readable promotions
--    table lets anyone SELECT every code you have ever issued, including ones
--    scheduled for a future campaign. Validation happens in the backend and
--    only ever answers "this code is worth X on this cart" — it never returns
--    the list.
--
-- 2. retailers.city
--    "ships from {city}" on each cart group.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- 1. Where a vendor ships from -------------------------------------------------

ALTER TABLE public.retailers
  ADD COLUMN IF NOT EXISTS city    TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT;

UPDATE public.retailers SET city = v.city, country = v.country
FROM (VALUES
  ('Havenly Home',   'London',    'United Kingdom'),
  ('Nordic Living',  'Copenhagen','Denmark'),
  ('Atelier Maison', 'Lyon',      'France'),
  ('Gulf Interiors', 'Dubai',     'United Arab Emirates')
) AS v(name, city, country)
WHERE retailers.name = v.name AND retailers.city IS NULL;

-- 2. Promotions ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.promotions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL,
  description    TEXT,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  /** Percent codes without a ceiling are how a 10% code costs you 600 on a
      6,100 sectional. NULL means uncapped, chosen deliberately. */
  max_discount   NUMERIC(10,2),
  min_subtotal   NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'USD',
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  /** Total redemptions across everyone. NULL means unlimited. */
  usage_limit    INT,
  usage_count    INT NOT NULL DEFAULT 0,
  per_user_limit INT NOT NULL DEFAULT 1,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Codes are matched case-insensitively; "nooi10" and "NOOI10" are one code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_code_lower
  ON public.promotions (lower(code));

CREATE INDEX IF NOT EXISTS idx_promotions_active
  ON public.promotions (active) WHERE active = true;

CREATE TABLE IF NOT EXISTS public.promotion_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id  UUID NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  order_id      UUID,
  amount        NUMERIC(10,2) NOT NULL,
  redeemed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redemptions_promo_user
  ON public.promotion_redemptions (promotion_id, user_id);

-- One redemption per order, so a retried webhook can't double-count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_order
  ON public.promotion_redemptions (order_id) WHERE order_id IS NOT NULL;

-- 3. RLS ------------------------------------------------------------------------
-- No anon or authenticated policy anywhere below. The backend reads these with
-- the service-role key; nobody gets to enumerate codes from the browser.

ALTER TABLE public.promotions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages promotions" ON public.promotions;
CREATE POLICY "Service role manages promotions"
  ON public.promotions FOR ALL USING (auth.jwt()->>'role' = 'service_role');

DROP POLICY IF EXISTS "Service role manages redemptions" ON public.promotion_redemptions;
CREATE POLICY "Service role manages redemptions"
  ON public.promotion_redemptions FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- Shoppers may see their own redemption history (order detail, receipts).
DROP POLICY IF EXISTS "Users read own redemptions" ON public.promotion_redemptions;
CREATE POLICY "Users read own redemptions"
  ON public.promotion_redemptions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

-- 4. Atomic usage counter -------------------------------------------------------
-- A code with usage_limit 100 must not be redeemable 101 times because two
-- checkouts read the count at the same moment. The conditional UPDATE makes the
-- check and the increment one operation.

CREATE OR REPLACE FUNCTION public.consume_promotion(
  p_promotion_id UUID,
  p_user_id      UUID,
  p_order_id     UUID,
  p_amount       NUMERIC
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.promotions
  SET usage_count = usage_count + 1
  WHERE id = p_promotion_id
    AND active = true
    AND (usage_limit IS NULL OR usage_count < usage_limit)
    AND (starts_at IS NULL OR starts_at <= now())
    AND (ends_at   IS NULL OR ends_at   >= now());

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.promotion_redemptions (promotion_id, user_id, order_id, amount)
  VALUES (p_promotion_id, p_user_id, p_order_id, p_amount)
  ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Internal machinery, not a public API. Same reasoning as create_order_atomic.
REVOKE EXECUTE ON FUNCTION public.consume_promotion(UUID, UUID, UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consume_promotion(UUID, UUID, UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION public.consume_promotion(UUID, UUID, UUID, NUMERIC) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.consume_promotion(UUID, UUID, UUID, NUMERIC) TO service_role;

-- 5. Seed ------------------------------------------------------------------------
-- NOOI10 is the code shown in the design.

INSERT INTO public.promotions
  (code, description, discount_type, discount_value, max_discount, min_subtotal, per_user_limit)
VALUES
  ('NOOI10', '10% off your first order', 'percent', 10, 500, 200, 1),
  ('FREESHIP', 'Flat $50 off', 'fixed', 50, NULL, 300, 1)
ON CONFLICT (lower(code)) DO NOTHING;

COMMIT;

-- Verify --------------------------------------------------------------------------
-- SELECT code, discount_type, discount_value, max_discount, min_subtotal
-- FROM public.promotions ORDER BY code;
--
-- SELECT name, city, country FROM public.retailers ORDER BY name;
