/**
 * Vendor earnings in the database — services/payments/earnings.service.ts
 * The maths is in ledger.ts; the state changes are SQL functions in
 * migrations/20261024_payments_ledger_payouts.sql. This file joins them up.
 */

import { supabase } from '../supabase';
import { buildEarnings } from './ledger';
import { payoutHoldDays } from './index';

/**
 * Write the earnings for a newly created order. Idempotent (unique per order
 * item / shipment), so a retried webhook cannot double-credit a vendor.
 */
export async function recordOrderEarnings(orderId: string, snapshot: any, currency: string) {
  const [{ data: items, error: e1 }, { data: shipments, error: e2 }] = await Promise.all([
    supabase.from('order_items').select('id, retailer_id, total_price').eq('order_id', orderId),
    supabase.from('order_shipments').select('id, retailer_id').eq('order_id', orderId),
  ]);
  if (e1 || e2) throw new Error((e1 || e2)!.message);

  const retailerIds = [...new Set((items || []).map((i: any) => i.retailer_id).filter(Boolean))];
  if (retailerIds.length === 0) return 0;
  const { data: retailers, error: e3 } = await supabase
    .from('retailers').select('id, vendor_id, commission_rate').in('id', retailerIds);
  if (e3) throw new Error(e3.message);

  const shippingByRetailer = new Map<string, number>(
    (snapshot?.retailers || []).map((r: any) => [r.retailer_id, Number(r.shipping?.shipping_amount || 0)]),
  );

  const rows = buildEarnings({
    orderId,
    currency,
    items: (items || []).map((i: any) => ({
      order_item_id: i.id, retailer_id: i.retailer_id, total_price: Number(i.total_price),
    })),
    shipments: (shipments || []).map((s: any) => ({
      shipment_id: s.id, retailer_id: s.retailer_id,
      shipping_amount: shippingByRetailer.get(s.retailer_id) ?? 0,
    })),
    retailers: (retailers || []) as any[],
  });
  if (rows.length === 0) return 0;

  // Two partial unique indexes (sale per item, shipping per shipment): insert
  // the kinds separately so each conflict target matches one index.
  for (const kind of ['sale', 'shipping'] as const) {
    const part = rows.filter(r => r.kind === kind);
    if (part.length === 0) continue;
    const { error } = await supabase.from('vendor_earnings').upsert(part, {
      onConflict: kind === 'sale' ? 'order_item_id' : 'shipment_id',
      ignoreDuplicates: true,
    });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

/** pending → payable wherever the rules now allow it. Never throws. */
export async function releaseEarnings(orderId?: string) {
  const { data, error } = await supabase.rpc('release_vendor_earnings', {
    p_order_id: orderId ?? null,
    p_hold_days: payoutHoldDays(),
  });
  if (error) console.error('[earnings] release failed', { order_id: orderId, error: error.message });
  return Number(data || 0);
}

/**
 * Money went back to the customer: take it back from the vendor. Logged, not
 * thrown — the refund has already happened and must still be reported as done.
 */
export async function reverseEarnings(orderId: string, orderItemId: string | null, note: string) {
  const { error } = await supabase.rpc('reverse_vendor_earnings', {
    p_order_id: orderId,
    p_order_item_id: orderItemId,
    p_note: note.slice(0, 300),
  });
  if (error) {
    console.error('[earnings] REVERSAL FAILED — vendor may be overpaid', {
      order_id: orderId, order_item_id: orderItemId, error: error.message,
    });
  }
}
