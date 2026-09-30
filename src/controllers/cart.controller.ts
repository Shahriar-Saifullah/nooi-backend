import { Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { calculateShipping } from '../services/shipping.service';
import { calculateTax } from '../services/tax.service';
import { validatePromotion } from '../services/promotion.service';

// Memory fallback store for sessions when DB table is empty/local dev
const mockCartMemory: Record<string, any[]> = {};

export const getCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const sessionId = (req.query.session_id as string) || req.cookies?.cart_session || 'default_session';

    const { data, error } = await supabase
      .from('cart_items')
      .select('*, product_variants(*, products(*, retailers(*)))')
      .or(userId ? `user_id.eq.${userId},session_id.eq.${sessionId}` : `session_id.eq.${sessionId}`);

    if (error || !data || data.length === 0) {
      const items = mockCartMemory[userId || sessionId] || [];
      return res.json({ success: true, items, is_mock: true });
    }

    return res.json({ success: true, items: data, is_mock: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const addToCart = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || null;
    const sessionId = (req.body.session_id as string) || req.cookies?.cart_session || 'default_session';
    const { variant_id, quantity = 1, product_data } = req.body;

    if (!variant_id) {
      return res.status(400).json({ success: false, message: 'variant_id is required' });
    }

    // Check existing item for upsert logic
    let query = supabase.from('cart_items').select('*');
    if (userId) {
      query = query.eq('user_id', userId).eq('variant_id', variant_id);
    } else {
      query = query.eq('session_id', sessionId).eq('variant_id', variant_id);
    }

    const { data: existingItem } = await query.maybeSingle();

    let resultData;
    if (existingItem) {
      const newQty = existingItem.quantity + quantity;
      const { data, error } = await supabase
        .from('cart_items')
        .update({ quantity: newQty, updated_at: new Date().toISOString() })
        .eq('id', existingItem.id)
        .select('*, product_variants(*, products(*, retailers(*)))')
        .single();
      resultData = data;
    } else {
      const { data, error } = await supabase
        .from('cart_items')
        .insert({
          user_id: userId,
          session_id: sessionId,
          variant_id,
          quantity
        })
        .select('*, product_variants(*, products(*, retailers(*)))')
        .single();
      resultData = data;
    }

    if (!resultData) {
      const key = userId || sessionId;
      if (!mockCartMemory[key]) mockCartMemory[key] = [];
      
      const existing = mockCartMemory[key].find(item => item.variant_id === variant_id);
      if (existing) {
        existing.quantity += quantity;
      } else {
        mockCartMemory[key].push({
          id: `cart-item-${Date.now()}`,
          user_id: userId,
          session_id: sessionId,
          variant_id,
          quantity,
          product_data: product_data || {
            title: 'Modern Furniture Item',
            price: 495.00,
            retailer_name: 'West Elm',
            color: 'Default',
            image: '/assets/sofa.png'
          }
        });
      }

      return res.json({ success: true, items: mockCartMemory[key], is_mock: true });
    }

    return res.json({ success: true, item: resultData });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
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
            id, title, lead_time_days,
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
        tax_total: 0, discount_amount: 0, grand_total: 0, currency: 'USD',
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
      subtotal = Number((subtotal + lineTotal).toFixed(2));
      itemCount += row.quantity;
 
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
      group.subtotal = Number((group.subtotal + lineTotal).toFixed(2));
      group.lead_time_days = Math.max(group.lead_time_days, Number(product.lead_time_days ?? 14));
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
        in_stock: variant.stock_quantity > 0 && variant.is_active,
        stock_quantity: variant.stock_quantity,
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
 
    for (const group of groups.values()) {
      const shipping = calculateShipping(
        { id: group.retailer_id, name: group.retailer_name, shipping_policy_json: group._policy },
        group.subtotal,
        'USD',
        group.lead_time_days || null,
      );
      const tax = calculateTax(group.items, group.subtotal, shipping.shipping_amount);
 
      shippingTotal = Number((shippingTotal + shipping.shipping_amount).toFixed(2));
      taxTotal = Number((taxTotal + tax.tax_amount).toFixed(2));
 
      const { _policy, ...clean } = group;
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
      subtotal,
      shipping_total: shippingTotal,
      tax_total: taxTotal,
      tax_provider: calculateTax([], 0, 0).provider,
      discount_amount: discount,
      promotion,
      promo_error: promoError,
      grand_total: grandTotal,
      currency: 'USD',
    });
  } catch (err: any) {
    console.error('[cart] quote threw:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


export const updateCartItem = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    const userId = (req as any).user?.id;
    const sessionId = (req.body.session_id as string) || 'default_session';
    const key = userId || sessionId;

    if (quantity <= 0) {
      return removeCartItem(req, res);
    }

    const { data, error } = await supabase
      .from('cart_items')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      if (mockCartMemory[key]) {
        const item = mockCartMemory[key].find(i => i.id === id);
        if (item) item.quantity = quantity;
      }
      return res.json({ success: true, items: mockCartMemory[key] || [], is_mock: true });
    }

    return res.json({ success: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const removeCartItem = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;
    const sessionId = (req.query.session_id as string) || 'default_session';
    const key = userId || sessionId;

    const { error } = await supabase.from('cart_items').delete().eq('id', id);

    if (error) {
      if (mockCartMemory[key]) {
        mockCartMemory[key] = mockCartMemory[key].filter(i => i.id !== id);
      }
      return res.json({ success: true, items: mockCartMemory[key] || [], is_mock: true });
    }

    return res.json({ success: true, message: 'Item removed' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
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

    // Also handle memory fallback cart
    if (mockCartMemory[session_id]) {
      if (!mockCartMemory[userId]) mockCartMemory[userId] = [];
      for (const gItem of mockCartMemory[session_id]) {
        const uItem = mockCartMemory[userId].find(i => i.variant_id === gItem.variant_id);
        if (uItem) {
          uItem.quantity += gItem.quantity;
        } else {
          mockCartMemory[userId].push({ ...gItem, user_id: userId });
        }
      }
      delete mockCartMemory[session_id];
    }

    // 3. Return final merged user cart
    const { data: finalItems } = await supabase
      .from('cart_items')
      .select('*, product_variants(*, products(*, retailers(*)))')
      .eq('user_id', userId);

    return res.json({
      success: true,
      items: finalItems || mockCartMemory[userId] || [],
      message: 'Cart merged successfully'
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
