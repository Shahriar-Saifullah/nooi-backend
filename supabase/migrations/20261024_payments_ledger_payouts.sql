-- Payments in Saudi Arabia: Moyasar, the vendor earnings ledger, and payouts
-- ============================================================================
-- Money flow:
--   1. The customer pays through Moyasar. The money settles to NOOI's account.
--   2. Each order item (and each vendor's shipping charge) becomes a row in
--      vendor_earnings: gross, Nooi's commission, the vendor's net. 'pending'.
--   3. It becomes 'payable' once an admin has APPROVED the order AND that
--      vendor's shipment is DELIVERED (plus an optional hold, PAYOUT_HOLD_DAYS).
--   4. An admin pays a vendor everything payable in one payout, sent from
--      Nooi's bank account to the vendor's IBAN through Moyasar Payouts.
--
-- Amounts in the ledger are integer HALALAS (1 SAR = 100). Never floats.
--
-- Refunds after a vendor was paid do not rewrite history: they add a negative
-- 'reversal' row, which comes off the vendor's next payout.

BEGIN;

-- ── Orders: which gateway, and the admin approval ──────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.orders.payment_intent_id IS
  'The gateway''s payment id: a Stripe PaymentIntent (pi_…) or a Moyasar '
  'payment (uuid). payment_provider says which.';
COMMENT ON COLUMN public.orders.approved_at IS
  'An admin has checked this order. Vendor earnings are not payable before it.';

ALTER TABLE public.checkout_attempts
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'stripe';

-- ── Vendor bank accounts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_payout_accounts (
  vendor_id      UUID PRIMARY KEY REFERENCES public.vendor_profiles(id) ON DELETE CASCADE,
  account_holder TEXT NOT NULL,
  iban           TEXT NOT NULL CHECK (iban ~ '^SA[0-9]{22}$'),
  bank_name      TEXT,
  mobile         TEXT NOT NULL,
  city           TEXT NOT NULL,
  country        TEXT NOT NULL DEFAULT 'SA',
  verified_at    TIMESTAMPTZ,
  verified_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.vendor_payout_accounts.verified_at IS
  'An admin checked the IBAN belongs to the vendor''s business. Cleared '
  'whenever the IBAN or holder changes, so a hijacked login cannot redirect '
  'payouts without a second person noticing.';

-- ── Payouts ────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.payout_sequence START 1000000000000001;

CREATE TABLE IF NOT EXISTS public.vendor_payouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id          UUID NOT NULL REFERENCES public.vendor_profiles(id) ON DELETE RESTRICT,
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  currency           TEXT NOT NULL DEFAULT 'SAR',
  -- creating: claimed here, not yet accepted by Moyasar (retry is safe: the
  --           sequence number dedupes). Then Moyasar's own statuses.
  status             TEXT NOT NULL DEFAULT 'creating' CHECK (status IN (
                       'creating', 'queued', 'initiated', 'paid',
                       'failed', 'canceled', 'returned')),
  provider           TEXT NOT NULL DEFAULT 'moyasar',
  provider_payout_id TEXT UNIQUE,
  sequence_number    TEXT NOT NULL UNIQUE,
  channel            TEXT,
  destination        JSONB NOT NULL,
  earnings_count     INT NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  last_error         TEXT,
  created_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ,
  last_synced_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_vendor ON public.vendor_payouts (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_open
  ON public.vendor_payouts (last_synced_at NULLS FIRST)
  WHERE status IN ('creating', 'queued', 'initiated');

-- ── The ledger ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_earnings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        UUID NOT NULL REFERENCES public.vendor_profiles(id) ON DELETE RESTRICT,
  retailer_id      UUID REFERENCES public.retailers(id) ON DELETE SET NULL,
  order_id         UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id    UUID REFERENCES public.order_items(id) ON DELETE RESTRICT,
  shipment_id      UUID REFERENCES public.order_shipments(id) ON DELETE SET NULL,
  -- sale: one order item. shipping: the vendor's delivery charge on the order.
  -- reversal: a refund after the vendor was (being) paid; negative.
  kind             TEXT NOT NULL CHECK (kind IN ('sale', 'shipping', 'reversal')),
  reverses_id      UUID UNIQUE REFERENCES public.vendor_earnings(id) ON DELETE RESTRICT,
  currency         TEXT NOT NULL DEFAULT 'SAR',
  gross_minor      BIGINT NOT NULL,
  commission_rate  NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_minor BIGINT NOT NULL DEFAULT 0,
  net_minor        BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'payable', 'in_payout', 'paid', 'reversed')),
  payout_id        UUID REFERENCES public.vendor_payouts(id) ON DELETE SET NULL,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  payable_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  reversed_at      TIMESTAMPTZ,
  CHECK (net_minor = gross_minor - commission_minor)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_earnings_sale
  ON public.vendor_earnings (order_item_id) WHERE kind = 'sale';
CREATE UNIQUE INDEX IF NOT EXISTS uq_earnings_shipping
  ON public.vendor_earnings (shipment_id) WHERE kind = 'shipping';
CREATE INDEX IF NOT EXISTS idx_earnings_vendor_status ON public.vendor_earnings (vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_earnings_order ON public.vendor_earnings (order_id);
CREATE INDEX IF NOT EXISTS idx_earnings_payout ON public.vendor_earnings (payout_id) WHERE payout_id IS NOT NULL;

ALTER TABLE public.vendor_payout_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_payouts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_earnings        ENABLE ROW LEVEL SECURITY;
-- No policies: only the backend (service role) touches these tables.

-- ── Release: pending → payable ─────────────────────────────────────────────
-- Approved order + delivered shipment + hold elapsed + no open return on the
-- item. Safe to call any time, as often as you like.
CREATE OR REPLACE FUNCTION public.release_vendor_earnings(
  p_order_id  UUID DEFAULT NULL,
  p_hold_days INT  DEFAULT 0
) RETURNS INT AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.vendor_earnings e
  SET status = 'payable', payable_at = now()
  FROM public.orders o, public.order_shipments s
  WHERE e.status = 'pending'
    AND e.kind IN ('sale', 'shipping')
    AND (p_order_id IS NULL OR e.order_id = p_order_id)
    AND o.id = e.order_id
    AND o.approved_at IS NOT NULL
    AND o.status NOT IN ('cancelled', 'cancelling')
    AND s.id = e.shipment_id
    AND s.shipment_status = 'delivered'
    AND COALESCE(s.delivered_at, now()) <= now() - make_interval(days => GREATEST(p_hold_days, 0))
    AND (e.order_item_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.order_items oi
      WHERE oi.id = e.order_item_id AND oi.item_status IN ('returned', 'cancelled')))
    AND (e.order_item_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.order_returns r
      WHERE r.order_item_id = e.order_item_id AND r.status IN ('requested', 'refunding')));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Reverse: a refund took the money back ──────────────────────────────────
-- p_order_item_id set: that item's sale. Otherwise every sale and shipping row
-- on the order (a full cancellation). Not yet paid → marked 'reversed'.
-- Already in a payout or paid → a negative 'reversal' row, netted next time.
CREATE OR REPLACE FUNCTION public.reverse_vendor_earnings(
  p_order_id      UUID,
  p_order_item_id UUID DEFAULT NULL,
  p_note          TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_count INT := 0;
  v_n     INT;
BEGIN
  UPDATE public.vendor_earnings
  SET status = 'reversed', reversed_at = now(), note = COALESCE(p_note, note)
  WHERE order_id = p_order_id
    AND kind IN ('sale', 'shipping')
    AND status IN ('pending', 'payable')
    AND (p_order_item_id IS NULL OR order_item_id = p_order_item_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_count := v_count + v_n;

  INSERT INTO public.vendor_earnings (
    vendor_id, retailer_id, order_id, order_item_id, shipment_id, kind,
    reverses_id, currency, gross_minor, commission_rate, commission_minor,
    net_minor, status, payable_at, note)
  SELECT e.vendor_id, e.retailer_id, e.order_id, e.order_item_id, e.shipment_id,
         'reversal', e.id, e.currency, -e.gross_minor, e.commission_rate,
         -e.commission_minor, -e.net_minor, 'payable', now(), p_note
  FROM public.vendor_earnings e
  WHERE e.order_id = p_order_id
    AND e.kind IN ('sale', 'shipping')
    AND e.status IN ('in_payout', 'paid')
    AND (p_order_item_id IS NULL OR e.order_item_id = p_order_item_id)
  ON CONFLICT (reverses_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_count + v_n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Claim a payout: everything payable for one vendor, atomically ──────────
CREATE OR REPLACE FUNCTION public.claim_vendor_payout(
  p_vendor_id UUID,
  p_admin_id  UUID,
  p_hold_days INT DEFAULT 0,
  p_min_minor BIGINT DEFAULT 100
) RETURNS UUID AS $$
DECLARE
  v_acct   public.vendor_payout_accounts%ROWTYPE;
  v_total  BIGINT;
  v_count  INT;
  v_id     UUID;
BEGIN
  -- Serialises payouts per vendor: a second admin waits here, then finds
  -- nothing left to pay.
  SELECT * INTO v_acct FROM public.vendor_payout_accounts
  WHERE vendor_id = p_vendor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_PAYOUT_ACCOUNT'; END IF;
  IF v_acct.verified_at IS NULL THEN RAISE EXCEPTION 'PAYOUT_ACCOUNT_UNVERIFIED'; END IF;

  PERFORM public.release_vendor_earnings(NULL, p_hold_days);

  SELECT COALESCE(SUM(net_minor), 0), COUNT(*) INTO v_total, v_count
  FROM public.vendor_earnings
  WHERE vendor_id = p_vendor_id AND status = 'payable';

  IF v_total < GREATEST(p_min_minor, 1) THEN
    RAISE EXCEPTION 'NOTHING_TO_PAY:%', v_total;
  END IF;

  INSERT INTO public.vendor_payouts (
    vendor_id, amount_minor, currency, status, sequence_number,
    destination, earnings_count, created_by)
  VALUES (
    p_vendor_id, v_total, 'SAR', 'creating',
    lpad(nextval('public.payout_sequence')::TEXT, 16, '0'),
    jsonb_build_object(
      'type', 'bank', 'iban', v_acct.iban, 'name', v_acct.account_holder,
      'mobile', v_acct.mobile, 'country', v_acct.country, 'city', v_acct.city),
    v_count, p_admin_id)
  RETURNING id INTO v_id;

  UPDATE public.vendor_earnings
  SET status = 'in_payout', payout_id = v_id
  WHERE vendor_id = p_vendor_id AND status = 'payable';

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Settle a payout from Moyasar's status ──────────────────────────────────
-- paid → its earnings are paid. failed / canceled / returned → its earnings
-- go back to payable for the next payout (returned can follow paid: the bank
-- sent the money back).
CREATE OR REPLACE FUNCTION public.settle_vendor_payout(
  p_payout_id          UUID,
  p_status             TEXT,
  p_provider_payout_id TEXT DEFAULT NULL,
  p_channel            TEXT DEFAULT NULL,
  p_failure_reason     TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_prev TEXT;
BEGIN
  SELECT status INTO v_prev FROM public.vendor_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYOUT_NOT_FOUND'; END IF;

  -- Terminal states stay put, except paid → returned.
  IF v_prev IN ('failed', 'canceled', 'returned')
     OR (v_prev = 'paid' AND p_status <> 'returned') THEN
    RETURN v_prev;
  END IF;

  UPDATE public.vendor_payouts
  SET status             = p_status,
      provider_payout_id = COALESCE(p_provider_payout_id, provider_payout_id),
      channel            = COALESCE(p_channel, channel),
      failure_reason     = COALESCE(p_failure_reason, failure_reason),
      paid_at            = CASE WHEN p_status = 'paid' THEN now() ELSE paid_at END,
      updated_at         = now(),
      last_synced_at     = now()
  WHERE id = p_payout_id;

  IF p_status = 'paid' THEN
    UPDATE public.vendor_earnings SET status = 'paid', paid_at = now()
    WHERE payout_id = p_payout_id AND status = 'in_payout';
  ELSIF p_status IN ('failed', 'canceled', 'returned') THEN
    UPDATE public.vendor_earnings
    SET status = 'payable', payout_id = NULL, paid_at = NULL
    WHERE payout_id = p_payout_id AND status IN ('in_payout', 'paid');
  END IF;

  RETURN p_status;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ── Approve an order ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_order(
  p_order_id UUID,
  p_admin_id UUID,
  p_hold_days INT DEFAULT 0
) RETURNS TABLE (applied BOOLEAN, current_status TEXT, approved_on TIMESTAMPTZ) AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.orders o
  SET approved_at = now(), approved_by = p_admin_id
  WHERE o.id = p_order_id
    AND o.approved_at IS NULL
    AND o.status NOT IN ('cancelled', 'cancelling');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    PERFORM public.release_vendor_earnings(p_order_id, p_hold_days);
  END IF;
  RETURN QUERY SELECT (v_updated > 0), o.status::TEXT, o.approved_at
  FROM public.orders o WHERE o.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.release_vendor_earnings(UUID, INT)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_vendor_earnings(UUID, UUID, TEXT)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_vendor_payout(UUID, UUID, INT, BIGINT)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_vendor_payout(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_order(UUID, UUID, INT)                   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.release_vendor_earnings(UUID, INT)               TO service_role;
GRANT  EXECUTE ON FUNCTION public.reverse_vendor_earnings(UUID, UUID, TEXT)        TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_vendor_payout(UUID, UUID, INT, BIGINT)     TO service_role;
GRANT  EXECUTE ON FUNCTION public.settle_vendor_payout(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT  EXECUTE ON FUNCTION public.approve_order(UUID, UUID, INT)                   TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
