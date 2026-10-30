/**
 * Cancellation requests — customer and vendor side.  controllers/cancellations.controller.ts
 * ============================================================================
 * Nobody cancels directly: they ask, and an admin decides (ops.controller),
 * because approving sends money back.
 *
 *   Customer  whole order, only before anything has been dispatched.
 *             POST /orders/:id/cancellation   { reason }
 *             GET  /orders/:id/cancellation   → latest request or null
 *
 *   Vendor    their own shipment within an order, any time before delivery
 *             (out of stock, can't make it, can't deliver to the address).
 *             POST /vendor/orders/:shipmentId/cancellation   { reason }
 *             GET  /vendor/orders/:shipmentId/cancellation
 */

import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { notifyAdmins, notifyOrderVendors, links } from '../services/notifications.service';

const NOT_DISPATCHED = ['label_pending', 'label_created'];

export async function requestOrderCancellation(req: AuthRequest, res: Response) {
  try {
    const orderId = req.params.id as string;
    const reason = String(req.body?.reason ?? '').trim().slice(0, 1000);
    if (reason.length < 3) return res.status(400).json({ success: false, error: 'Tell us why you want to cancel.' });

    const { data: order } = await supabase.from('orders')
      .select('id, user_id, status, order_number').eq('id', orderId).maybeSingle();
    if (!order || order.user_id !== req.user!.id) return res.status(404).json({ success: false, error: 'Order not found' });
    if (!['paid', 'processing'].includes(order.status)) {
      return res.status(409).json({ success: false, error: `This order is ${order.status} and can no longer be cancelled.` });
    }
    const { data: ships } = await supabase.from('order_shipments').select('shipment_status').eq('order_id', orderId);
    if ((ships || []).some((s: any) => !NOT_DISPATCHED.includes(s.shipment_status))) {
      return res.status(409).json({
        success: false,
        error: 'Part of this order has already been dispatched, so it can\'t be cancelled. You can return it once it arrives.',
      });
    }

    const { data, error } = await supabase.from('order_cancellation_requests').insert({
      order_id: orderId, requested_by: req.user!.id, requester_role: 'customer', reason,
    }).select('id, status, created_at').single();
    if (error) {
      if ((error as any).code === '23505') return res.status(409).json({ success: false, error: 'You have already asked to cancel this order.' });
      return res.status(400).json({ success: false, error: error.message });
    }
    await notifyOrderVendors(orderId, num => ({
      title: `Hold order ${num} — cancellation requested`,
      message: `The customer asked to cancel: "${reason.slice(0, 200)}". Don't ship it until Nooi decides; you'll be notified.`,
      type: 'cancellation', link: links.vendorOrder(num), essential: true,
    }));
    await notifyAdmins({
      title: `Cancellation request · ${order.order_number}`,
      message: `Customer: ${reason.slice(0, 200)}`,
      type: 'admin', link: links.admin('cancellations', data.id),
    });
    return res.status(201).json({ success: true, data: { request: data }, message: 'Cancellation requested. We\'ll let you know shortly.' });
  } catch (err) {
    console.error('requestOrderCancellation error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getOrderCancellation(req: AuthRequest, res: Response) {
  const orderId = req.params.id as string;
  const { data: order } = await supabase.from('orders').select('user_id').eq('id', orderId).maybeSingle();
  if (!order || order.user_id !== req.user!.id) return res.status(404).json({ success: false, error: 'Order not found' });
  const { data } = await supabase.from('order_cancellation_requests')
    .select('id, status, reason, decision_note, refund_amount, created_at, decided_at')
    .eq('order_id', orderId).is('shipment_id', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return res.json({ success: true, data: { request: data ?? null } });
}

async function vendorShipment(vendorId: string, shipmentId: string) {
  const { data: r } = await supabase.from('retailers').select('id').eq('vendor_id', vendorId);
  const ids = (r || []).map((x: any) => x.id);
  if (!ids.length) return null;
  const { data } = await supabase.from('order_shipments')
    .select('id, order_id, shipment_status, retailer_id').eq('id', shipmentId).in('retailer_id', ids).maybeSingle();
  return data;
}

export async function requestShipmentCancellation(req: AuthRequest, res: Response) {
  try {
    const shipmentId = req.params.shipmentId as string;
    const reason = String(req.body?.reason ?? '').trim().slice(0, 1000);
    if (reason.length < 3) return res.status(400).json({ success: false, error: 'Say why you can\'t fulfil this order.' });
    const ship = await vendorShipment(req.user!.id, shipmentId);
    if (!ship) return res.status(404).json({ success: false, error: 'Order not found' });
    if (['delivered', 'cancelled'].includes(ship.shipment_status)) {
      return res.status(409).json({ success: false, error: `This order is already ${ship.shipment_status}.` });
    }
    const { data, error } = await supabase.from('order_cancellation_requests').insert({
      order_id: ship.order_id, shipment_id: shipmentId, requested_by: req.user!.id, requester_role: 'vendor', reason,
    }).select('id, status, created_at').single();
    if (error) {
      if ((error as any).code === '23505') return res.status(409).json({ success: false, error: 'You have already asked to cancel this order.' });
      return res.status(400).json({ success: false, error: error.message });
    }
    {
      const { data: o } = await supabase.from('orders').select('order_number').eq('id', ship.order_id).maybeSingle();
      await notifyAdmins({
        title: `Vendor can't fulfil · ${o?.order_number ?? 'an order'}`,
        message: `Vendor asked to cancel their part: ${reason.slice(0, 200)}`,
        type: 'admin', link: links.admin('cancellations', data.id),
      });
    }
    return res.status(201).json({ success: true, data: { request: data }, message: 'Cancellation requested. Nooi will review it and refund the customer.' });
  } catch (err) {
    console.error('requestShipmentCancellation error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getShipmentCancellation(req: AuthRequest, res: Response) {
  const ship = await vendorShipment(req.user!.id, req.params.shipmentId as string);
  if (!ship) return res.status(404).json({ success: false, error: 'Order not found' });
  const { data } = await supabase.from('order_cancellation_requests')
    .select('id, status, reason, decision_note, refund_amount, created_at, decided_at, requester_role')
    .eq('shipment_id', ship.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return res.json({ success: true, data: { request: data ?? null } });
}
