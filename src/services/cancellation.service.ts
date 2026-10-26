/**
 * Cancelling orders — services/cancellation.service.ts
 * ============================================================================
 * Two shapes:
 *
 *   Whole order   (admin "Cancel order", or a customer's request approved)
 *     claim_order_cancellation → refund what is left → settle_order_cancellation
 *     → vendors' earnings on the order reversed.
 *
 *   One shipment  (a vendor can't fulfil their part of a multi-vendor order)
 *     refund that vendor's items + their shipping + the VAT on both, less
 *     their share of any promo discount → settle_shipment_cancellation
 *     → that vendor's earnings reversed. If nothing is left on the order it
 *     becomes cancelled.
 *
 * Refunds go back through the gateway the order was paid with, with an
 * idempotency key, so a retried approval cannot pay twice.
 */

import { supabase } from './supabase';
import { refundOrderPayment } from './payments';
import { reverseEarnings } from './payments/earnings.service';

export type CancelResult =
  | { ok: true; amount: number; refundId: string | null; finalStatus: string }
  | { ok: false; status: number; error: string; data?: any };

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function cancelWholeOrder(args: {
  orderId: string; adminId: string; note: string; key?: string;
}): Promise<CancelResult> {
  const { orderId, adminId, note } = args;
  const { data: order } = await supabase.from('orders')
    .select('id, order_number, payment_intent_id, payment_provider, currency, user_id, status')
    .eq('id', orderId).maybeSingle();
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const { data: claimData, error: claimError } = await supabase.rpc('claim_order_cancellation', {
    p_order_id: orderId, p_admin_id: adminId,
  });
  if (claimError) return { ok: false, status: 400, error: claimError.message };
  const claim: any = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!claim?.claimed) {
    const current = claim?.current_status ?? null;
    if (current === 'cancelled' || current === 'cancelling' || current === 'refunded') {
      return { ok: false, status: 409, error: 'already_handled', data: { current_status: current } };
    }
    return { ok: false, status: 409, error: `An order with status "${current}" cannot be cancelled.`, data: { current_status: current } };
  }

  const amount = Number(claim.refundable ?? 0);
  let refundId: string | null = null;
  if (amount > 0 && order.payment_intent_id) {
    try {
      const refund = await refundOrderPayment({
        provider: order.payment_provider,
        paymentId: order.payment_intent_id,
        amountMinor: Math.round(amount * 100),
        key: args.key ?? `order-cancel-${orderId}`,
        metadata: { order_id: orderId, order_number: order.order_number ?? '', reason: note.slice(0, 200) },
      });
      refundId = refund.id;
    } catch (err: any) {
      await supabase.rpc('settle_order_cancellation', {
        p_order_id: orderId, p_succeeded: false, p_refund_id: null,
        p_note: `Cancellation failed at refund: ${err?.message ?? 'unknown'}`,
      });
      return { ok: false, status: 502, error: err?.message || 'The payment provider rejected the refund.' };
    }
  }

  const { data: settled, error: settleError } = await supabase.rpc('settle_order_cancellation', {
    p_order_id: orderId, p_succeeded: true, p_refund_id: refundId, p_note: note,
  });
  if (settleError) {
    console.error('[cancel] refunded but settle failed', { order_id: orderId, refund_id: refundId, error: settleError.message });
    return {
      ok: false, status: 500,
      error: refundId
        ? `The refund went through (${refundId}) but the order could not be updated. Do not cancel again — fix the record instead.`
        : 'The order could not be cancelled.',
    };
  }
  await reverseEarnings(orderId, null, `Order cancelled: ${note}`);
  const row: any = Array.isArray(settled) ? settled[0] : settled;
  return { ok: true, amount, refundId, finalStatus: row?.final_status ?? 'cancelled' };
}

/** What a vendor's part of an order cost the customer, from the checkout snapshot. */
export async function shipmentRefundAmount(shipmentId: string): Promise<{ amount: number; orderId: string; retailerId: string } | null> {
  const { data: s } = await supabase.from('order_shipments')
    .select('id, order_id, retailer_id').eq('id', shipmentId).maybeSingle();
  if (!s) return null;
  const { data: order } = await supabase.from('orders')
    .select('id, subtotal, discount_amount, payment_intent_id').eq('id', s.order_id).maybeSingle();
  const { data: items } = await supabase.from('order_items')
    .select('total_price, item_status').eq('order_id', s.order_id).eq('retailer_id', s.retailer_id);
  const { data: attempt } = await supabase.from('checkout_attempts')
    .select('snapshot_json').eq('payment_intent_id', order?.payment_intent_id ?? '').maybeSingle();
  const group = (attempt?.snapshot_json?.retailers || []).find((g: any) => g.retailer_id === s.retailer_id);

  const live = (items || []).filter((i: any) => !['returned', 'cancelled'].includes(i.item_status));
  const goods = live.reduce((a: number, i: any) => a + Number(i.total_price || 0), 0);
  const allGoods = (items || []).reduce((a: number, i: any) => a + Number(i.total_price || 0), 0);
  const shipping = Number(group?.shipping?.shipping_amount || 0);
  // VAT on this group, scaled down if some of its items were already returned.
  const tax = Number(group?.tax?.tax_amount || 0) * (allGoods > 0 ? goods / allGoods : 0);
  const subtotal = Number(order?.subtotal || 0);
  const discount = subtotal > 0 ? Number(order?.discount_amount || 0) * (goods / subtotal) : 0;
  return { amount: Math.max(0, round2(goods + shipping + tax - discount)), orderId: s.order_id, retailerId: s.retailer_id };
}

export async function cancelShipment(args: {
  shipmentId: string; note: string; key: string;
}): Promise<CancelResult> {
  const calc = await shipmentRefundAmount(args.shipmentId);
  if (!calc) return { ok: false, status: 404, error: 'Shipment not found' };
  const { data: ship } = await supabase.from('order_shipments')
    .select('shipment_status').eq('id', args.shipmentId).maybeSingle();
  if (ship?.shipment_status === 'cancelled') return { ok: false, status: 409, error: 'already_handled' };
  if (ship?.shipment_status === 'delivered') {
    return { ok: false, status: 409, error: 'This part of the order was delivered — use a return instead.' };
  }
  const { data: order } = await supabase.from('orders')
    .select('id, order_number, payment_intent_id, payment_provider').eq('id', calc.orderId).maybeSingle();

  let refundId: string | null = null;
  if (calc.amount > 0 && order?.payment_intent_id) {
    try {
      const refund = await refundOrderPayment({
        provider: order.payment_provider,
        paymentId: order.payment_intent_id,
        amountMinor: Math.round(calc.amount * 100),
        key: args.key,
        metadata: { order_id: calc.orderId, shipment_id: args.shipmentId, reason: args.note.slice(0, 200) },
      });
      refundId = refund.id;
    } catch (err: any) {
      return { ok: false, status: 502, error: err?.message || 'The payment provider rejected the refund.' };
    }
  }

  const { error: revErr } = await supabase.rpc('reverse_shipment_earnings', {
    p_shipment_id: args.shipmentId, p_note: `Cancelled: ${args.note}`.slice(0, 300),
  });
  if (revErr) console.error('[cancel] REVERSAL FAILED — vendor may be overpaid', { shipment_id: args.shipmentId, error: revErr.message });

  const { data: final, error: settleErr } = await supabase.rpc('settle_shipment_cancellation', { p_shipment_id: args.shipmentId });
  if (settleErr) {
    return {
      ok: false, status: 500,
      error: refundId
        ? `The refund went through (${refundId}) but the shipment could not be updated. Do not approve again — fix the record instead.`
        : settleErr.message,
    };
  }
  return { ok: true, amount: calc.amount, refundId, finalStatus: String(final) };
}
