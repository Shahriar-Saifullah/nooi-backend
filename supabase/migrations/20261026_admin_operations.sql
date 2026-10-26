-- Admin operations: listing review, cancellations, support, settings
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Listing review — new listings are hidden until an admin approves them
-- ════════════════════════════════════════════════════════════════════════════
-- Existing products are already on sale, so the column is added with default
-- 'approved' (filling them in) and the default then flipped to 'pending' so
-- anything inserted from now on starts hidden.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS listing_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS review_note    TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.products ALTER COLUMN listing_status SET DEFAULT 'pending';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_listing_status_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_listing_status_check
      CHECK (listing_status IN ('pending', 'approved', 'rejected', 'deactivated'));
  END IF;
END $$;

COMMENT ON COLUMN public.products.listing_status IS
  'pending: waiting for admin review, hidden. approved: on sale. rejected: '
  'vendor must change and resubmit (review_note says why). deactivated: taken '
  'off sale by the vendor or an admin.';
COMMENT ON COLUMN public.products.review_note IS
  'Why a listing was rejected or taken down. The vendor sees this.';

CREATE INDEX IF NOT EXISTS idx_products_listing_queue
  ON public.products (submitted_at) WHERE listing_status = 'pending';

-- The shop view only ever shows approved listings. Recreated (not replaced)
-- because p.* gains columns.
DROP VIEW IF EXISTS public.products_shop;
CREATE VIEW public.products_shop AS
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
LEFT JOIN public.retailers       r  ON r.id  = p.retailer_id
WHERE p.listing_status = 'approved';
REVOKE ALL ON public.products_shop FROM PUBLIC;
GRANT SELECT ON public.products_shop TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Cancellation requests — customer (whole order) or vendor (their part)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_cancellation_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  -- NULL = the whole order (customer). Set = one vendor's shipment (vendor).
  shipment_id     UUID REFERENCES public.order_shipments(id) ON DELETE CASCADE,
  requested_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  requester_role  TEXT NOT NULL CHECK (requester_role IN ('customer', 'vendor')),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'processing', 'approved', 'declined')),
  decided_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  refund_amount   NUMERIC(10,2),
  refund_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open request per order / per shipment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancel_open_order
  ON public.order_cancellation_requests (order_id)
  WHERE shipment_id IS NULL AND status IN ('requested', 'processing');
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancel_open_shipment
  ON public.order_cancellation_requests (shipment_id)
  WHERE shipment_id IS NOT NULL AND status IN ('requested', 'processing');
CREATE INDEX IF NOT EXISTS idx_cancel_queue
  ON public.order_cancellation_requests (status, created_at);
ALTER TABLE public.order_cancellation_requests ENABLE ROW LEVEL SECURITY;

-- Claim a request so only one admin acts on it.
CREATE OR REPLACE FUNCTION public.claim_cancellation_request(p_request_id UUID, p_admin_id UUID)
RETURNS TABLE (claimed BOOLEAN, current_status TEXT) AS $$
DECLARE v INT;
BEGIN
  UPDATE public.order_cancellation_requests
  SET status = 'processing', decided_by = p_admin_id, updated_at = now()
  WHERE id = p_request_id AND status = 'requested';
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN QUERY SELECT (v > 0), r.status FROM public.order_cancellation_requests r WHERE r.id = p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Cancel one vendor's shipment inside an order (after its refund went out):
-- items cancelled, stock back, shipment cancelled; the whole order becomes
-- cancelled if nothing else is left on it.
CREATE OR REPLACE FUNCTION public.settle_shipment_cancellation(p_shipment_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_ship RECORD;
  v_left INT;
BEGIN
  SELECT * INTO v_ship FROM public.order_shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHIPMENT_NOT_FOUND'; END IF;

  UPDATE public.product_variants pv
  SET stock_quantity = pv.stock_quantity + oi.quantity
  FROM public.order_items oi
  WHERE oi.order_id = v_ship.order_id AND oi.retailer_id = v_ship.retailer_id
    AND pv.id = oi.variant_id AND oi.item_status NOT IN ('returned', 'cancelled');

  UPDATE public.order_items SET item_status = 'cancelled'
  WHERE order_id = v_ship.order_id AND retailer_id = v_ship.retailer_id
    AND item_status NOT IN ('returned', 'cancelled');

  UPDATE public.order_shipments SET shipment_status = 'cancelled', updated_at = now()
  WHERE id = p_shipment_id;

  SELECT count(*) INTO v_left FROM public.order_shipments
  WHERE order_id = v_ship.order_id AND shipment_status <> 'cancelled';
  IF v_left = 0 THEN
    UPDATE public.orders SET status = 'cancelled' WHERE id = v_ship.order_id;
    RETURN 'order_cancelled';
  END IF;
  RETURN 'shipment_cancelled';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Reverse one vendor's earnings on an order (their shipment was cancelled).
CREATE OR REPLACE FUNCTION public.reverse_shipment_earnings(p_shipment_id UUID, p_note TEXT)
RETURNS INT AS $$
DECLARE
  v_ship RECORD;
  v_n INT := 0;
  v_k INT;
  e RECORD;
BEGIN
  SELECT * INTO v_ship FROM public.order_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR e IN
    SELECT DISTINCT order_item_id FROM public.vendor_earnings
    WHERE order_id = v_ship.order_id AND retailer_id = v_ship.retailer_id
      AND kind = 'sale' AND order_item_id IS NOT NULL
  LOOP
    SELECT public.reverse_vendor_earnings(v_ship.order_id, e.order_item_id, p_note) INTO v_k;
    v_n := v_n + v_k;
  END LOOP;
  -- the shipping line for this shipment
  UPDATE public.vendor_earnings
  SET status = 'reversed', reversed_at = now(), note = p_note
  WHERE shipment_id = p_shipment_id AND kind = 'shipping' AND status IN ('pending', 'payable');
  GET DIAGNOSTICS v_k = ROW_COUNT;
  v_n := v_n + v_k;
  INSERT INTO public.vendor_earnings (
    vendor_id, retailer_id, order_id, order_item_id, shipment_id, kind,
    reverses_id, currency, gross_minor, commission_rate, commission_minor,
    net_minor, status, payable_at, note)
  SELECT vendor_id, retailer_id, order_id, NULL, shipment_id, 'reversal', id, currency,
         -gross_minor, 0, 0, -net_minor, 'payable', now(), p_note
  FROM public.vendor_earnings
  WHERE shipment_id = p_shipment_id AND kind = 'shipping' AND status IN ('in_payout', 'paid')
  ON CONFLICT (reverses_id) DO NOTHING;
  GET DIAGNOSTICS v_k = ROW_COUNT;
  RETURN v_n + v_k;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Support tickets
-- ════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number START 1001;

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           BIGINT NOT NULL UNIQUE DEFAULT nextval('public.support_ticket_number'),
  created_by       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requester_role   TEXT NOT NULL CHECK (requester_role IN ('customer', 'vendor')),
  subject          TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'general',
  order_id         UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  -- open: waiting on Nooi. waiting: Nooi replied, waiting on the requester.
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved')),
  assigned_to      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_unread     BOOLEAN NOT NULL DEFAULT true,
  requester_unread BOOLEAN NOT NULL DEFAULT false,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_queue ON public.support_tickets (status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_support_requester ON public.support_tickets (created_by, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer', 'vendor', 'admin')),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON public.support_messages (ticket_id, created_at);

ALTER TABLE public.support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Platform settings — one row
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.platform_settings (
  id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00
                            CHECK (default_commission_rate BETWEEN 0 AND 100),
  payout_hold_days        INT NOT NULL DEFAULT 0 CHECK (payout_hold_days BETWEEN 0 AND 90),
  return_window_days      INT NOT NULL DEFAULT 30 CHECK (return_window_days BETWEEN 0 AND 365),
  min_payout_sar          NUMERIC(10,2) NOT NULL DEFAULT 1.00 CHECK (min_payout_sar >= 1),
  support_email           TEXT,
  support_phone           TEXT,
  legal_name              TEXT,
  legal_address           TEXT,
  vat_number              TEXT,
  cr_number               TEXT,
  updated_by              UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- New vendors get the default commission from settings instead of a fixed 10%.
CREATE OR REPLACE FUNCTION public.decide_vendor_application(
  p_vendor_id        UUID,
  p_admin_id         UUID,
  p_status           TEXT,
  p_rejection_reason TEXT DEFAULT NULL
) RETURNS TABLE (applied BOOLEAN, final_status TEXT, decided_by UUID, decided_at TIMESTAMPTZ) AS $$
DECLARE
  v_updated INT;
  v_vendor  RECORD;
BEGIN
  IF p_status NOT IN ('approved', 'rejected', 'suspended') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_status;
  END IF;
  UPDATE public.vendor_profiles
  SET status           = p_status,
      decided_by       = p_admin_id,
      decided_at       = now(),
      verified_at      = CASE WHEN p_status = 'approved' THEN now() ELSE verified_at END,
      rejection_reason = CASE WHEN p_status = 'rejected' THEN p_rejection_reason ELSE NULL END,
      reviewing_by     = NULL,
      reviewing_at     = NULL,
      updated_at       = now()
  WHERE id = p_vendor_id
    AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 AND p_status = 'approved' THEN
    SELECT business_name, store_name, city, country INTO v_vendor
    FROM public.vendor_profiles WHERE id = p_vendor_id;
    IF NOT EXISTS (SELECT 1 FROM public.retailers WHERE vendor_id = p_vendor_id) THEN
      INSERT INTO public.retailers (name, vendor_id, city, country, api_adapter_type, commission_rate)
      VALUES (
        COALESCE(NULLIF(v_vendor.store_name, ''), v_vendor.business_name),
        p_vendor_id, v_vendor.city, v_vendor.country, 'self_serve',
        COALESCE((SELECT default_commission_rate FROM public.platform_settings WHERE id = 1), 10.00)
      );
    END IF;
  END IF;
  RETURN QUERY
  SELECT (v_updated > 0), vp.status::TEXT, vp.decided_by, vp.decided_at
  FROM public.vendor_profiles vp WHERE vp.id = p_vendor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.decide_vendor_application(UUID, UUID, TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_cancellation_request(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_cancellation_request(UUID, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.settle_shipment_cancellation(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_shipment_cancellation(UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.reverse_shipment_earnings(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_shipment_earnings(UUID, TEXT) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
