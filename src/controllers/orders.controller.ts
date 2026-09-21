import { Request, Response } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import { supabase } from '../services/supabase';
import { stripe } from '../services/stripe';
import { calculateCheckout, CheckoutError } from '../services/checkout.service';
import { createPaymentIntentSchema } from '../schemas/checkout.schema';
import { AuthRequest } from '../types';

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

    // 1. Calculate snapshot from live server-side database cart
    const summary = await calculateCheckout(userId, shipping_address);

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

  if (attempt.status === 'completed') {
    return;
  }

  // 1. Currency Check
  if (pi.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
    console.error(`Currency mismatch for PI ${pi.id}: expected ${attempt.currency}, got ${pi.currency}`);
    const refund = await stripe.refunds.create({
      payment_intent: pi.id,
      metadata: {
        reason: 'currency_mismatch',
        expected_currency: attempt.currency,
        received_currency: pi.currency,
      },
    });
    await supabase
      .from('checkout_attempts')
      .update({
        status: 'failed',
        snapshot_json: {
          ...attempt.snapshot_json,
          failure_reason: 'currency_mismatch',
          refund_id: refund.id,
        },
      })
      .eq('id', attempt.id);
    return;
  }

  // 2. Amount Validation against Snapshot
  if (pi.amount !== Number(attempt.grand_total_cents)) {
    console.error(`Amount mismatch for PI ${pi.id}: expected ${attempt.grand_total_cents}, got ${pi.amount}`);
    const refund = await stripe.refunds.create({
      payment_intent: pi.id,
      metadata: {
        reason: 'price_mismatch',
        expected_amount: String(attempt.grand_total_cents),
        received_amount: String(pi.amount),
      },
    });
    await supabase
      .from('checkout_attempts')
      .update({
        status: 'failed',
        snapshot_json: {
          ...attempt.snapshot_json,
          failure_reason: 'price_mismatch',
          refund_id: refund.id,
        },
      })
      .eq('id', attempt.id);
    return;
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
        const refund = await stripe.refunds.create({
          payment_intent: pi.id,
          metadata: {
            reason: 'price_mismatch',
            note: 'Underlying product variant price changed prior to fulfillment',
          },
        });
        await supabase
          .from('checkout_attempts')
          .update({
            status: 'failed',
            snapshot_json: {
              ...snapshot,
              failure_reason: 'price_mismatch',
              refund_id: refund.id,
            },
          })
          .eq('id', attempt.id);
        return;
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
    p_payment_intent_id: pi.id,
  });

  if (rpcError) {
    if (rpcError.message && rpcError.message.includes('STOCK_INSUFFICIENT')) {
      console.warn(`Stock insufficient during order creation for attempt ${attempt.id}. Issuing refund.`);
      const refund = await stripe.refunds.create({
        payment_intent: pi.id,
        metadata: { reason: 'stock_insufficient' },
      });

      await supabase
        .from('checkout_attempts')
        .update({
          status: 'stock_failed',
          snapshot_json: {
            ...snapshot,
            failure_reason: 'stock_insufficient',
            refund_id: refund.id,
          },
        })
        .eq('id', attempt.id);

      await supabase.from('notifications').insert({
        user_id: attempt.user_id,
        title: 'Order Fulfillment Notice',
        message: 'Your order could not be fulfilled due to insufficient stock. A full refund has been issued.',
        type: 'order_status',
      });

      return;
    }

    // For other unexpected database errors, throw so webhook fails and Stripe retries
    throw rpcError;
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
      .select('*, order_items(*), order_shipments(*)')
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
      .select('*, order_items(*), order_shipments(*)')
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
      .select('*, order_items(*), order_shipments(*, order_tracking_events(*))')
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

export const submitReturnRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, photo_urls = [], order_item_id } = req.body;
    const userId = (req as AuthRequest).user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const returnRecord = {
      order_id: id,
      order_item_id,
      user_id: userId,
      reason,
      photo_urls,
      status: 'requested',
    };

    const { data, error } = await supabase
      .from('order_returns')
      .insert(returnRecord)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    return res.json({ success: true, return_request: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
