-- Phase 03 Additive Migration: Payment Extensions, Notifications, Idempotency & Stock Concurrency

-- 1. Extend Orders Table with Payment Gateway & Idempotency Metadata
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'payment_method'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN payment_method TEXT DEFAULT 'stripe';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'payment_status'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN payment_status TEXT DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'stripe_client_secret'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN stripe_client_secret TEXT;
  END IF;
END $$;

-- Enforce Unique Payment Intent ID for Idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_intent_id_key'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_payment_intent_id_key UNIQUE (payment_intent_id);
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_intent_id ON public.orders(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders(payment_status);

-- 2. Create Notifications Table
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'order_status', -- 'order_status', 'shipment', 'return', 'vendor_approval'
  link_url TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

-- Enable RLS for Notifications
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own notifications" ON public.notifications;
CREATE POLICY "Users can view own notifications"
  ON public.notifications
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own notifications" ON public.notifications;
CREATE POLICY "Users can update own notifications"
  ON public.notifications
  FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on notifications" ON public.notifications;
CREATE POLICY "Service role full access on notifications"
  ON public.notifications
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- 3. Unique Constraints & Indexes on Cart Items to prevent duplicate rows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cart_items_user_variant_key'
  ) THEN
    ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_user_variant_key UNIQUE (user_id, variant_id);
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON public.cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_session_id ON public.cart_items(session_id);

-- Enable RLS on Cart Items
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cart items" ON public.cart_items;
CREATE POLICY "Users can view own cart items"
  ON public.cart_items
  FOR SELECT
  USING (auth.uid() = user_id OR session_id IS NOT NULL);

DROP POLICY IF EXISTS "Users can manage own cart items" ON public.cart_items;
CREATE POLICY "Users can manage own cart items"
  ON public.cart_items
  FOR ALL
  USING (auth.uid() = user_id OR session_id IS NOT NULL);

DROP POLICY IF EXISTS "Service role full access on cart_items" ON public.cart_items;
CREATE POLICY "Service role full access on cart_items"
  ON public.cart_items
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');

-- 4. Atomic Inventory Reservation Stored Function
CREATE OR REPLACE FUNCTION reserve_product_stock(
  p_variant_id UUID,
  p_quantity INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.product_variants
  SET stock_quantity = stock_quantity - p_quantity
  WHERE id = p_variant_id
    AND stock_quantity >= p_quantity
    AND is_active = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RLS Policies for Orders, Order Items, Shipments & Returns
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_returns ENABLE ROW LEVEL SECURITY;

-- Customer policies
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
CREATE POLICY "Users can view own orders"
  ON public.orders FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own order items" ON public.order_items;
CREATE POLICY "Users can view own order items"
  ON public.order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id AND o.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can view own shipments" ON public.order_shipments;
CREATE POLICY "Users can view own shipments"
  ON public.order_shipments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_shipments.order_id AND o.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can view own returns" ON public.order_returns;
CREATE POLICY "Users can view own returns"
  ON public.order_returns FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own returns" ON public.order_returns;
CREATE POLICY "Users can create own returns"
  ON public.order_returns FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service role policies
DROP POLICY IF EXISTS "Service role full access on orders" ON public.orders;
CREATE POLICY "Service role full access on orders" ON public.orders FOR ALL USING (auth.jwt()->>'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access on order_items" ON public.order_items;
CREATE POLICY "Service role full access on order_items" ON public.order_items FOR ALL USING (auth.jwt()->>'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access on order_shipments" ON public.order_shipments;
CREATE POLICY "Service role full access on order_shipments" ON public.order_shipments FOR ALL USING (auth.jwt()->>'role' = 'service_role');

DROP POLICY IF EXISTS "Service role full access on order_returns" ON public.order_returns;
CREATE POLICY "Service role full access on order_returns" ON public.order_returns FOR ALL USING (auth.jwt()->>'role' = 'service_role');
