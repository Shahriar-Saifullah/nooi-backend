import crypto from 'crypto';
import { supabase } from './supabase';
import { calculateShipping, ShippingCalculationResult } from './shipping.service';
import { calculateTax, TaxCalculationResult } from './tax.service';
import { validatePromotion } from './promotion.service';
import { ShippingAddressInput } from '../schemas/checkout.schema';

export interface CheckoutItemSnapshot {
  cart_item_id: string;
  variant_id: string;
  product_id: string;
  retailer_id: string;
  title: string;
  sku?: string;
  unit_price: number;
  quantity: number;
  total_price: number;
}

export interface RetailerGroupSnapshot {
  retailer_id: string;
  retailer_name: string;
  items: CheckoutItemSnapshot[];
  subtotal: number;
  shipping: ShippingCalculationResult;
  tax: TaxCalculationResult;
}

export interface CheckoutSummary {
  user_id: string;
  cart_snapshot_hash: string;
  retailers: RetailerGroupSnapshot[];
  items: CheckoutItemSnapshot[];
  subtotal: number;
  shipping_total: number;
  tax_total: number;
  /** Taken off the goods subtotal only, never off shipping or tax. */
  discount_amount: number;
  promotion_id: string | null;
  promotion_code: string | null;
  grand_total: number;
  grand_total_cents: number;
  currency: string;
  shipping_address: ShippingAddressInput;
}

export class CheckoutError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.status = status;
  }
}

export async function calculateCheckout(
  userId: string,
  shippingAddress: ShippingAddressInput,
  currency = process.env.CHECKOUT_CURRENCY || 'USD',
  /**
   * The promo CODE, never a discount amount. The amount is derived below from a
   * subtotal this function calculated itself — if the client could send a
   * figure, it could send any figure.
   */
  promoCode?: string | null
): Promise<CheckoutSummary> {
  const { data: cartItems, error } = await supabase
    .from('cart_items')
    .select('*, product_variants(*, products(*, retailers(*)))')
    .eq('user_id', userId);

  if (error) {
    throw new CheckoutError(`Failed to fetch cart: ${error.message}`, 500);
  }

  if (!cartItems || cartItems.length === 0) {
    throw new CheckoutError('Your cart is empty', 400);
  }

  const flatItems: CheckoutItemSnapshot[] = [];
  const retailerMap = new Map<string, {
    retailer: any;
    items: CheckoutItemSnapshot[];
    subtotal: number;
    /** A shipment is only as fast as its slowest piece. */
    lead_time_days: number;
  }>();

  for (const item of cartItems) {
    const variant = item.product_variants;
    if (!variant) {
      throw new CheckoutError(`Variant ${item.variant_id} not found`, 404);
    }

    if (variant.is_active === false) {
      throw new CheckoutError(`Product variant "${variant.sku || item.variant_id}" is no longer active`, 422);
    }

    if (variant.stock_quantity < item.quantity) {
      throw new CheckoutError(
        `Insufficient stock for "${variant.products?.title || variant.sku}". Available: ${variant.stock_quantity}, requested: ${item.quantity}`,
        422
      );
    }

    const unit_price = Number(variant.price);
    const total_price = Number((unit_price * item.quantity).toFixed(2));
    const product = variant.products || {};
    const retailer = product.retailers || {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Direct Retailer',
      shipping_policy_json: null
    };

    const snapshotItem: CheckoutItemSnapshot = {
      cart_item_id: item.id,
      variant_id: variant.id,
      product_id: product.id || variant.product_id,
      retailer_id: retailer.id,
      title: product.title || 'Product',
      sku: variant.sku,
      unit_price,
      quantity: item.quantity,
      total_price,
    };

    flatItems.push(snapshotItem);

    if (!retailerMap.has(retailer.id)) {
      retailerMap.set(retailer.id, {
        retailer,
        items: [],
        subtotal: 0,
        lead_time_days: 0,
      });
    }

    const group = retailerMap.get(retailer.id)!;
    group.items.push(snapshotItem);
    group.subtotal = Number((group.subtotal + total_price).toFixed(2));
    group.lead_time_days = Math.max(
      group.lead_time_days,
      Number(product.lead_time_days ?? 0)
    );
  }

  let subtotal = 0;
  let shipping_total = 0;
  let tax_total = 0;

  const retailerGroups: RetailerGroupSnapshot[] = [];

  for (const [, group] of retailerMap.entries()) {
    const shipping = calculateShipping(
      group.retailer,
      group.subtotal,
      currency,
      group.lead_time_days || null,
    );
    const tax = calculateTax(group.items, group.subtotal, shipping.shipping_amount);

    subtotal = Number((subtotal + group.subtotal).toFixed(2));
    shipping_total = Number((shipping_total + shipping.shipping_amount).toFixed(2));
    tax_total = Number((tax_total + tax.tax_amount).toFixed(2));

    retailerGroups.push({
      retailer_id: group.retailer.id,
      retailer_name: group.retailer.name,
      items: group.items,
      subtotal: group.subtotal,
      shipping,
      tax,
    });
  }

  // Promotion — same validator the cart quote uses, so the figure a shopper was
  // shown and the figure they are charged come from one place.
  let discount_amount = 0;
  let promotion_id: string | null = null;
  let promotion_code: string | null = null;

  if (promoCode) {
    const promo = await validatePromotion(promoCode, subtotal, userId);
    if (promo.valid && promo.promotion) {
      discount_amount = promo.discount_amount;
      promotion_id = promo.promotion.id;
      promotion_code = promo.promotion.code;
    }
    // An invalid code here is not an error. It may have expired between the
    // cart and the payment sheet; charging full price is the correct outcome,
    // and the cart already told them whether it applied.
  }

  const grand_total = Number(
    Math.max(0, subtotal - discount_amount + shipping_total + tax_total).toFixed(2)
  );
  const grand_total_cents = Math.round(grand_total * 100);

  // Deterministic Cart Snapshot Hash:
  // sha256(userId + sorted(variant_id:quantity:unit_price) + promo)
  //
  // The promo is part of the hash because this value dedupes PaymentIntents.
  // Without it, applying a code to an otherwise unchanged cart would reuse the
  // intent created before the discount — and charge the undiscounted amount
  // through the deduplication path rather than the pricing one.
  const sortedItemsKey = flatItems
    .slice()
    .sort((a, b) => a.variant_id.localeCompare(b.variant_id))
    .map((i) => `${i.variant_id}:${i.quantity}:${i.unit_price}`)
    .join('|');

  const cart_snapshot_hash = crypto
    .createHash('sha256')
    .update(`${userId}:${sortedItemsKey}:${promotion_code ?? ''}:${discount_amount}`)
    .digest('hex');

  return {
    user_id: userId,
    cart_snapshot_hash,
    retailers: retailerGroups,
    items: flatItems,
    subtotal,
    shipping_total,
    tax_total,
    discount_amount,
    promotion_id,
    promotion_code,
    grand_total,
    grand_total_cents,
    currency,
    shipping_address: shippingAddress,
  };
}