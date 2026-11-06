-- 20261106_round1_listings_terms_invoices.sql
-- Round 1 of the client feedback:
--   1. products: more than one category, certificates, patents, where it is
--      made and which countries it ships to
--   2. terms_acceptances: who accepted which terms, which version, when, as
--      which role (client / vendor / factory / employee)
--   3. invoices: one Nooi tax invoice per order, numbered in sequence
-- Safe to run more than once.

BEGIN;

-- 1. Listings -----------------------------------------------------------------

ALTER TABLE public.products
  -- Shop groups the listing appears under (Seating, Tables, Storage, ...).
  -- Always includes the group of its furniture type — the trigger below
  -- keeps it that way, so the marketplace filter only has to look here.
  ADD COLUMN IF NOT EXISTS categories   text[] NOT NULL DEFAULT '{}',
  -- [{ "name", "issuer", "number", "url", "expires" }]
  ADD COLUMN IF NOT EXISTS certificates jsonb  NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "number", "country", "title", "url" }]
  ADD COLUMN IF NOT EXISTS patents      jsonb  NOT NULL DEFAULT '[]'::jsonb,
  -- 'saudi' = made in Saudi Arabia; 'international' = imported
  ADD COLUMN IF NOT EXISTS origin         text,
  ADD COLUMN IF NOT EXISTS origin_country text,
  -- ISO 3166-1 alpha-2 codes. Empty = Saudi Arabia only.
  ADD COLUMN IF NOT EXISTS ships_to     text[] NOT NULL DEFAULT '{SA}';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_origin_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_origin_check
      CHECK (origin IS NULL OR origin IN ('saudi', 'international'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_categories ON public.products USING gin (categories);
CREATE INDEX IF NOT EXISTS idx_products_ships_to   ON public.products USING gin (ships_to);
CREATE INDEX IF NOT EXISTS idx_products_origin     ON public.products (origin);

-- The furniture type's own group is always one of the categories.
CREATE OR REPLACE FUNCTION public.products_keep_type_group()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g text;
BEGIN
  SELECT shop_group INTO g FROM public.furniture_types WHERE id = NEW.type_id;
  NEW.categories := COALESCE(NEW.categories, '{}');
  IF g IS NOT NULL AND NOT (g = ANY (NEW.categories)) THEN
    NEW.categories := array_prepend(g, NEW.categories);
  END IF;
  IF NEW.ships_to IS NULL OR cardinality(NEW.ships_to) = 0 THEN
    NEW.ships_to := '{SA}';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_products_keep_type_group ON public.products;
CREATE TRIGGER trg_products_keep_type_group
  BEFORE INSERT OR UPDATE OF type_id, categories, ships_to ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_keep_type_group();

-- Existing listings: their type's group; origin from the retailer's country.
UPDATE public.products p SET categories = ARRAY[ft.shop_group]
FROM public.furniture_types ft
WHERE ft.id = p.type_id AND cardinality(p.categories) = 0;

UPDATE public.products p
SET origin = CASE WHEN r.country IS NULL OR r.country ILIKE 'saudi%' OR r.country = 'SA'
                  THEN 'saudi' ELSE 'international' END
FROM public.retailers r
WHERE r.id = p.retailer_id AND p.origin IS NULL;

-- Vendor logos: the storefront row carries the same logo as the vendor profile.
ALTER TABLE public.vendor_profiles ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.retailers       ADD COLUMN IF NOT EXISTS logo_url text;

-- 2. Terms acceptance ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('client', 'vendor', 'factory', 'employee')),
  document    text NOT NULL CHECK (document IN ('terms', 'privacy', 'vendor_agreement', 'employee_policy')),
  version     text NOT NULL,
  context     text,                 -- checkout, vendor_onboarding, listing, admin, ...
  ip          text,
  user_agent  text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, document, version)
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user ON public.terms_acceptances (user_id, accepted_at DESC);

ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS terms_acceptances_own_read ON public.terms_acceptances;
CREATE POLICY terms_acceptances_own_read ON public.terms_acceptances
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- Inserts go through the API (service role) so the IP and time are trustworthy.

-- 3. Invoices -----------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text UNIQUE NOT NULL
                   DEFAULT ('INV-' || to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY') || '-'
                            || lpad(nextval('public.invoice_number_seq')::text, 6, '0')),
  order_id       uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind           text NOT NULL DEFAULT 'simplified' CHECK (kind IN ('simplified', 'standard')),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  supply_date    timestamptz,
  seller         jsonb NOT NULL,     -- { legal_name, vat_number, cr_number, address }
  buyer          jsonb NOT NULL,     -- { name, address, vat_number? }
  lines          jsonb NOT NULL,     -- [{ title, sku, vendor, quantity, unit_price, total }]
  subtotal       numeric(12,2) NOT NULL,
  discount       numeric(12,2) NOT NULL DEFAULT 0,
  shipping       numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate       numeric(5,2)  NOT NULL DEFAULT 15,
  vat_amount     numeric(12,2) NOT NULL,
  total          numeric(12,2) NOT NULL,
  currency       text NOT NULL DEFAULT 'SAR',
  qr_tlv         text            -- ZATCA phase-1 QR payload (base64 TLV)
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON public.invoices (user_id, issued_at DESC);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_own_read ON public.invoices;
CREATE POLICY invoices_own_read ON public.invoices
  FOR SELECT TO authenticated USING (user_id = auth.uid());

COMMIT;
