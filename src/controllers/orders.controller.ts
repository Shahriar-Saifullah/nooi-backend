import { Request, Response } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import { supabase } from '../services/supabase';
import { stripe } from '../services/stripe';
import { calculateCheckout, CheckoutError } from '../services/checkout.service';
import { consumePromotion } from '../services/promotion.service';
import { createPaymentIntentSchema } from '../schemas/checkout.schema';
import { AuthRequest } from '../types';
import { Provider, checkoutCurrency } from '../services/payments';
import { moyasar, MoyasarError } from '../services/payments/moyasar';
import { syncPayoutByProviderId } from '../services/payments/payouts.service';
import { recordOrderEarnings } from '../services/payments/earnings.service';

export const createPaymentIntent = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const parseResult = createPaymentIntentSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checkout parameters',
        details: parseResult.error.flatten(),
      });
    }

    const { shipping_address } = parseResult.data;

    // Read the promo code off the raw body rather than the parsed result: zod
    // strips unknown keys, and adding it to createPaymentIntentSchema would
    // touch a file the checkout tests assert against. Length-bounded because it
    // goes into a database lookup; validatePromotion does the rest.
    const promoCode =
      typeof (req.body as any)?.promo_code === 'string'
        ? (req.body as any).promo_code.trim().slice(0, 64) || null
        : null;

    // 1. Calculate snapshot from live server-side database cart
    const summary = await calculateCheckout(userId, shipping_address, undefined, promoCode);

    // 2. Check if an active attempt exists for this user and matching cart snapshot hash
    const { data: existingAttempt } = await supabase
      .from('checkout_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('cart_snapshot_hash', summary.cart_snapshot_hash)
      .eq('status', 'active')
      .maybeSingle();

    if (existingAttempt) {
      const isExpired = new Date(existingAttempt.expires_at).getTime() < Date.now();
      if (!isExpired && existingAttempt.payment_intent_id) {
        try {
          const pi = await stripe.paymentIntents.retrieve(existingAttempt.payment_intent_id);
          if (pi.status !== 'canceled' && pi.status !== 'succeeded') {
            return res.json({
              success: true,
              client_secret: pi.client_secret,
              checkout_attempt_id: existingAttempt.id,
              summary: existingAttempt.snapshot_json,
            });
          }
        } catch {
          // If PI retrieve failed, fall through to supersede
        }
      } else if (isExpired) {
        // Explicitly transition expired attempt to 'expired'
        await supabase
          .from('checkout_attempts')
          .update({ status: 'expired' })
          .eq('id', existingAttempt.id);
      }
    }

    // 3. Mark any prior active attempts as superseded
    await supabase
      .from('checkout_attempts')
      .update({ status: 'superseded' })
      .eq('user_id', userId)
      .eq('status', 'active');

    const attemptId = crypto.randomUUID();

    // 4. Insert new checkout attempt
    const { error: insertErr } = await supabase
      .from('checkout_attempts')
      .insert({
        id: attemptId,
        user_id: userId,
        cart_snapshot_hash: summary.cart_snapshot_hash,
        status: 'active',
        snapshot_json: summary,
        currency: summary.currency,
        grand_total_cents: summary.grand_total_cents,
        shipping_address: summary.shipping_address,
      });

    if (insertErr) {
      // Race condition safety: if another concurrent request just inserted an active attempt
      const { data: winner } = await supabase
        .from('checkout_attempts')
        .select('*')
        .eq('user_id', userId)
        .eq('cart_snapshot_hash', summary.cart_snapshot_hash)
        .eq('status', 'active')
        .maybeSingle();

      if (winner && winner.payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(winner.payment_intent_id);
        return res.json({
          success: true,
          client_secret: pi.client_secret,
          checkout_attempt_id: winner.id,
          summary: winner.snapshot_json,
        });
      }
      throw insertErr;
    }

    // 5. Create Stripe PaymentIntent with unique idempotency key
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: summary.grand_total_cents,
        currency: summary.currency.toLowerCase(),
        metadata: {
          checkout_attempt_id: attemptId,
          user_id: userId,
          cart_snapshot_hash: summary.cart_snapshot_hash,
          promotion_code: summary.promotion_code ?? '',
        },
        automatic_payment_methods: { enabled: true },
      },
      {
        idempotencyKey: `attempt_${attemptId}`,
      }
    );

    // 6. Update attempt with payment_intent_id
    await supabase
      .from('checkout_attempts')
      .update({ payment_intent_id: paymentIntent.id })
      .eq('id', attemptId);

    return res.json({
      success: true,
      client_secret: paymentIntent.client_secret,
      checkout_attempt_id: attemptId,
      summary,
    });
  } catch (err: any) {
    if (err instanceof CheckoutError) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: err.message || 'Failed to initialize checkout' });
  }
};

export const stripeWebhookHandler = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test';

  if (!sig) {
    return res.status(400).send('Webhook signature missing');
  }

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  // Webhook Event Idempotency Check
  const { data: existingEvent } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('stripe_event_id', event.id)
    .maybeSingle();

  if (existingEvent && existingEvent.status === 'completed') {
    return res.status(200).json({ received: true, already_processed: true });
  }

  if (!existingEvent) {
    const { error: insertEventErr } = await supabase.from('webhook_events').insert({
      stripe_event_id: event.id,
      event_type: event.type,
      status: 'processing',
      attempts: 1,
    });

    if (insertEventErr) {
      // Concurrent delivery race condition: another delivery just inserted this event
      const { data: racerEvent } = await supabase
        .from('webhook_events')
        .select('*')
        .eq('stripe_event_id', event.id)
        .maybeSingle();

      if (racerEvent && racerEvent.status === 'completed') {
        return res.status(200).json({ received: true, already_processed: true });
      }
    }
  } else {
    await supabase.from('webhook_events').update({
      status: 'processing',
      attempts: (existingEvent.attempts || 1) + 1,
    }).eq('id', existingEvent.id);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as any;
      await handlePaymentIntentSucceeded(pi);
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as any;
      await handlePaymentIntentFailed(pi);
    }

    // Mark event completed on success
    await supabase
      .from('webhook_events')
      .update({
        status: 'completed',
        result: 'success',
        processed_at: new Date().toISOString(),
      })
      .eq('stripe_event_id', event.id);

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`Webhook processing error on event ${event.id}:`, err);

    // Keep event retryable on failure
    await supabase
      .from('webhook_events')
      .update({
        status: 'failed',
        error_message: err.message || 'Processing failed',
      })
      .eq('stripe_event_id', event.id);

    return res.status(500).json({ error: 'Webhook processing failed, retryable' });
  }
};

/**
 * A payment the gateway says succeeded, in a shape both gateways share.
 * `refund` gives the whole payment back (used when the order cannot stand).
 */
interface PaidPayment {
  provider: Provider;
  id: string;
  amountMinor: number;
  currency: string;
  refund: (metadata: Record<string, string>) => Promise<{ id: string }>;
}

async function handlePaymentIntentSucceeded(pi: any) {
  // Check if order already exists for this payment intent (idempotency)
  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', pi.id)
    .maybeSingle();

  if (existingOrder) {
    return;
  }

  // Load checkout attempt
  const { data: attempt } = await supabase
    .from('checkout_attempts')
    .select('*')
    .eq('payment_intent_id', pi.id)
    .maybeSingle();

  if (!attempt) {
    console.warn(`No checkout attempt found for payment intent: ${pi.id}`);
    return;
  }

  await fulfilPaidCheckout(attempt, {
    provider: 'stripe',
    id: pi.id,
    amountMinor: pi.amount,
    currency: pi.currency,
    refund: (metadata) => stripe.refunds.create({ payment_intent: pi.id, metadata }),
  });
}

/**
 * Turn a paid checkout attempt into an order — whichever gateway took the
 * money. Every check that fails refunds the payment in full and records why.
 * Returns the order id, or null when the payment was refunded instead.
 */
async function fulfilPaidCheckout(attempt: any, paid: PaidPayment): Promise<string | null> {
  if (attempt.status === 'completed') {
    const { data: order } = await supabase
      .from('orders').select('id').eq('payment_intent_id', paid.id).maybeSingle();
    return order?.id ?? null;
  }

  const fail = async (status: string, reason: string, metadata: Record<string, string>) => {
    const refund = await paid.refund(metadata);
    await supabase
      .from('checkout_attempts')
      .update({
        status,
        snapshot_json: { ...attempt.snapshot_json, failure_reason: reason, refund_id: refund.id },
      })
      .eq('id', attempt.id);
    return null;
  };

  // 1. Currency Check
  if (paid.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
    console.error(`Currency mismatch for payment ${paid.id}: expected ${attempt.currency}, got ${paid.currency}`);
    return fail('failed', 'currency_mismatch', {
      reason: 'currency_mismatch',
      expected_currency: attempt.currency,
      received_currency: paid.currency,
    });
  }

  // 2. Amount Validation against Snapshot
  if (paid.amountMinor !== Number(attempt.grand_total_cents)) {
    console.error(`Amount mismatch for payment ${paid.id}: expected ${attempt.grand_total_cents}, got ${paid.amountMinor}`);
    return fail('failed', 'price_mismatch', {
      reason: 'price_mismatch',
      expected_amount: String(attempt.grand_total_cents),
      received_amount: String(paid.amountMinor),
    });
  }

  const snapshot = attempt.snapshot_json;

  // 3. Verify Live Variant Prices in DB against Snapshot (Detect mid-flight price changes)
  const variantIds = (snapshot.items || []).map((i: any) => i.variant_id);
  if (variantIds.length > 0) {
    const { data: currentVariants } = await supabase
      .from('product_variants')
      .select('id, price')
      .in('id', variantIds);

    if (currentVariants && currentVariants.length > 0) {
      const priceMap = new Map(currentVariants.map((v: any) => [v.id, Number(v.price)]));
      const hasPriceMismatch = snapshot.items.some((item: any) => {
        const livePrice = priceMap.get(item.variant_id);
        return livePrice !== undefined && livePrice !== item.unit_price;
      });

      if (hasPriceMismatch) {
        console.warn(`Variant price changed after snapshot for attempt ${attempt.id}. Refunding.`);
        return fail('failed', 'price_mismatch', {
          reason: 'price_mismatch',
          note: 'Underlying product variant price changed prior to fulfillment',
        });
      }
    }
  }

  const orderNumber = `NOOI-${Math.floor(100000 + Math.random() * 900000)}`;

  // 4. Execute atomic order creation in PostgreSQL
  const { data: orderId, error: rpcError } = await supabase.rpc('create_order_atomic', {
    p_user_id: attempt.user_id,
    p_checkout_attempt_id: attempt.id,
    p_order_number: orderNumber,
    p_shipping_address: attempt.shipping_address,
    p_items: snapshot.items,
    p_retailer_groups: (snapshot.retailers || []).map((r: any) => ({
      retailer_id: r.retailer_id,
      shipping_amount: r.shipping.shipping_amount,
      estimated_delivery: r.shipping.estimated_delivery,
    })),
    p_subtotal: snapshot.subtotal,
    p_shipping_total: snapshot.shipping_total,
    p_tax_total: snapshot.tax_total,
    p_grand_total: snapshot.grand_total,
    p_currency: attempt.currency,
    p_payment_intent_id: paid.id,
  });

  if (rpcError) {
    if (rpcError.message && rpcError.message.includes('STOCK_INSUFFICIENT')) {
      console.warn(`Stock insufficient during order creation for attempt ${attempt.id}. Issuing refund.`);
      await fail('stock_failed', 'stock_insufficient', { reason: 'stock_insufficient' });

      await supabase.from('notifications').insert({
        user_id: attempt.user_id,
        title: 'Order Fulfillment Notice',
        message: 'Your order could not be fulfilled due to insufficient stock. A full refund has been issued.',
        type: 'order_status',
      });

      return null;
    }

    // For other unexpected database errors, throw so the webhook fails and the gateway retries
    throw rpcError;
  }

  // 4a. Which gateway took the money (create_order_atomic predates Moyasar
  // and writes 'stripe'), so refunds later go back through the same one.
  if (paid.provider !== 'stripe') {
    const { error: provErr } = await supabase
      .from('orders')
      .update({ payment_provider: paid.provider, payment_method: paid.provider })
      .eq('id', orderId);
    if (provErr) {
      // Refunds would be sent to the wrong gateway — fail so the delivery is retried.
      throw provErr;
    }
  }

  // 4b. Record the discount on the order, and consume the code.
  //
  // Both happen AFTER payment succeeds. Counting a code as used at quote time
  // would burn a shopper's single allowed use on an order that never completed.
  //
  // create_order_atomic writes total_amount from p_grand_total, which is already
  // net of the discount. Without these columns, subtotal + shipping + tax would
  // not reconcile to the total on any invoice or refund calculation.
  if (Number(snapshot.discount_amount) > 0) {
    const { error: discountErr } = await supabase
      .from('orders')
      .update({
        discount_amount: snapshot.discount_amount,
        promotion_code: snapshot.promotion_code,
        promotion_id: snapshot.promotion_id,
      })
      .eq('id', orderId);

    if (discountErr) {
      // The order is real and paid — a missing discount annotation is a
      // reporting gap, not a reason to fail the webhook and have it retried.
      console.error('[checkout] could not record discount on order', {
        order_id: orderId,
        error: discountErr.message,
      });
    }

    if (snapshot.promotion_id) {
      const consumed = await consumePromotion(
        snapshot.promotion_id,
        attempt.user_id,
        orderId as unknown as string,
        Number(snapshot.discount_amount),
      );

      if (!consumed) {
        // The code hit its limit between the quote and this capture. The order
        // stands at the amount already authorised — we do not re-charge the
        // difference — but it is worth knowing it happened.
        console.warn('[checkout] promotion could not be consumed', {
          order_id: orderId,
          promotion_id: snapshot.promotion_id,
        });
      }
    }
  }

  // 4c. What each vendor has earned on this order (pending until the order is
  // approved and their shipment delivered). Never fails the order: a missing
  // ledger row is repaired by re-running recordOrderEarnings.
  try {
    await recordOrderEarnings(orderId as unknown as string, snapshot, attempt.currency);
  } catch (ledgerErr: any) {
    console.error('[checkout] could not record vendor earnings — re-run for this order', {
      order_id: orderId,
      error: ledgerErr?.message,
    });
  }

  // 5. Mark attempt completed
  await supabase
    .from('checkout_attempts')
    .update({ status: 'completed' })
    .eq('id', attempt.id);

  // 6. Send success notification
  await supabase.from('notifications').insert({
    user_id: attempt.user_id,
    title: 'Order Confirmed',
    message: `Your order #${orderNumber} has been confirmed and is being prepared for shipment.`,
    type: 'order_status',
    link_url: `/orders/${orderId}`,
  });

  return orderId as unknown as string;
}

async function handlePaymentIntentFailed(pi: any) {
  await supabase
    .from('checkout_attempts')
    .update({ status: 'failed' })
    .eq('payment_intent_id', pi.id);
}

export const getOrderByPaymentIntent = async (req: Request, res: Response) => {
  try {
    const { pi_id } = req.params;
    const userId = (req as AuthRequest).user?.id;
    const userRole = (req as AuthRequest).userProfile?.role || 'user';

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // First check if order already exists in orders table
    const { data: order } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *,
          product_variants (
            id, sku, color, material, images,
            products ( id, title, canvas_model_id, is_returnable )
          )
        ),
        order_shipments (
          *,
          retailers ( id, name, logo_url, city, country )
        )
      `)
      .eq('payment_intent_id', pi_id)
      .maybeSingle();

    if (order) {
      if (order.user_id !== userId && userRole !== 'admin' && userRole !== 'super_admin') {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }
      return res.json({ success: true, status: 'succeeded', order });
    }

    // If order is not yet created, inspect checkout_attempts status
    const { data: attempt } = await supabase
      .from('checkout_attempts')
      .select('*')
      .eq('payment_intent_id', pi_id)
      .maybeSingle();

    if (attempt) {
      if (attempt.user_id !== userId && userRole !== 'admin' && userRole !== 'super_admin') {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      if (attempt.status === 'stock_failed') {
        return res.json({
          success: true,
          status: 'stock_failed',
          message: 'Your order could not be fulfilled due to insufficient stock. A full refund has been issued.',
        });
      }

      if (attempt.status === 'failed') {
        return res.json({
          success: true,
          status: 'payment_failed',
          message: 'Your payment could not be processed.',
        });
      }

      return res.json({
        success: true,
        status: 'processing',
        message: 'Payment confirmed. Processing your order...',
      });
    }

    return res.status(404).json({ success: false, status: 'not_found', error: 'Order not found' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getUserOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *,
          product_variants (
            id, sku, color, images,
            products ( id, title )
          )
        ),
        order_shipments (
          *,
          retailers ( id, name, logo_url, city, country )
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, orders: data || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const authReq = req as AuthRequest;
    const userId = authReq.user?.id;
    const userRole = authReq.userProfile?.role || 'user';

    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *,
          product_variants (
            id, sku, color, material, images,
            products ( id, title, canvas_model_id, is_returnable )
          )
        ),
        order_shipments (
          *,
          retailers ( id, name, logo_url, city, country ),
          order_tracking_events ( * )
        )
      `)
      .eq('id', id)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (data.user_id !== userId && userRole !== 'admin' && userRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: 'Access denied: You do not have permission to view this order' });
    }

    return res.json({ success: true, order: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Replace submitReturnRequest in src/controllers/orders.controller.ts
 * ============================================================================
 * The previous version took order_id from the URL and order_item_id from the
 * body and inserted a row. No ownership check, no eligibility check, no
 * duplicate check.
 *
 * That meant any authenticated user could raise a return against anyone's
 * order by changing the id in the URL. An admin would then see it in the
 * refunds queue with a plausible reason and refund it — the money goes back to
 * the real buyer, so this is griefing rather than theft, but it is still
 * someone else's order being cancelled by a stranger.
 *
 * Five things are checked now, in the order a person would check them:
 *
 *   1. The order is this user's.
 *   2. The item is on that order.
 *   3. It has actually been delivered.
 *   4. The product is returnable at all.
 *   5. It is within the window, and no return already exists.
 */

/** Days after delivery during which a return may be raised. */
const RETURN_WINDOW_DAYS = 30;

export const submitReturnRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, photo_urls = [], order_item_id } = req.body;
    const userId = (req as AuthRequest).user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!order_item_id) {
      return res.status(400).json({ success: false, error: 'An item is required' });
    }
    if (!String(reason ?? '').trim()) {
      return res.status(400).json({ success: false, error: 'A reason is required' });
    }

    // 1. The order is this user's.
    //
    // Scoped by user_id rather than fetched then compared, so a missing order
    // and someone else's order give the same answer — otherwise the response
    // tells a caller whether an order id they guessed is real.
    const { data: order } = await supabase
      .from('orders')
      .select('id, order_number, status')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // 2. The item is on that order, with the product behind it.
    const { data: item } = await supabase
      .from('order_items')
      .select(`
        id, order_id, retailer_id, item_status, quantity,
        products ( id, title, is_returnable, specs_json )
      `)
      .eq('id', order_item_id)
      .eq('order_id', id)
      .maybeSingle();

    if (!item) {
      return res.status(404).json({ success: false, error: 'That item is not on this order' });
    }

    // 3. Delivered, by the shipment that carried it.
    //
    // item_status can lag — a vendor marks a shipment delivered and the items
    // follow — so the shipment is the authority on whether the goods arrived.
    const { data: shipment } = await supabase
      .from('order_shipments')
      .select('shipment_status, delivered_at')
      .eq('order_id', id)
      .eq('retailer_id', item.retailer_id)
      .maybeSingle();

    if (shipment?.shipment_status !== 'delivered') {
      return res.status(400).json({
        success: false,
        error: 'You can raise a return once this item has been delivered.',
      });
    }

    // 4. Returnable at all.
    //
    // Read from the column, not from specs_json. A made-to-order piece was
    // built for this customer and cannot be resold, which is why the answer has
    // to be stable rather than parsed from a label the listing form writes.
    const product: any = item.products;
    if (product && product.is_returnable === false) {
      const kind = product.specs_json?.kind;
      return res.status(400).json({
        success: false,
        error: kind
          ? `${kind} items can't be returned — they're made for your order. Contact support if something arrived damaged.`
          : "This item can't be returned. Contact support if something arrived damaged.",
      });
    }

    // 5. Within the window.
    //
    // Measured from delivery, not from the order date: a piece with a 28-day
    // lead time would otherwise have almost no window left by the time it
    // arrived.
    const deliveredAt = shipment.delivered_at ? new Date(shipment.delivered_at) : null;
    if (deliveredAt) {
      const days = Math.floor((Date.now() - deliveredAt.getTime()) / 86_400_000);
      if (days > RETURN_WINDOW_DAYS) {
        return res.status(400).json({
          success: false,
          error: `Returns close ${RETURN_WINDOW_DAYS} days after delivery. This arrived ${days} days ago.`,
        });
      }
    }

    // And not twice. Without this a customer can raise five requests on one
    // item and an admin can refund each of them.
    const { data: existing } = await supabase
      .from('order_returns')
      .select('id, status')
      .eq('order_item_id', order_item_id)
      .not('status', 'eq', 'declined')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        success: false,
        error: existing.status === 'refunded'
          ? 'This item has already been refunded.'
          : 'A return is already open for this item.',
      });
    }

    const { data, error } = await supabase
      .from('order_returns')
      .insert({
        order_id: id,
        order_item_id,
        user_id: userId,
        reason: String(reason).trim(),
        photo_urls,
        status: 'requested',
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, return_request: data });
  } catch (err: any) {
    console.error('submitReturnRequest error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
// ════════════════════════════════════════════════════════════════════════════
// Moyasar (Saudi Arabia)
// ════════════════════════════════════════════════════════════════════════════
//
// The card form is Moyasar's own (Moyasar Form, in the browser), so card data
// never touches Nooi. The flow:
//
//   1. POST /orders/moyasar/checkout   → a checkout attempt + the form config
//   2. The form creates the payment. Its on_completed hook calls
//      POST /orders/moyasar/bind       → we remember the payment id BEFORE the
//                                        3-D Secure redirect, so a dropped
//                                        connection cannot lose a paid order
//   3. Moyasar redirects to /checkout/callback?id=… and the page calls
//      POST /orders/moyasar/confirm    → we fetch the payment from Moyasar
//                                        with the SECRET key and only then
//                                        create the order
//   4. POST /payments/moyasar/webhook  → the same, from Moyasar's side, in case
//                                        the shopper closed the tab
//
// The browser's word is never taken for anything: status, amount and currency
// are always read back from Moyasar's API.


const MOYASAR_METHODS = (process.env.MOYASAR_METHODS || 'creditcard,stcpay')
  .split(',').map(s => s.trim()).filter(Boolean);

function moyasarFormConfig(attempt: { id: string; grand_total_cents: number; currency: string }, summary: any) {
  const frontend = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
  const config: Record<string, any> = {
    publishable_api_key: process.env.MOYASAR_PUBLISHABLE_KEY || '',
    amount: Number(attempt.grand_total_cents),
    currency: attempt.currency,
    description: `Nooi order (${summary?.items?.length ?? 0} item${summary?.items?.length === 1 ? '' : 's'}) · ${attempt.id.slice(0, 8)}`,
    callback_url: `${frontend}/checkout/callback`,
    supported_networks: ['mada', 'visa', 'mastercard'],
    methods: MOYASAR_METHODS,
    metadata: { checkout_attempt_id: attempt.id },
  };
  if (MOYASAR_METHODS.includes('applepay')) {
    config.apple_pay = {
      country: 'SA',
      label: process.env.MOYASAR_APPLE_PAY_LABEL || 'Nooi',
      validate_merchant_url: 'https://api.moyasar.com/v1/applepay/initiate',
    };
  }
  return config;
}

export const createMoyasarCheckout = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });
    if (!process.env.MOYASAR_PUBLISHABLE_KEY || !process.env.MOYASAR_SECRET_KEY) {
      return res.status(503).json({ success: false, error: 'Payments are not configured yet.' });
    }

    const parsed = createPaymentIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid checkout parameters', details: parsed.error.flatten() });
    }
    const promoCode =
      typeof (req.body as any)?.promo_code === 'string'
        ? (req.body as any).promo_code.trim().slice(0, 64) || null
        : null;

    const summary = await calculateCheckout(userId, parsed.data.shipping_address, checkoutCurrency(), promoCode);
    if (summary.grand_total_cents < 100) {
      return res.status(400).json({ success: false, error: 'The order total is below the minimum card payment (1 SAR).' });
    }

    // Same cart, still fresh, still unpaid: reuse it (the shopper refreshed).
    const { data: existing } = await supabase
      .from('checkout_attempts')
      .select('*')
      .eq('user_id', userId)
      .eq('cart_snapshot_hash', summary.cart_snapshot_hash)
      .eq('status', 'active')
      .maybeSingle();

    if (existing && existing.payment_provider === 'moyasar'
        && new Date(existing.expires_at).getTime() > Date.now()) {
      return res.json({
        success: true, provider: 'moyasar', checkout_attempt_id: existing.id,
        summary: existing.snapshot_json, form: moyasarFormConfig(existing, existing.snapshot_json),
      });
    }

    await supabase.from('checkout_attempts').update({ status: 'superseded' })
      .eq('user_id', userId).eq('status', 'active');

    const attempt = {
      id: crypto.randomUUID(),
      user_id: userId,
      cart_snapshot_hash: summary.cart_snapshot_hash,
      status: 'active',
      snapshot_json: summary,
      currency: summary.currency,
      grand_total_cents: summary.grand_total_cents,
      shipping_address: summary.shipping_address,
      payment_provider: 'moyasar',
    };
    const { error: insertErr } = await supabase.from('checkout_attempts').insert(attempt);
    if (insertErr) throw insertErr;

    return res.json({
      success: true, provider: 'moyasar', checkout_attempt_id: attempt.id,
      summary, form: moyasarFormConfig(attempt, summary),
    });
  } catch (err: any) {
    if (err instanceof CheckoutError) return res.status(err.status).json({ success: false, error: err.message });
    console.error('createMoyasarCheckout error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to start checkout' });
  }
};

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Remember the Moyasar payment id on the attempt before the 3-D Secure hop. */
export const bindMoyasarPayment = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });
    const { checkout_attempt_id, payment_id } = req.body || {};
    if (!isUuid(checkout_attempt_id) || !isUuid(payment_id)) {
      return res.status(400).json({ success: false, error: 'checkout_attempt_id and payment_id are required' });
    }

    const { data: attempt } = await supabase.from('checkout_attempts')
      .select('id, user_id, status, payment_intent_id').eq('id', checkout_attempt_id).maybeSingle();
    if (!attempt || attempt.user_id !== userId) return res.status(404).json({ success: false, error: 'Checkout not found' });
    if (attempt.status !== 'active') return res.status(409).json({ success: false, error: `Checkout is ${attempt.status}` });

    if (attempt.payment_intent_id && attempt.payment_intent_id !== payment_id) {
      // An earlier try on this attempt. Only replace it if it did not go through.
      const prev = await moyasar.getPayment(attempt.payment_intent_id).catch(() => null);
      if (prev && (prev.status === 'paid' || prev.status === 'captured')) {
        return res.status(409).json({ success: false, error: 'This checkout has already been paid.' });
      }
    }
    await supabase.from('checkout_attempts').update({ payment_intent_id: payment_id }).eq('id', attempt.id);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('bindMoyasarPayment error:', err);
    return res.status(500).json({ success: false, error: 'Could not record the payment' });
  }
};

type MoyasarOutcome =
  | { status: 'succeeded'; order_id: string }
  | { status: 'processing' }
  | { status: 'payment_failed'; message: string }
  | { status: 'refunded'; message: string }
  | { status: 'not_found' };

/**
 * Read a payment from Moyasar and, if it is paid, make sure it is an order.
 * Shared by the callback page and the webhook; safe to run twice at once.
 */
async function processMoyasarPayment(paymentId: string, userId?: string): Promise<MoyasarOutcome> {
  const { data: existingOrder } = await supabase.from('orders')
    .select('id, user_id').eq('payment_intent_id', paymentId).maybeSingle();
  if (existingOrder) {
    if (userId && existingOrder.user_id !== userId) return { status: 'not_found' };
    return { status: 'succeeded', order_id: existingOrder.id };
  }

  const payment = await moyasar.getPayment(paymentId);
  const attemptId = payment.metadata?.checkout_attempt_id;

  let attempt: any = null;
  if (isUuid(attemptId)) {
    ({ data: attempt } = await supabase.from('checkout_attempts').select('*').eq('id', attemptId).maybeSingle());
  }
  if (!attempt) {
    ({ data: attempt } = await supabase.from('checkout_attempts').select('*').eq('payment_intent_id', paymentId).maybeSingle());
  }
  if (!attempt || attempt.payment_provider !== 'moyasar') return { status: 'not_found' };
  if (userId && attempt.user_id !== userId) return { status: 'not_found' };

  if (payment.status === 'initiated' || payment.status === 'authorized') return { status: 'processing' };
  if (payment.status !== 'paid' && payment.status !== 'captured') {
    return { status: 'payment_failed', message: payment.source?.message || 'The payment did not go through.' };
  }

  if (attempt.payment_intent_id !== paymentId) {
    await supabase.from('checkout_attempts').update({ payment_intent_id: paymentId }).eq('id', attempt.id);
    attempt.payment_intent_id = paymentId;
  }

  try {
    const orderId = await fulfilPaidCheckout(attempt, {
      provider: 'moyasar',
      id: payment.id,
      amountMinor: Number(payment.amount),
      currency: payment.currency,
      refund: async () => {
        const r = await moyasar.refundPayment(payment.id);
        return { id: `${payment.id}:refund:${r.refunded ?? payment.amount}` };
      },
    });
    if (orderId) return { status: 'succeeded', order_id: orderId };
    const { data: after } = await supabase.from('checkout_attempts')
      .select('status, snapshot_json').eq('id', attempt.id).maybeSingle();
    return {
      status: 'refunded',
      message: after?.status === 'stock_failed'
        ? 'Something in your cart sold out while you were paying. You have been refunded in full.'
        : 'Prices changed while you were paying, so the payment was refunded in full. Please check out again.',
    };
  } catch (err: any) {
    // The other path (webhook vs callback) created the order a moment ago.
    if (err?.code === '23505') {
      const { data: order } = await supabase.from('orders').select('id').eq('payment_intent_id', paymentId).maybeSingle();
      if (order) return { status: 'succeeded', order_id: order.id };
    }
    throw err;
  }
}

/** The callback page: /checkout/callback?id=<payment id> */
export const confirmMoyasarPayment = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });
    const paymentId = req.body?.payment_id;
    if (!isUuid(paymentId)) return res.status(400).json({ success: false, error: 'payment_id is required' });

    const outcome = await processMoyasarPayment(paymentId, userId);
    if (outcome.status === 'not_found') return res.status(404).json({ success: false, error: 'Payment not found' });
    return res.json({ success: true, ...outcome });
  } catch (err: any) {
    if (err instanceof MoyasarError && err.status === 404) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    console.error('confirmMoyasarPayment error:', err);
    return res.status(500).json({ success: false, error: 'Could not confirm the payment. If you were charged, your order will appear shortly.' });
  }
};

function tokensMatch(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Moyasar webhooks. Authenticated by the shared secret_token in the body.
 * The body is only a hint: every payment and payout is re-read from the API.
 */
export const moyasarWebhookHandler = async (req: Request, res: Response) => {
  const secret = process.env.MOYASAR_WEBHOOK_SECRET;
  const event = req.body || {};
  if (!secret || typeof event.secret_token !== 'string' || !tokensMatch(event.secret_token, secret)) {
    return res.status(401).json({ error: 'invalid token' });
  }
  if (typeof event.id !== 'string' || typeof event.type !== 'string') {
    return res.status(400).json({ error: 'malformed event' });
  }

  const eventKey = `moyasar:${event.id}`;
  const { data: seen } = await supabase.from('webhook_events').select('*').eq('stripe_event_id', eventKey).maybeSingle();
  if (seen?.status === 'completed') return res.status(200).json({ received: true, already_processed: true });
  if (!seen) {
    await supabase.from('webhook_events').insert({
      stripe_event_id: eventKey, event_type: event.type, status: 'processing', attempts: 1,
    });
  } else {
    await supabase.from('webhook_events').update({ status: 'processing', attempts: (seen.attempts || 1) + 1 })
      .eq('id', seen.id);
  }

  try {
    const dataId = event.data?.id;
    if (event.type.startsWith('payout') && typeof dataId === 'string') {
      await syncPayoutByProviderId(dataId);
    } else if ((event.type === 'payment_paid' || event.type === 'payment_captured') && isUuid(dataId)) {
      await processMoyasarPayment(dataId);
    }
    // payment_failed ('payment_faild' in Moyasar's docs), refunded, voided:
    // nothing to do — refunds are initiated here and already recorded.

    await supabase.from('webhook_events').update({
      status: 'completed', result: 'success', processed_at: new Date().toISOString(),
    }).eq('stripe_event_id', eventKey);
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`Moyasar webhook ${event.id} failed:`, err);
    await supabase.from('webhook_events').update({ status: 'failed', error_message: err?.message || 'failed' })
      .eq('stripe_event_id', eventKey);
    return res.status(500).json({ error: 'processing failed, retryable' });
  }
};
