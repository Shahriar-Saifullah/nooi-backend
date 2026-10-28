-- 20261028_cart_cleanup.sql
-- ---------------------------------------------------------------------------
-- Cart fixes. Safe to run more than once.
--
-- 1. The old cart controller wrote guest rows under a shared session
--    ('default_session') with no user. Those rows were visible to — and
--    deletable by — every shopper. Checkout needs a signed-in user, so no
--    row without a user can ever be bought: remove them.
-- 2. RLS allowed `auth.uid() = user_id OR session_id IS NOT NULL`, which made
--    any row with a session id readable and writable by anyone holding the
--    anon key. Carts are now strictly per user. (The backend uses the service
--    role and is unaffected.)
-- ---------------------------------------------------------------------------

DELETE FROM public.cart_items WHERE user_id IS NULL;

DROP POLICY IF EXISTS "Users can view own cart items" ON public.cart_items;
CREATE POLICY "Users can view own cart items"
  ON public.cart_items
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own cart items" ON public.cart_items;
CREATE POLICY "Users can manage own cart items"
  ON public.cart_items
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Quantities must be positive; zero means "remove" and the API deletes the row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_quantity_positive') THEN
    DELETE FROM public.cart_items WHERE quantity IS NULL OR quantity <= 0;
    ALTER TABLE public.cart_items
      ADD CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;
