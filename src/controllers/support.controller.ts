/**
 * Support tickets — customer and vendor side.  controllers/support.controller.ts
 * ============================================================================
 * Anyone signed in can open a ticket, optionally about one of their orders,
 * and reply on it. Nooi admins answer from /admin/support (ops.controller).
 *
 *   status open      waiting on Nooi
 *          waiting   Nooi replied, waiting on the customer / vendor
 *          resolved  closed; a new reply from the requester reopens it
 *
 * Routes (mounted at /support, all requireAuth):
 *   GET  /tickets                list my tickets
 *   POST /tickets                { subject, category, order_id?, body }
 *   GET  /tickets/:id            ticket + messages (marks read)
 *   POST /tickets/:id/messages   { body }
 */

import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';

export const SUPPORT_CATEGORIES = ['order', 'payment', 'return', 'listing', 'payout', 'account', 'general'] as const;

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

function requesterRole(req: AuthRequest): 'customer' | 'vendor' {
  return req.userProfile?.role === 'vendor' ? 'vendor' : 'customer';
}

export async function listMyTickets(req: AuthRequest, res: Response) {
  const { data, error } = await supabase.from('support_tickets')
    .select('id, number, subject, category, status, order_id, requester_unread, last_message_at, created_at')
    .eq('created_by', req.user!.id)
    .order('last_message_at', { ascending: false })
    .limit(100);
  if (error) return res.status(400).json({ success: false, error: error.message });
  return res.json({ success: true, data: { tickets: data || [] } });
}

export async function createTicket(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const subject = clean(req.body?.subject, 140);
    const body = clean(req.body?.body, 5000);
    const category = SUPPORT_CATEGORIES.includes(req.body?.category) ? req.body.category : 'general';
    const orderId = typeof req.body?.order_id === 'string' && req.body.order_id ? req.body.order_id : null;
    if (subject.length < 3) return res.status(400).json({ success: false, error: 'Add a short subject.' });
    if (body.length < 5) return res.status(400).json({ success: false, error: 'Tell us a bit more about the problem.' });

    if (orderId) {
      // Customers may link their own orders; vendors, orders that include their goods.
      const { data: order } = await supabase.from('orders').select('id, user_id').eq('id', orderId).maybeSingle();
      let allowed = order?.user_id === userId;
      if (!allowed && order && requesterRole(req) === 'vendor') {
        const { data: r } = await supabase.from('retailers').select('id').eq('vendor_id', userId);
        const ids = (r || []).map((x: any) => x.id);
        if (ids.length) {
          const { count } = await supabase.from('order_shipments').select('id', { count: 'exact', head: true })
            .eq('order_id', orderId).in('retailer_id', ids);
          allowed = (count || 0) > 0;
        }
      }
      if (!allowed) return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const { data: ticket, error } = await supabase.from('support_tickets').insert({
      created_by: userId, requester_role: requesterRole(req), subject, category, order_id: orderId,
    }).select('id, number').single();
    if (error) return res.status(400).json({ success: false, error: error.message });

    const { error: mErr } = await supabase.from('support_messages').insert({
      ticket_id: ticket.id, author_id: userId, author_role: requesterRole(req), body,
    });
    if (mErr) {
      await supabase.from('support_tickets').delete().eq('id', ticket.id);
      return res.status(400).json({ success: false, error: mErr.message });
    }
    return res.status(201).json({ success: true, data: { ticket }, message: `Ticket #${ticket.number} opened` });
  } catch (err) {
    console.error('createTicket error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getMyTicket(req: AuthRequest, res: Response) {
  const { data: ticket } = await supabase.from('support_tickets')
    .select('*, orders ( order_number )').eq('id', req.params.id as string).eq('created_by', req.user!.id).maybeSingle();
  if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
  const { data: messages } = await supabase.from('support_messages')
    .select('id, author_role, body, created_at').eq('ticket_id', ticket.id).order('created_at');
  if (ticket.requester_unread) {
    await supabase.from('support_tickets').update({ requester_unread: false }).eq('id', ticket.id);
  }
  return res.json({ success: true, data: { ticket, messages: messages || [] } });
}

export async function replyToMyTicket(req: AuthRequest, res: Response) {
  const body = clean(req.body?.body, 5000);
  if (!body) return res.status(400).json({ success: false, error: 'Write a message first.' });
  const { data: ticket } = await supabase.from('support_tickets')
    .select('id').eq('id', req.params.id as string).eq('created_by', req.user!.id).maybeSingle();
  if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

  const { error } = await supabase.from('support_messages').insert({
    ticket_id: ticket.id, author_id: req.user!.id, author_role: requesterRole(req), body,
  });
  if (error) return res.status(400).json({ success: false, error: error.message });
  const now = new Date().toISOString();
  // A reply always puts the ticket back with Nooi, including a resolved one.
  await supabase.from('support_tickets').update({
    status: 'open', admin_unread: true, last_message_at: now, updated_at: now,
  }).eq('id', ticket.id);
  return res.json({ success: true });
}
