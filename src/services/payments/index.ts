/**
 * Which gateway, and refunds against either — services/payments/index.ts
 * ============================================================================
 * PAYMENT_PROVIDER=moyasar (Saudi Arabia: mada, Visa/Mastercard, Apple Pay,
 * STC Pay, settles in SAR to Nooi's Saudi bank account) or stripe (the old
 * path, kept so existing orders can still be refunded).
 *
 * Each order remembers the gateway it was paid through (orders.payment_provider),
 * and refunds go back through that one regardless of the current setting.
 */

import { stripe } from '../stripe';
import { moyasar, MoyasarError } from './moyasar';
import { getSettings } from '../settings.service';

export type Provider = 'stripe' | 'moyasar';

export function activeProvider(): Provider {
  return (process.env.PAYMENT_PROVIDER || '').toLowerCase() === 'moyasar' ? 'moyasar' : 'stripe';
}

/** The checkout currency. Moyasar settles SAR. */
export function checkoutCurrency(): string {
  if (process.env.CHECKOUT_CURRENCY) return process.env.CHECKOUT_CURRENCY.toUpperCase();
  return activeProvider() === 'moyasar' ? 'SAR' : 'USD';
}

/** Days after delivery before a vendor's earnings can be paid out (admin Settings). */
export async function payoutHoldDays(): Promise<number> {
  return (await getSettings()).payout_hold_days;
}

/** Format an amount for messages: "SAR 1,250.00". */
export function money(amount: number, currency = checkoutCurrency()): string {
  return `${currency} ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface RefundResult { id: string; }

/**
 * Refund `amountMinor` of an order's payment through the gateway it was paid
 * with. `key` makes a retry safe: Stripe dedupes by idempotency key; Moyasar
 * has no key, so on a timeout we read the payment back and check whether the
 * refund landed before reporting failure (a blind retry could refund twice).
 */
export async function refundOrderPayment(args: {
  provider: string | null | undefined;
  paymentId: string;
  amountMinor: number;
  key: string;
  metadata?: Record<string, string>;
}): Promise<RefundResult> {
  const provider = (args.provider || 'stripe') as Provider;

  if (provider === 'stripe') {
    const refund = await stripe.refunds.create(
      { payment_intent: args.paymentId, amount: args.amountMinor, metadata: args.metadata },
      { idempotencyKey: args.key },
    );
    return { id: refund.id };
  }

  const before = await moyasar.getPayment(args.paymentId);
  const already = Number(before.refunded || 0);
  if (already + args.amountMinor > Number(before.amount)) {
    throw new MoyasarError(
      `Refund would exceed the payment: ${already} of ${before.amount} already refunded.`, 422);
  }
  try {
    const r = await moyasar.refundPayment(args.paymentId, args.amountMinor);
    return { id: `${args.paymentId}:refund:${r.refunded ?? already + args.amountMinor}` };
  } catch (err) {
    if (err instanceof MoyasarError && err.status === 0) {
      const after = await moyasar.getPayment(args.paymentId).catch(() => null);
      if (after && Number(after.refunded || 0) >= already + args.amountMinor) {
        return { id: `${args.paymentId}:refund:${after.refunded}` };
      }
    }
    throw err;
  }
}
