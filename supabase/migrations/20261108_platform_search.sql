-- 20261108_platform_search.sql
-- Platform-wide search: one query across products, vendors, projects, orders,
-- invoices, support tickets and (admins) accounts — each row only if the
-- person searching may see it.
--
--   scope    'public'  signed out: approved products, approved vendors
--            'client'  + their own projects, orders, invoices, tickets
--            'vendor'  + their own listings (any status), orders with their
--                        items, their tickets
--            'admin'   everything, plus vendor and staff accounts
--
-- Typos: pg_trgm word similarity ("sofaa" finds "Sofa"). Arabic: matched as a
-- substring (trigram extraction may skip Arabic letters, ILIKE doesn't).
-- Called only by the API with the service role; the API decides the scope
-- from the signed-in user, never from the request.
-- Safe to run more than once.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_products_title_trgm   ON public.products        USING gin (lower(title) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_retailers_name_trgm   ON public.retailers       USING gin (lower(name) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_orders_number_trgm    ON public.orders          USING gin (lower(order_number) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tickets_subject_trgm  ON public.support_tickets USING gin (lower(subject) extensions.gin_trgm_ops);
DO $$ BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_projects_name_trgm ON public.projects USING gin (lower(name) extensions.gin_trgm_ops)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.platform_search(
  p_q      text,
  p_user   uuid,
  p_scope  text,
  p_kinds  text[],
  p_limit  int DEFAULT 6
) RETURNS TABLE (
  kind     text,
  id       text,
  title    text,
  subtitle text,
  image    text,
  ref      text,     -- what the link needs (order id, ticket id …)
  status   text,
  score    real
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  t   text := lower(btrim(coalesce(p_q, '')));
  pat text;
  lim int  := LEAST(GREATEST(coalesce(p_limit, 6), 1), 25);
  scope text := CASE WHEN p_scope IN ('client', 'vendor', 'admin') AND p_user IS NOT NULL THEN p_scope ELSE 'public' END;
  -- an order number or a ticket number typed with its prefix
  num text;
BEGIN
  IF length(t) < 2 THEN RETURN; END IF;
  t := left(t, 80);
  pat := '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  num := nullif(regexp_replace(t, '^(nooi-|#|inv-\d{4}-)', ''), '');

  -- Products ------------------------------------------------------------------
  IF 'product' = ANY (p_kinds) THEN
    RETURN QUERY
    SELECT 'product'::text, p.id::text, p.title::text, coalesce(r.name, '')::text,
      (SELECT (v.images)[1] FROM product_variants v WHERE v.product_id = p.id AND v.is_active IS NOT FALSE ORDER BY v.price LIMIT 1),
      p.id::text, p.listing_status::text,
      GREATEST(
        word_similarity(t, lower(p.title)),
        CASE WHEN lower(p.title) LIKE t || '%' THEN 1.0
             WHEN p.title ILIKE pat THEN 0.85
             WHEN r.name ILIKE pat THEN 0.6
             ELSE 0.5 END
      )::real AS s
    FROM products p
    LEFT JOIN retailers r ON r.id = p.retailer_id
    WHERE (p.listing_status = 'approved' OR scope = 'admin' OR (scope = 'vendor' AND r.vendor_id = p_user))
      AND (p.title ILIKE pat OR coalesce(p.description, '') ILIKE pat OR r.name ILIKE pat
           OR array_to_string(coalesce(p.tags, '{}'), ' ') ILIKE pat
           OR array_to_string(coalesce(p.categories, '{}'), ' ') ILIKE pat
           OR word_similarity(t, lower(p.title)) > 0.45)
    ORDER BY s DESC, p.created_at DESC
    LIMIT lim;
  END IF;

  -- Vendors / factories (storefronts) ------------------------------------------
  IF 'vendor' = ANY (p_kinds) THEN
    RETURN QUERY
    SELECT 'vendor'::text, r.id::text, r.name::text,
      concat_ws(' · ', nullif(r.city::text, ''), CASE WHEN lower(coalesce(vp.fulfillment_type, '')) = 'factory' THEN 'Factory' END),
      r.logo_url::text, r.id::text, coalesce(vp.status::text, 'approved'),
      GREATEST(
        word_similarity(t, lower(r.name)),
        CASE WHEN lower(r.name) LIKE t || '%' THEN 1.0 WHEN r.name ILIKE pat THEN 0.85 ELSE 0.5 END
      )::real AS s
    FROM retailers r
    LEFT JOIN vendor_profiles vp ON vp.id = r.vendor_id
    WHERE (scope = 'admin' OR vp.id IS NULL OR vp.status = 'approved')
      AND (r.name ILIKE pat OR coalesce(r.city, '') ILIKE pat OR word_similarity(t, lower(r.name)) > 0.45
           OR (t IN ('factory', 'factories', 'مصنع') AND lower(coalesce(vp.fulfillment_type, '')) = 'factory'))
    ORDER BY s DESC
    LIMIT lim;
  END IF;

  -- Projects (own) ---------------------------------------------------------------
  IF 'project' = ANY (p_kinds) AND scope <> 'public' AND to_regclass('public.projects') IS NOT NULL THEN
    RETURN QUERY EXECUTE
      'SELECT ''project''::text, pr.id::text, coalesce(nullif(pr.name, ''''), ''Untitled project''),
              concat_ws('' · '', nullif(pr.project_type, ''''), nullif(pr.address, '''')),
              pr.thumbnail_url::text, pr.id::text, pr.status::text,
              GREATEST(word_similarity($1, lower(coalesce(pr.name, ''''))),
                       CASE WHEN lower(coalesce(pr.name, '''')) LIKE $1 || ''%'' THEN 1.0 ELSE 0.6 END)::real AS s
         FROM projects pr
        WHERE pr.user_id = $3
          AND (coalesce(pr.name, '''') ILIKE $2 OR coalesce(pr.address, '''') ILIKE $2
               OR word_similarity($1, lower(coalesce(pr.name, ''''))) > 0.45)
        ORDER BY s DESC, pr.updated_at DESC NULLS LAST
        LIMIT $4'
      USING t, pat, p_user, lim;
  END IF;

  -- Orders ------------------------------------------------------------------------
  IF 'order' = ANY (p_kinds) AND scope <> 'public' THEN
    RETURN QUERY
    SELECT 'order'::text, o.id::text, o.order_number::text,
      concat_ws(' · ',
        CASE WHEN scope <> 'client' THEN nullif(o.shipping_address->>'fullName', '') END,
        to_char(o.created_at AT TIME ZONE 'Asia/Riyadh', 'DD Mon YYYY'),
        o.currency || ' ' || to_char(o.total_amount, 'FM999,999,990.00')),
      NULL::text, o.id::text, o.status::text,
      CASE WHEN lower(o.order_number) = t OR lower(o.order_number) = 'nooi-' || num THEN 1.0
           WHEN o.order_number ILIKE pat THEN 0.9
           ELSE 0.6 END::real AS s
    FROM orders o
    WHERE (scope = 'admin'
           OR (scope = 'client' AND o.user_id = p_user)
           OR (scope = 'vendor' AND EXISTS (
                SELECT 1 FROM order_items oi JOIN retailers r ON r.id = oi.retailer_id
                 WHERE oi.order_id = o.id AND r.vendor_id = p_user)))
      AND (o.order_number ILIKE pat
           OR (num IS NOT NULL AND o.order_number ILIKE '%' || num || '%')
           OR (scope <> 'client' AND coalesce(o.shipping_address->>'fullName', '') ILIKE pat)
           OR (scope = 'admin' AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = o.user_id AND lower(u.email) LIKE pat))
           OR EXISTS (SELECT 1 FROM order_items oi JOIN products pp ON pp.id = oi.product_id
                       WHERE oi.order_id = o.id AND pp.title ILIKE pat
                         AND (scope <> 'vendor' OR EXISTS (SELECT 1 FROM retailers r2 WHERE r2.id = oi.retailer_id AND r2.vendor_id = p_user))))
    ORDER BY s DESC, o.created_at DESC
    LIMIT lim;
  END IF;

  -- Invoices -----------------------------------------------------------------------
  IF 'invoice' = ANY (p_kinds) AND scope IN ('client', 'admin') THEN
    RETURN QUERY
    SELECT 'invoice'::text, i.id::text, i.invoice_number::text,
      concat_ws(' · ', to_char(i.issued_at AT TIME ZONE 'Asia/Riyadh', 'DD Mon YYYY'),
                i.currency || ' ' || to_char(i.total, 'FM999,999,990.00')),
      NULL::text, i.order_id::text, NULL::text,
      CASE WHEN lower(i.invoice_number) = t THEN 1.0 ELSE 0.85 END::real
    FROM invoices i
    WHERE (scope = 'admin' OR i.user_id = p_user)
      AND (i.invoice_number ILIKE pat OR (num IS NOT NULL AND i.invoice_number ILIKE '%' || num || '%'))
    ORDER BY i.issued_at DESC
    LIMIT lim;
  END IF;

  -- Support tickets ------------------------------------------------------------------
  IF 'ticket' = ANY (p_kinds) AND scope <> 'public' THEN
    RETURN QUERY
    SELECT 'ticket'::text, st.id::text, st.subject::text,
      concat_ws(' · ', '#' || st.number::text, initcap(st.status::text)),
      NULL::text, st.id::text, st.status::text,
      GREATEST(word_similarity(t, lower(st.subject)),
               CASE WHEN st.number::text = num THEN 1.0 WHEN st.subject ILIKE pat THEN 0.8 ELSE 0.5 END)::real AS s
    FROM support_tickets st
    WHERE (scope = 'admin' OR st.created_by = p_user)
      AND (st.subject ILIKE pat OR st.number::text = num OR word_similarity(t, lower(st.subject)) > 0.5)
    ORDER BY s DESC, st.last_message_at DESC
    LIMIT lim;
  END IF;

  -- Accounts (admins only): vendors / factories and Nooi staff -------------------------
  IF 'account' = ANY (p_kinds) AND scope = 'admin' THEN
    RETURN QUERY
    SELECT 'account'::text, pf.id::text,
      coalesce(nullif(vp.store_name, ''), nullif(vp.business_name, ''), nullif(pf.full_name, ''), u.email::text, 'Account')::text,
      concat_ws(' · ',
        CASE pf.role::text WHEN 'vendor' THEN CASE WHEN lower(coalesce(vp.fulfillment_type, '')) = 'factory' THEN 'Factory' ELSE 'Vendor' END
                     WHEN 'admin' THEN 'Nooi admin' WHEN 'super_admin' THEN 'Nooi super admin' ELSE 'Customer' END,
        u.email::text),
      NULL::text, pf.id::text, coalesce(vp.status::text, pf.role::text),
      CASE WHEN lower(coalesce(vp.business_name, pf.full_name, '')) LIKE t || '%' OR lower(u.email::text) LIKE t || '%' THEN 0.95 ELSE 0.6 END::real
    FROM profiles pf
    LEFT JOIN vendor_profiles vp ON vp.id = pf.id
    LEFT JOIN auth.users u ON u.id = pf.id
    WHERE pf.role::text IN ('vendor', 'admin', 'super_admin')
      AND (coalesce(pf.full_name, '') ILIKE pat OR lower(coalesce(u.email::text, '')) LIKE pat
           OR coalesce(vp.business_name, '') ILIKE pat OR coalesce(vp.store_name, '') ILIKE pat
           OR coalesce(vp.business_email, '') ILIKE pat)
    LIMIT lim;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.platform_search(text, uuid, text, text[], int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.platform_search(text, uuid, text, text[], int) TO service_role;

COMMIT;
