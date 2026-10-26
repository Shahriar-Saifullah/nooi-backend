/**
 * Vendor earnings in the database — services/payments/earnings.service.ts
 * The maths is in ledger.ts; the state changes are SQL functions in
 * migrations/20261024_payments_ledger_payouts.sql. This file joins them up.
 */

import { supabase } from '../supabase';
import { payoutHoldDays } from './index';

/**
 * Write the earnings for an order. Idempotent (one row per order item and per
 * shipment, keyed by entry_key), so a retried webhook cannot double-credit a
 * vendor. The maths lives in SQL (record_order_earnings) so the checkout path
 * and the backfill can never disagree; ledger.ts mirrors it for unit tests.
 */
export async function recordOrderEarnings(orderId: string, _snapshot?: unknown, _currency?: string) {
  const { data, error } = await supabase.rpc('record_order_earnings', { p_order_id: orderId });
  if (error) throw new Error(error.message);
  return Number(data || 0);
}

/** pending → payable wherever the rules now allow it. Never throws. */
export async function releaseEarnings(orderId?: string) {
  const { data, error } = await supabase.rpc('release_vendor_earnings', {
    p_order_id: orderId ?? null,
    p_hold_days: await payoutHoldDays(),
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
