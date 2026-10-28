import { Request, Response } from 'express';
import { checkoutCurrency } from '../services/payments';
import { supabase } from '../services/supabase';
import { calculateShipping } from '../services/shipping.service';
import { calculateTax } from '../services/tax.service';
import { validatePromotion } from '../services/promotion.service';

/**
 * Cart — the signed-in shopper's server cart (cart_items).
 * ============================================================================
 * Every route here is behind requireAuth (cart.routes.ts), and every query is
 * scoped to req.user.id. Earlier versions:
 *   - fell back to a shared 'default_session' and read
 *     `user_id = me OR session_id = 'default_session'`, and every insert wrote
 *     that same session id, so each shopper's cart included everyone's rows;
 *     the client then "reconciled" by deleting the rows it didn't recognise —
 *     i.e. other people's items;
 *   - updated and deleted rows by id alone, so any signed-in user could edit
 *     or remove anyone's cart line;
 *   - swallowed database errors and answered success with an in-memory fake
 *     cart (a "West Elm" item at 495), so failures looked like successes.
 * None of that is kept. Errors are errors.
 */

type Req = Request & { user?: { id: string } };

const CART_SELECT = '*, product_variants(*, products(*, retailers(*)))';

/** Whether a variant can be put in a cart right now, and why not if not. */
async function checkVariant(variantId: string): Promise<{ ok: true; stock: number } | { ok: false; status: number; error: string }> {
  const { data: v } = await supabase
    .from('product_variants')
    .select('id, is_active, stock_quantity, products ( listing_status, title )')
    .eq('id', variantId)
    .maybeSingle();
  if (!v) return { ok: false, status: 404, error: 'VARIANT_NOT_FOUND' };
  const product: any = (v as any).products;
  if (v.is_active === false || (product?.listing_status && product.listing_status !== 'approved')) {
    return { ok: false, status: 422, error: 'VARIANT_UNAVAILABLE' };
  }
  return { ok: true, stock: Number(v.stock_quantity ?? 0) };
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const getCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as Req).user!.id;
    const { data, error } = await supabase.from('cart_items').select(CART_SELECT).eq('user_id', userId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, items: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** POST /cart/items { variant_id, quantity } — adds to the line if it exists. */
export const addToCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as Req).user!.id;
    const { variant_id, quantity = 1 } = req.body;
    if (!isUuid(variant_id)) return res.status(404).json({ success: false, error: 'VARIANT_NOT_FOUND' });

    const check = await checkVariant(variant_id);
    if (!check.ok) return res.status(check.status).json({ success: false, error: check.error });

    const { data: existing, error: readErr } = await supabase
      .from('cart_items').select('id, quantity')
      .eq('user_id', userId).eq('variant_id', variant_id).maybeSingle();
    if (readErr) return res.status(500).json({ success: false, error: readErr.message });

    const { data, error } = existing
      ? await supabase.from('cart_items')
          .update({ quantity: existing.quantity + Number(quantity), updated_at: new Date().toISOString() })
          .eq('id', existing.id).eq('user_id', userId)
          .select(CART_SELECT).single()
      : await supabase.from('cart_items')
          .insert({ user_id: userId, session_id: null, variant_id, quantity: Number(quantity) })
          .select(CART_SELECT).single();
    if (error) return res.status(500).json({ success: false, error: error.message });

    return res.json({ success: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const quoteCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id ?? null;
    const { promo_code } = req.body ?? {};
 
    // Price from the database, never from the request. The client sends a code
    // at most; every figure below is derived server-side.
    const { data: rows, error } = await supabase
      .from('cart_items')
      .select(`
        id, quantity, variant_id,
        product_variants (
          id, price, color, sku, images, stock_quantity, is_active,
          products (
            id, title, lead_time_days, listing_status,
            retailers ( id, name, logo_url, city, country, shipping_policy_json )
          )
        )
      `)
      .eq('user_id', userId);
 
    if (error) {
      console.error('[cart] quote query failed:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
 
    const items = rows ?? [];
    if (items.length === 0) {
      return res.json({
        success: true,
        groups: [], item_count: 0, subtotal: 0, shipping_total: 0,
        tax_total: 0, discount_amount: 0, grand_total: 0, currency: checkoutCurrency(),
        promotion: null,
      });
    }
 
    // Group by retailer — one shipment per vendor, which is what the cart shows
    // and what order_shipments records.
    const groups = new Map<string, any>();
    let subtotal = 0;
    let itemCount = 0;
 
    for (const row of items) {
      const variant: any = (row as any).product_variants;
      const product: any = variant?.products;
      const retailer: any = product?.retailers;
      if (!variant || !product || !retailer) continue;
 
      const unit = Number(variant.price);
      const lineTotal = Number((unit * row.quantity).toFixed(2));
      // A line can be bought only if the listing is live, the variant active
      // and there is enough stock. Anything else stays visible in the cart
      // (so the shopper sees why) but is left out of every total.
      const listed = product.listing_status === 'approved' && variant.is_active !== false;
      const stock = Number(variant.stock_quantity ?? 0);
      const available = listed && stock >= row.quantity;
      const unavailableReason = !listed ? 'unavailable' : stock <= 0 ? 'out_of_stock' : stock < row.quantity ? 'not_enough_stock' : null;
      if (available) {
        subtotal = Number((subtotal + lineTotal).toFixed(2));
        itemCount += row.quantity;
      }
 
      if (!groups.has(retailer.id)) {
        groups.set(retailer.id, {
          retailer_id: retailer.id,
          retailer_name: retailer.name,
          logo_url: retailer.logo_url,
          city: retailer.city,
          country: retailer.country,
          /** Slowest item in the group decides when the shipment lands. */
          lead_time_days: 0,
          items: [],
          subtotal: 0,
          _policy: retailer.shipping_policy_json,
        });
      }
 
      const group = groups.get(retailer.id);
      if (available) {
        group.subtotal = Number((group.subtotal + lineTotal).toFixed(2));
        group.lead_time_days = Math.max(group.lead_time_days, Number(product.lead_time_days ?? 14));
        group._buyable = true;
      }
      group.items.push({
        cart_item_id: row.id,
        variant_id: variant.id,
        product_id: product.id,
        title: product.title,
        color: variant.color,
        sku: variant.sku,
        image: variant.images?.[0] ?? null,
        unit_price: unit,
        quantity: row.quantity,
        line_total: lineTotal,
        in_stock: available,
        available,
        unavailable_reason: unavailableReason,
        stock_quantity: stock,
      });
    }
 
    // Promo applies to the subtotal before shipping and tax, so a code can
    // never make delivery free as a side effect.
    let discount = 0;
    let promotion: any = null;
    let promoError: string | null = null;
 
    if (promo_code) {
      const result = await validatePromotion(String(promo_code), subtotal, userId);
      if (result.valid && result.promotion) {
        discount = result.discount_amount;
        promotion = {
          code: result.promotion.code,
          description: result.promotion.description,
          discount_amount: discount,
        };
      } else {
        promoError = result.message ?? 'That code could not be applied.';
      }
    }
 
    let shippingTotal = 0;
    let taxTotal = 0;
    const out: any[] = [];
 
    let unavailableCount = 0;
    for (const group of groups.values()) {
      unavailableCount += group.items.filter((i: any) => !i.available).length;
      if (!group._buyable) {
        // Nothing in this shipment can be bought: no shipping or tax for it.
        const { _policy, _buyable, ...clean } = group;
        out.push({ ...clean, shipping_amount: 0, shipping_note: null, estimated_delivery: null, tax_amount: 0 });
        continue;
      }
      const buyable = group.items.filter((i: any) => i.available);
      const shipping = calculateShipping(
        { id: group.retailer_id, name: group.retailer_name, shipping_policy_json: group._policy },
        group.subtotal,
        checkoutCurrency(),
        group.lead_time_days || null,
      );
      const tax = calculateTax(buyable, group.subtotal, shipping.shipping_amount);
 
      shippingTotal = Number((shippingTotal + shipping.shipping_amount).toFixed(2));
      taxTotal = Number((taxTotal + tax.tax_amount).toFixed(2));
 
      const { _policy, _buyable, ...clean } = group;
      out.push({
        ...clean,
        shipping_amount: shipping.shipping_amount,
        shipping_note: shipping.policy_applied,
        estimated_delivery: shipping.estimated_delivery,
        tax_amount: tax.tax_amount,
      });
    }
 
    const grandTotal = Number(
      Math.max(0, subtotal - discount + shippingTotal + taxTotal).toFixed(2),
    );
 
    return res.json({
      success: true,
      groups: out,
      item_count: itemCount,
      unavailable_count: unavailableCount,
      subtotal,
      shipping_total: shippingTotal,
      tax_total: taxTotal,
      tax_provider: calculateTax([], 0, 0).provider,
      discount_amount: discount,
      promotion,
      promo_error: promoError,
      grand_total: grandTotal,
      currency: checkoutCurrency(),
    });
  } catch (err: any) {
    console.error('[cart] quote threw:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


/** PATCH /cart/items/:id { quantity } — only the caller's own line. 0 removes it. */
export const updateCartItem = async (req: Request, res: Response) => {
  try {
    const userId = (req as Req).user!.id;
    const { id } = req.params;
    const quantity = Number(req.body.quantity);
    if (quantity <= 0) return removeCartItem(req, res);

    const { data, error } = await supabase
      .from('cart_items')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', userId)
      .select().maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    if (!data) return res.status(404).json({ success: false, error: 'CART_ITEM_NOT_FOUND' });
    return res.json({ success: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** DELETE /cart/items/:id — only the caller's own line. */
export const removeCartItem = async (req: Request, res: Response) => {
  try {
    const userId = (req as Req).user!.id;
    const { id } = req.params;
    const { error } = await supabase.from('cart_items').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, message: 'Item removed' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const mergeCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { session_id } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required to merge cart' });
    }

    if (!session_id) {
      return res.status(400).json({ success: false, message: 'session_id is required' });
    }

    // 1. Fetch guest cart items
    const { data: guestItems } = await supabase
      .from('cart_items')
      .select('*')
      .eq('session_id', session_id)
      .is('user_id', null);

    if (guestItems && guestItems.length > 0) {
      // 2. Fetch user's existing cart items
      const { data: userItems } = await supabase
        .from('cart_items')
        .select('*')
        .eq('user_id', userId);

      const userMap = new Map((userItems || []).map(i => [i.variant_id, i]));

      for (const guestItem of guestItems) {
        if (userMap.has(guestItem.variant_id)) {
          const userItem = userMap.get(guestItem.variant_id)!;
          await supabase
            .from('cart_items')
            .update({ quantity: userItem.quantity + guestItem.quantity, updated_at: new Date().toISOString() })
            .eq('id', userItem.id);
          await supabase.from('cart_items').delete().eq('id', guestItem.id);
        } else {
          await supabase
            .from('cart_items')
            .update({ user_id: userId, updated_at: new Date().toISOString() })
            .eq('id', guestItem.id);
        }
      }
    }

    // 3. Return final merged user cart
    const { data: finalItems } = await supabase
      .from('cart_items')
      .select('*, product_variants(*, products(*, retailers(*)))')
      .eq('user_id', userId);

    return res.json({
      success: true,
      items: finalItems || [],
      message: 'Cart merged successfully'
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
