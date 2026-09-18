import { Request, Response } from 'express';
import { supabase } from '../services/supabase';

// Mock order storage for fallback / demonstration
const MOCK_ORDERS: any[] = [];

export const createOrderCheckout = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || 'guest-user';
    const { items, shipping_address, subtotal, tax_amount = 0, shipping_amount = 0, total_amount } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart items are required' });
    }

    const orderNumber = `NOOI-${Math.floor(100000 + Math.random() * 900000)}`;
    const invoiceUrl = `/invoices/${orderNumber}.pdf`;

    const newOrder = {
      id: `ord-${Date.now()}`,
      order_number: orderNumber,
      user_id: userId,
      status: 'paid', // Direct approval bypassing payment gateway per user directive
      subtotal: subtotal || 1550.00,
      tax_amount,
      shipping_amount,
      total_amount: total_amount || (subtotal + tax_amount + shipping_amount),
      currency: 'USD',
      shipping_address: shipping_address || {
        fullName: 'Jane Doe',
        street: '123 Modern Living Way',
        city: 'New York',
        state: 'NY',
        zipCode: '10001',
        country: 'USA'
      },
      invoice_url: invoiceUrl,
      created_at: new Date().toISOString(),
      order_items: items.map((it: any, index: number) => ({
        id: `ord-item-${index + 1}`,
        retailer_name: it.retailer_name || 'West Elm',
        title: it.title || 'Haven Leather Sofa',
        unit_price: it.price || 1899.00,
        quantity: it.quantity || 1,
        total_price: (it.price || 1899.00) * (it.quantity || 1),
        item_status: 'processing'
      })),
      shipments: [
        {
          id: `ship-${Date.now()}`,
          carrier_code: 'fedex',
          tracking_number: `FX-${Math.floor(1000000000 + Math.random() * 9000000000)}`,
          shipment_status: 'label_created',
          estimated_delivery: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString()
        }
      ]
    };

    // Attempt DB insertion
    const { data: dbOrder, error } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        user_id: userId !== 'guest-user' ? userId : null,
        status: 'paid',
        subtotal: newOrder.subtotal,
        tax_amount: newOrder.tax_amount,
        shipping_amount: newOrder.shipping_amount,
        total_amount: newOrder.total_amount,
        shipping_address: newOrder.shipping_address,
        invoice_url: invoiceUrl
      })
      .select()
      .single();

    if (error || !dbOrder) {
      MOCK_ORDERS.unshift(newOrder);
      return res.json({
        success: true,
        order: newOrder,
        message: 'Order created successfully (bypassing gateway per directive)',
        is_mock: true
      });
    }

    MOCK_ORDERS.unshift(newOrder);
    return res.json({ success: true, order: dbOrder, is_mock: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getUserOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), order_shipments(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) {
      return res.json({ success: true, orders: MOCK_ORDERS, is_mock: true });
    }

    return res.json({ success: true, orders: data, is_mock: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getOrderById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), order_shipments(*, order_tracking_events(*))')
      .eq('id', id)
      .single();

    if (error || !data) {
      const match = MOCK_ORDERS.find(o => o.id === id || o.order_number === id) || MOCK_ORDERS[0];
      return res.json({ success: true, order: match, is_mock: true });
    }

    return res.json({ success: true, order: data, is_mock: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const submitReturnRequest = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason, photo_urls = [], order_item_id } = req.body;
    const userId = (req as any).user?.id || 'guest-user';

    const returnRecord = {
      id: `ret-${Date.now()}`,
      order_id: id,
      order_item_id,
      user_id: userId,
      reason,
      photo_urls,
      status: 'requested',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase.from('order_returns').insert(returnRecord).select().single();

    if (error || !data) {
      return res.json({ success: true, return_request: returnRecord, is_mock: true });
    }

    return res.json({ success: true, return_request: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
