-- Phase 03 — Lock down SECURITY DEFINER functions
-- ============================================================================
-- Run AFTER 20260921_phase03_atomic_order_fn.sql.
--
-- Why
-- ---
-- Supabase exposes every function in the public schema as a PostgREST RPC at
-- /rest/v1/rpc/<name>, and the default grants give EXECUTE to anon and
-- authenticated. Three SECURITY DEFINER functions are therefore callable by
-- anyone holding the anon key, which ships in the frontend bundle:
--
--   create_order_atomic    Inserts an order with status 'paid' and
--                          payment_status 'succeeded', taking every amount as a
--                          parameter. A direct call mints a settled order for
--                          any total, with no payment and no Stripe involved —
--                          bypassing the server-side pricing, stock checks and
--                          cart-hash deduplication in checkout.service.ts.
--
--   restore_product_stock  Increments stock by any amount.
--   reserve_product_stock  Decrements it. A loop zeroes out inventory.
--
-- The functions themselves are correct. They are internal machinery that the
-- backend calls with the service-role key; they were never meant to be a public
-- API. This migration makes that explicit.
--
-- Also sets search_path on each. Without it, a SECURITY DEFINER function
-- resolves unqualified names against the caller's search_path, which is the
-- standard privilege-escalation route for definer functions.
--
-- Signatures are resolved from the catalog rather than written out, so this
-- keeps working if a parameter list changes. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  fn RECORD;
  found INT := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_order_atomic',
        'reserve_product_stock',
        'restore_product_stock'
      )
  LOOP
    -- Remove the default public grants.
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn.sig);

    -- Grant back explicitly to the roles the backend actually uses, so this
    -- does not depend on service_role's grant having survived the revoke.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', fn.sig);

    -- Standard SECURITY DEFINER hardening.
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);

    RAISE NOTICE 'Locked down %', fn.sig;
    found := found + 1;
  END LOOP;

  IF found = 0 THEN
    RAISE WARNING
      'No target functions found. Has 20260921_phase03_atomic_order_fn.sql been applied?';
  END IF;
END $$;

-- Verify ----------------------------------------------------------------------
-- Neither anon nor authenticated should appear for any of the three.
--
-- SELECT p.proname,
--        has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
--        has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('create_order_atomic','reserve_product_stock','restore_product_stock');
--
-- Expected: anon = false, authed = false, service = true.
