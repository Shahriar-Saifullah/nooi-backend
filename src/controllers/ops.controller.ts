/**
 * Admin operations — controllers/ops.controller.ts
 * ============================================================================
 * Listing review, cancellation requests, support tickets and platform
 * settings. Every decision is written to admin_audit_log, and the person it
 * affects gets an in-app notification.
 */

import { Response } from 'express';
import { supabase, supabaseAuth } from '../services/supabase';
import { AuthRequest } from '../types';
import { money, activeProvider } from '../services/payments';
import { cancelWholeOrder, cancelShipment, shipmentRefundAmount } from '../services/cancellation.service';
import { getSettings, validateSettingsPatch, clearSettingsCache } from '../services/settings.service';

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

async function audit(req: AuthRequest, action: string, entityType: string, entityId: string, summary: string, metadata: any = {}) {
  await supabase.from('admin_audit_log').insert({
    actor_id: req.user?.id, actor_email: req.user?.email || null,
    action, entity_type: entityType, entity_id: entityId, summary, metadata,
  });
}

async function notify(userId: string | null | undefined, title: string, message: string, type: string, link?: string) {
  if (!userId) return;
  await supabase.from('notifications').insert({ user_id: userId, title, message, type, link_url: link ?? null });
}

const isSuper = (req: AuthRequest) => req.userProfile?.role === 'super_admin';

// ════════════════════════════════════════════════════════════════════════════
// Listings
// ════════════════════════════════════════════════════════════════════════════

const LISTING_TABS = ['pending', 'approved', 'rejected', 'deactivated'] as const;

/** GET /admin/listings?tab=pending|approved|rejected|deactivated|all&search= */
export async function listListings(req: AuthRequest, res: Response) {
  try {
    const tab = String(req.query.tab || 'pending');
    const search = clean(req.query.search, 80);
    let q = supabase.from('products')
      .select(`id, title, category, type_id, base_price, listing_status, review_note, submitted_at, reviewed_at, created_at,
               specs_json, retailers ( id, name, vendor_id ), product_variants ( id, sku, images, stock_quantity, price )`)
      .order(tab === 'pending' ? 'submitted_at' : 'created_at', { ascending: tab === 'pending' })
      .limit(100);
    if ((LISTING_TABS as readonly string[]).includes(tab)) q = q.eq('listing_status', tab);
    if (search) q = q.ilike('title', `%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });

    const counts: Record<string, number> = {};
    await Promise.all(LISTING_TABS.map(async t => {
      const { count } = await supabase.from('products').select('id', { count: 'exact', head: true }).eq('listing_status', t);
      counts[t] = count || 0;
    }));
    return res.json({ success: true, data: { listings: data || [], counts } });
  } catch (err) {
    console.error('listListings error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** GET /admin/listings/:id */
export async function getListing(req: AuthRequest, res: Response) {
  const { data, error } = await supabase.from('products')
    .select(`*, retailers ( id, name, vendor_id, commission_rate ), product_variants ( * ), furniture_types ( id, name, shop_group )`)
    .eq('id', req.params.id as string).maybeSingle();
  if (error) return res.status(400).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Listing not found' });
  return res.json({ success: true, data: { listing: data } });
}

/**
 * POST /admin/listings/:id/decision  { action: approve|reject|deactivate|reactivate, note? }
 *   approve     pending|rejected → approved   (on sale)
 *   reject      pending → rejected            (note required; vendor fixes and resubmits)
 *   deactivate  approved → deactivated        (note required; taken off sale)
 *   reactivate  deactivated → approved
 */
export async function decideListing(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const action = String(req.body?.action || '');
    const note = clean(req.body?.note, 1000);
    const rules: Record<string, { from: string[]; to: string; needsNote: boolean; verb: string }> = {
      approve:    { from: ['pending', 'rejected'], to: 'approved', needsNote: false, verb: 'approved' },
      reject:     { from: ['pending'], to: 'rejected', needsNote: true, verb: 'sent back for changes' },
      deactivate: { from: ['approved'], to: 'deactivated', needsNote: true, verb: 'taken off sale' },
      reactivate: { from: ['deactivated'], to: 'approved', needsNote: false, verb: 'put back on sale' },
    };
    const rule = rules[action];
    if (!rule) return res.status(400).json({ success: false, error: 'Unknown action' });
    if (rule.needsNote && note.length < 3) {
      return res.status(400).json({ success: false, error: 'Tell the vendor why — they will see this note.' });
    }

    const now = new Date().toISOString();
    // Conditional update: only from the expected states, so two admins can't
    // both act on the same listing.
    const { data: updated, error } = await supabase.from('products')
      .update({
        listing_status: rule.to,
        review_note: rule.to === 'approved' ? null : note,
        reviewed_by: req.user!.id,
        reviewed_at: now,
      })
      .eq('id', id).in('listing_status', rule.from)
      .select('id, title, listing_status, retailers ( vendor_id )').maybeSingle();
    if (error) return res.status(400).json({ success: false, error: error.message });
    if (!updated) {
      const { data: cur } = await supabase.from('products').select('listing_status').eq('id', id).maybeSingle();
      if (!cur) return res.status(404).json({ success: false, error: 'Listing not found' });
      return res.status(409).json({ success: false, error: `This listing is ${cur.listing_status}; it can't be ${rule.verb} from here.` });
    }

    const vendorId = (updated as any).retailers?.vendor_id;
    const title = updated.title;
    await audit(req, `listing.${action}`, 'product', id, `Listing "${title}" ${rule.verb}${note ? `: ${note.slice(0, 140)}` : ''}`, { note });
    await notify(
      vendorId,
      rule.to === 'approved' ? `"${title}" is live` : rule.to === 'rejected' ? `Changes needed on "${title}"` : `"${title}" was taken off sale`,
      rule.to === 'approved' ? 'Your listing is now on sale in the Nooi marketplace.' : note,
      'listing',
      '/sell/products',
    );
    return res.json({ success: true, data: { listing_status: rule.to }, message: `Listing ${rule.verb}` });
  } catch (err) {
    console.error('decideListing error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cancellations
// ════════════════════════════════════════════════════════════════════════════

/** GET /admin/cancellations?tab=requested|approved|declined|all */
export async function listCancellations(req: AuthRequest, res: Response) {
  try {
    const tab = String(req.query.tab || 'requested');
    let q = supabase.from('order_cancellation_requests')
      .select(`id, order_id, shipment_id, requester_role, reason, status, refund_amount, decision_note, created_at, decided_at,
               orders ( order_number, total_amount, currency, status, shipping_address ),
               order_shipments ( shipment_status, retailers ( name ) )`)
      .order('created_at', { ascending: tab === 'requested' })
      .limit(100);
    if (tab === 'requested') q = q.in('status', ['requested', 'processing']);
    else if (tab !== 'all') q = q.eq('status', tab);
    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });
    const { count } = await supabase.from('order_cancellation_requests')
      .select('id', { count: 'exact', head: true }).in('status', ['requested', 'processing']);
    return res.json({ success: true, data: { requests: data || [], open_count: count || 0 } });
  } catch (err) {
    console.error('listCancellations error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** GET /admin/cancellations/:id — with the refund it would send. */
export async function getCancellation(req: AuthRequest, res: Response) {
  const { data: r } = await supabase.from('order_cancellation_requests')
    .select(`*, orders ( id, order_number, total_amount, currency, status, user_id, created_at,
               order_items ( id, total_price, quantity, item_status, retailer_id, product_variants ( sku, products ( title ) ) ),
               order_shipments ( id, shipment_status, retailer_id, retailers ( name ) ) ),
             order_shipments ( id, shipment_status, retailers ( name ) )`)
    .eq('id', req.params.id as string).maybeSingle();
  if (!r) return res.status(404).json({ success: false, error: 'Request not found' });

  let refund_preview: number | null = null;
  if (r.shipment_id) {
    refund_preview = (await shipmentRefundAmount(r.shipment_id))?.amount ?? null;
  } else {
    const { data: returns } = await supabase.from('order_returns')
      .select('order_item_id, status').eq('order_id', r.order_id).eq('status', 'refunded');
    const items = (r as any).orders?.order_items || [];
    const already = (returns || []).reduce((a: number, x: any) =>
      a + Number(items.find((i: any) => i.id === x.order_item_id)?.total_price || 0), 0);
    refund_preview = Math.max(0, Number((r as any).orders?.total_amount || 0) - already);
  }
  return res.json({ success: true, data: { request: r, refund_preview } });
}

/** POST /admin/cancellations/:id/approve  { note? } — refunds and cancels. */
export async function approveCancellation(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const adminId = req.user!.id;
  const note = clean(req.body?.note, 500);
  try {
    const { data: r } = await supabase.from('order_cancellation_requests')
      .select('id, order_id, shipment_id, requested_by, requester_role, reason, status').eq('id', id).maybeSingle();
    if (!r) return res.status(404).json({ success: false, error: 'Request not found' });

    const { data: claimData, error: claimErr } = await supabase.rpc('claim_cancellation_request', {
      p_request_id: id, p_admin_id: adminId,
    });
    if (claimErr) return res.status(400).json({ success: false, error: claimErr.message });
    const claim: any = Array.isArray(claimData) ? claimData[0] : claimData;
    if (!claim?.claimed) {
      return res.status(409).json({ success: false, error: 'already_handled', data: { current_status: claim?.current_status } });
    }

    const reasonText = `${r.requester_role === 'vendor' ? 'Vendor' : 'Customer'} requested: ${r.reason}${note ? ` — ${note}` : ''}`;
    const result = r.shipment_id
      ? await cancelShipment({ shipmentId: r.shipment_id, note: reasonText, key: `cancel-request-${id}` })
      : await cancelWholeOrder({ orderId: r.order_id, adminId, note: reasonText, key: `cancel-request-${id}` });

    const now = new Date().toISOString();
    if (!result.ok) {
      // Nothing (or only a recorded failure) happened: put it back in the queue.
      await supabase.from('order_cancellation_requests').update({
        status: result.error === 'already_handled' ? 'declined' : 'requested',
        decision_note: result.error === 'already_handled' ? 'Order was already cancelled.' : `Approval failed: ${result.error}`,
        updated_at: now,
      }).eq('id', id);
      return res.status(result.status).json({ success: false, error: result.error });
    }

    await supabase.from('order_cancellation_requests').update({
      status: 'approved', decided_at: now, decision_note: note || null,
      refund_amount: result.amount, refund_id: result.refundId, updated_at: now,
    }).eq('id', id);

    const { data: order } = await supabase.from('orders')
      .select('order_number, user_id, currency').eq('id', r.order_id).maybeSingle();
    const amountText = result.amount > 0 ? ` and refunded ${money(result.amount, order?.currency)}` : '';
    await audit(req, 'cancellation.approved', 'order', r.order_id,
      `Cancelled ${r.shipment_id ? 'one vendor\'s part of ' : ''}${order?.order_number}${amountText}`, { request_id: id, refund_id: result.refundId });

    await notify(order?.user_id, `Order ${order?.order_number} ${r.shipment_id ? 'partly ' : ''}cancelled`,
      result.amount > 0
        ? `We've refunded ${money(result.amount, order?.currency)}. It usually reaches your account within five working days.`
        : 'Your order has been cancelled.',
      'order_status', `/orders/${r.order_id}`);
    if (r.requester_role === 'vendor') {
      await notify(r.requested_by, `Cancellation approved for ${order?.order_number}`,
        'The customer has been refunded and the order removed from your list.', 'order_status', '/sell/orders');
    }
    return res.json({ success: true, data: { refunded: result.amount, refund_id: result.refundId }, message: `Cancelled${amountText}` });
  } catch (err) {
    console.error('approveCancellation error:', err);
    await supabase.from('order_cancellation_requests').update({ status: 'requested' }).eq('id', id).eq('status', 'processing');
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** POST /admin/cancellations/:id/decline  { note } */
export async function declineCancellation(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const note = clean(req.body?.note, 1000);
  if (note.length < 3) return res.status(400).json({ success: false, error: 'Explain why — the requester sees this.' });
  const now = new Date().toISOString();
  const { data: r, error } = await supabase.from('order_cancellation_requests')
    .update({ status: 'declined', decided_by: req.user!.id, decided_at: now, decision_note: note, updated_at: now })
    .eq('id', id).eq('status', 'requested')
    .select('order_id, requested_by, requester_role').maybeSingle();
  if (error) return res.status(400).json({ success: false, error: error.message });
  if (!r) return res.status(409).json({ success: false, error: 'already_handled' });
  const { data: order } = await supabase.from('orders').select('order_number').eq('id', r.order_id).maybeSingle();
  await audit(req, 'cancellation.declined', 'order', r.order_id, `Declined cancellation of ${order?.order_number}: ${note.slice(0, 140)}`);
  await notify(r.requested_by, `Cancellation of ${order?.order_number} declined`, note, 'order_status',
    r.requester_role === 'vendor' ? '/sell/orders' : `/orders/${r.order_id}`);
  return res.json({ success: true, message: 'Request declined' });
}

// ════════════════════════════════════════════════════════════════════════════
// Support
// ════════════════════════════════════════════════════════════════════════════

/** GET /admin/support?tab=open|waiting|resolved|all&search= */
export async function listSupportTickets(req: AuthRequest, res: Response) {
  try {
    const tab = String(req.query.tab || 'open');
    const search = clean(req.query.search, 80);
    let q = supabase.from('support_tickets')
      .select('id, number, subject, category, status, requester_role, created_by, order_id, admin_unread, last_message_at, created_at, orders ( order_number )')
      .order('last_message_at', { ascending: tab !== 'open' ? false : true })
      .limit(100);
    if (['open', 'waiting', 'resolved'].includes(tab)) q = q.eq('status', tab);
    if (search) q = /^\d+$/.test(search) ? q.eq('number', Number(search)) : q.ilike('subject', `%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });

    const ids = [...new Set((data || []).map((t: any) => t.created_by))];
    const { data: people } = ids.length
      ? await supabase.from('profiles').select('id, full_name').in('id', ids)
      : { data: [] as any[] };
    const nameOf = new Map((people || []).map((p: any) => [p.id, p.full_name]));

    const counts: Record<string, number> = {};
    await Promise.all(['open', 'waiting', 'resolved'].map(async s => {
      const { count } = await supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }));
    return res.json({
      success: true,
      data: { tickets: (data || []).map((t: any) => ({ ...t, requester_name: nameOf.get(t.created_by) ?? null })), counts },
    });
  } catch (err) {
    console.error('listSupportTickets error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** GET /admin/support/:id — marks it read for admins. */
export async function getSupportTicket(req: AuthRequest, res: Response) {
  const { data: ticket } = await supabase.from('support_tickets')
    .select('*, orders ( id, order_number, status, total_amount, currency )').eq('id', req.params.id as string).maybeSingle();
  if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
  const [{ data: messages }, { data: person }] = await Promise.all([
    supabase.from('support_messages').select('id, author_id, author_role, body, created_at').eq('ticket_id', ticket.id).order('created_at'),
    supabase.from('profiles').select('full_name, role').eq('id', ticket.created_by).maybeSingle(),
  ]);
  let email: string | null = null;
  try { email = (await supabase.auth.admin.getUserById(ticket.created_by)).data.user?.email ?? null; } catch { /* optional */ }
  if (ticket.admin_unread) await supabase.from('support_tickets').update({ admin_unread: false }).eq('id', ticket.id);
  return res.json({
    success: true,
    data: { ticket, messages: messages || [], requester: { name: person?.full_name ?? null, role: person?.role ?? null, email } },
  });
}

/** POST /admin/support/:id/reply  { body, status?: waiting|resolved } */
export async function replySupportTicket(req: AuthRequest, res: Response) {
  const body = clean(req.body?.body, 5000);
  const status = ['waiting', 'resolved'].includes(req.body?.status) ? req.body.status : 'waiting';
  if (!body) return res.status(400).json({ success: false, error: 'Write a reply first.' });
  const { data: ticket } = await supabase.from('support_tickets')
    .select('id, number, subject, created_by, requester_role').eq('id', req.params.id as string).maybeSingle();
  if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

  const { error } = await supabase.from('support_messages').insert({
    ticket_id: ticket.id, author_id: req.user!.id, author_role: 'admin', body,
  });
  if (error) return res.status(400).json({ success: false, error: error.message });
  const now = new Date().toISOString();
  await supabase.from('support_tickets').update({
    status, requester_unread: true, admin_unread: false, last_message_at: now, updated_at: now,
    assigned_to: req.user!.id,
  }).eq('id', ticket.id);
  await notify(ticket.created_by, `Reply on ticket #${ticket.number}`, body.slice(0, 200), 'support',
    ticket.requester_role === 'vendor' ? '/sell/support' : `/support?ticket=${ticket.id}`);
  return res.json({ success: true });
}

/** POST /admin/support/:id/status  { status: open|waiting|resolved } */
export async function setSupportStatus(req: AuthRequest, res: Response) {
  const status = String(req.body?.status || '');
  if (!['open', 'waiting', 'resolved'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });
  const { error } = await supabase.from('support_tickets')
    .update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id as string);
  if (error) return res.status(400).json({ success: false, error: error.message });
  return res.json({ success: true });
}

// ════════════════════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════════════════════

/** GET /admin/settings */
export async function getPlatformSettings(req: AuthRequest, res: Response) {
  const settings = await getSettings(true);
  return res.json({ success: true, data: { settings, can_edit: isSuper(req) } });
}

/** PUT /admin/settings — super admin only. */
export async function updatePlatformSettings(req: AuthRequest, res: Response) {
  if (!isSuper(req)) return res.status(403).json({ success: false, error: 'Only a super administrator can change platform settings.' });
  const v = validateSettingsPatch(req.body || {});
  if ('error' in v) return res.status(400).json({ success: false, error: v.error });
  const before = await getSettings(true);
  const { error } = await supabase.from('platform_settings')
    .update({ ...v.patch, updated_by: req.user!.id, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) return res.status(400).json({ success: false, error: error.message });
  clearSettingsCache();
  const changed = Object.keys(v.patch).filter(k => String((before as any)[k] ?? '') !== String((v.patch as any)[k] ?? ''));
  if (changed.length) {
    await audit(req, 'settings.updated', 'platform', 'settings', `Changed ${changed.join(', ').replace(/_/g, ' ')}`,
      { before: Object.fromEntries(changed.map(k => [k, (before as any)[k]])), after: Object.fromEntries(changed.map(k => [k, (v.patch as any)[k]])) });
  }
  return res.json({ success: true, data: { settings: await getSettings(true) }, message: 'Settings saved' });
}

/**
 * GET /admin/settings/payments — read-only health of the payment setup.
 * Never returns a key, only whether one is set and which mode it is.
 */
export async function getPaymentStatus(_req: AuthRequest, res: Response) {
  const sk = process.env.MOYASAR_SECRET_KEY || '';
  const pk = process.env.MOYASAR_PUBLISHABLE_KEY || '';
  const mode = sk.startsWith('sk_live_') ? 'live' : sk.startsWith('sk_test_') ? 'test' : 'unset';
  const [{ data: lastHook }, { count: failedHooks }, { data: lastPayout }] = await Promise.all([
    supabase.from('webhook_events').select('event_type, status, created_at, processed_at')
      .like('stripe_event_id', 'moyasar:%').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('webhook_events').select('id', { count: 'exact', head: true })
      .like('stripe_event_id', 'moyasar:%').eq('status', 'failed')
      .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()),
    supabase.from('vendor_payouts').select('status, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const purpose = process.env.MOYASAR_PAYOUT_PURPOSE || 'payment_to_merchant';
  const warnings: string[] = [];
  if (activeProvider() !== 'moyasar') warnings.push('PAYMENT_PROVIDER is not "moyasar" — checkout uses Stripe.');
  if (!sk || !pk) warnings.push('Moyasar keys are missing.');
  if (sk && pk && sk.startsWith('sk_live_') !== pk.startsWith('pk_live_')) warnings.push('Secret and publishable keys are from different modes (test vs live).');
  if (!process.env.MOYASAR_WEBHOOK_SECRET) warnings.push('MOYASAR_WEBHOOK_SECRET is not set — webhooks will be rejected.');
  if (!process.env.MOYASAR_PAYOUT_SOURCE_ID) warnings.push('MOYASAR_PAYOUT_SOURCE_ID is not set — payouts cannot be sent.');
  if (mode === 'live' && purpose !== 'payment_to_merchant') warnings.push(`Live mode with payout purpose "${purpose}" — that is a test value; use payment_to_merchant.`);
  if ((failedHooks || 0) > 0) warnings.push(`${failedHooks} webhook deliveries failed in the last 7 days.`);
  return res.json({
    success: true,
    data: {
      provider: activeProvider(),
      mode,
      currency: process.env.CHECKOUT_CURRENCY || (activeProvider() === 'moyasar' ? 'SAR' : 'USD'),
      keys: { secret: Boolean(sk), publishable: Boolean(pk) },
      webhook_secret_set: Boolean(process.env.MOYASAR_WEBHOOK_SECRET),
      payout_source_set: Boolean(process.env.MOYASAR_PAYOUT_SOURCE_ID),
      payout_purpose: purpose,
      methods: (process.env.MOYASAR_METHODS || 'creditcard,stcpay').split(',').map(s => s.trim()),
      last_webhook: lastHook ?? null,
      failed_webhooks_7d: failedHooks || 0,
      last_payout: lastPayout ?? null,
      warnings,
    },
  });
}

/** GET /admin/me, PUT /admin/me { full_name } — the admin's own profile. */
export async function getMe(req: AuthRequest, res: Response) {
  return res.json({
    success: true,
    data: { id: req.user!.id, email: req.user!.email, full_name: req.userProfile?.full_name ?? null, role: req.userProfile?.role },
  });
}

export async function updateMe(req: AuthRequest, res: Response) {
  const name = clean(req.body?.full_name, 120);
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Enter your name.' });
  const { error } = await supabase.from('profiles').update({ full_name: name }).eq('id', req.user!.id);
  if (error) return res.status(400).json({ success: false, error: error.message });
  return res.json({ success: true, message: 'Saved' });
}

/**
 * PUT /admin/me/password { current_password, new_password }
 * Re-checks the current password first, so a borrowed open session can't
 * lock the real admin out.
 */
export async function changeMyPassword(req: AuthRequest, res: Response) {
  const current = String(req.body?.current_password ?? '');
  const next = String(req.body?.new_password ?? '');
  if (next.length < 10) return res.status(400).json({ success: false, error: 'Use at least 10 characters for the new password.' });
  if (next === current) return res.status(400).json({ success: false, error: 'The new password must be different.' });
  const email = req.user?.email;
  if (!email) return res.status(400).json({ success: false, error: 'No email on this account.' });
  const { error: signInErr } = await supabaseAuth.auth.signInWithPassword({ email, password: current });
  if (signInErr) return res.status(400).json({ success: false, error: 'Your current password is not right.' });
  const { error } = await supabase.auth.admin.updateUserById(req.user!.id, { password: next });
  if (error) return res.status(400).json({ success: false, error: error.message });
  await audit(req, 'account.password_changed', 'profile', req.user!.id, 'Changed their password');
  return res.json({ success: true, message: 'Password changed' });
}

/** Counts for the dashboard / sidebar badges. GET /admin/ops/counts */
export async function getOpsCounts(_req: AuthRequest, res: Response) {
  const [l, c, s] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('listing_status', 'pending'),
    supabase.from('order_cancellation_requests').select('id', { count: 'exact', head: true }).in('status', ['requested', 'processing']),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  return res.json({ success: true, data: { listings: l.count || 0, cancellations: c.count || 0, support: s.count || 0 } });
}
