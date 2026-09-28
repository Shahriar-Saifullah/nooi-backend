/**
 * Promotion service
 * ============================================================================
 * New file: nooi-backend/src/services/promotion.service.ts
 *
 * One place where a code becomes a discount, used by BOTH the cart quote and
 * checkout.service.ts. If the cart computed its own discount, a shopper could
 * be shown −$248 and charged full price — which is the worst possible bug in a
 * shopping flow, because it only surfaces on the bank statement.
 *
 * Nothing here trusts the client. It takes a code string and a subtotal the
 * server calculated, and returns an amount. The code is never echoed back as
 * proof of anything, and an invalid code returns a reason rather than throwing,
 * so the cart can explain itself.
 */

import { supabase } from './supabase';

export interface Promotion {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  max_discount: number | null;
  min_subtotal: number;
  per_user_limit: number;
  usage_limit: number | null;
  usage_count: number;
}

export type PromotionFailure =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'below_minimum'
  | 'usage_limit_reached'
  | 'already_used';

export interface PromotionResult {
  valid: boolean;
  promotion?: Promotion;
  /** Never negative, never more than the subtotal. */
  discount_amount: number;
  reason?: PromotionFailure;
  message?: string;
}

const MESSAGES: Record<PromotionFailure, string> = {
  not_found: 'That code is not recognised.',
  inactive: 'That code is no longer available.',
  not_started: 'That code is not active yet.',
  expired: 'That code has expired.',
  below_minimum: 'Your order does not meet the minimum for this code.',
  usage_limit_reached: 'That code has reached its limit.',
  already_used: 'You have already used that code.',
};

function fail(reason: PromotionFailure): PromotionResult {
  return { valid: false, discount_amount: 0, reason, message: MESSAGES[reason] };
}

/**
 * Validate a code against a server-calculated subtotal.
 *
 * `userId` is optional so the cart can preview a discount before sign-in, but
 * the per-user limit can only be enforced once we know who is asking — which is
 * why checkout, where it matters, always passes it.
 */
export async function validatePromotion(
  code: string,
  subtotal: number,
  userId?: string | null,
): Promise<PromotionResult> {
  const trimmed = (code ?? '').trim();
  if (!trimmed) return fail('not_found');

  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .ilike('code', trimmed)
    .maybeSingle();

  if (error) {
    console.error('[promotion] lookup failed:', error);
    return fail('not_found');
  }
  if (!data) return fail('not_found');

  const promo = data as Promotion & {
    active: boolean;
    starts_at: string | null;
    ends_at: string | null;
  };

  if (!promo.active) return fail('inactive');

  const now = Date.now();
  if (promo.starts_at && new Date(promo.starts_at).getTime() > now) return fail('not_started');
  if (promo.ends_at && new Date(promo.ends_at).getTime() < now) return fail('expired');

  if (subtotal < Number(promo.min_subtotal)) return fail('below_minimum');

  if (promo.usage_limit != null && promo.usage_count >= promo.usage_limit) {
    return fail('usage_limit_reached');
  }

  if (userId && promo.per_user_limit > 0) {
    const { count } = await supabase
      .from('promotion_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('promotion_id', promo.id)
      .eq('user_id', userId);

    if ((count ?? 0) >= promo.per_user_limit) return fail('already_used');
  }

  let discount =
    promo.discount_type === 'percent'
      ? (subtotal * Number(promo.discount_value)) / 100
      : Number(promo.discount_value);

  // An uncapped percent code on a 6,100 sectional is a 610 giveaway. Respect
  // the ceiling, and never discount past the subtotal into a negative order.
  if (promo.max_discount != null) discount = Math.min(discount, Number(promo.max_discount));
  discount = Math.min(discount, subtotal);
  discount = Math.max(0, Number(discount.toFixed(2)));

  return { valid: true, promotion: promo, discount_amount: discount };
}

/**
 * Record a redemption atomically. Call this only after payment succeeds —
 * counting a code as used when a PaymentIntent later fails burns the shopper's
 * one allowed use on an order they never received.
 *
 * Returns false if the code ran out between quote and capture, which the caller
 * should treat as "charge full price", not as a hard failure.
 */
export async function consumePromotion(
  promotionId: string,
  userId: string | null,
  orderId: string,
  amount: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('consume_promotion', {
    p_promotion_id: promotionId,
    p_user_id: userId,
    p_order_id: orderId,
    p_amount: amount,
  });

  if (error) {
    console.error('[promotion] consume failed:', error);
    return false;
  }
  return Boolean(data);
}
