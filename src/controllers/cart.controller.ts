import { Request, Response } from 'express';
import { supabase } from '../services/supabase';

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

    if (error || !data) {
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

    return res.json({ success: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
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
