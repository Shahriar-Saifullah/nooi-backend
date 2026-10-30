/**
 * In-app notifications — services/notifications.service.ts
 * ============================================================================
 * Every notification goes through here, so the rules live in one place:
 *
 *   - Never throws. A failed notification must never fail the action that
 *     caused it (a refund, a dispatch, an approval).
 *   - Links point at a page the recipient can open: customers → /orders, /support;
 *     vendors → /sell/...; admins → /admin/...?id=.
 *   - Admins are everyone with role admin or super_admin (cached for 5 min).
 *
 * Who hears about what is documented next to each call site; the full list is
 * in docs/notifications.md.
 */

import { supabase } from './supabase';

export type NotificationType =
  | 'order_status' | 'shipment' | 'return' | 'cancellation' | 'vendor_approval'
  | 'listing' | 'payout' | 'support' | 'review' | 'stock' | 'admin';

export interface NotificationInput {
  title: string;
  message: string;
  type: NotificationType;
  link?: string | null;
  /** Sent even if the person turned this type off: money (refunds,
   *  cancellations, payment problems) and account decisions. */
  essential?: boolean;
}

/**
 * The switches on Profile → Notifications. A person can turn these types off;
 * everything else (admin alerts, account decisions) always goes through, and
 * `essential` notifications ignore the switch.
 */
export const SWITCHABLE_TYPES = [
  'order_status', 'shipment', 'return', 'cancellation', 'support',
  'review', 'stock', 'payout', 'listing',
] as const;
export type SwitchableType = typeof SWITCHABLE_TYPES[number];

/** Which of these people have turned this type off. */
async function mutedFor(userIds: string[], type: NotificationType): Promise<Set<string>> {
  if (!(SWITCHABLE_TYPES as readonly string[]).includes(type) || !userIds.length) return new Set();
  try {
    const { data } = await supabase.from('profiles').select('id, notification_prefs').in('id', userIds);
    return new Set((data ?? []).filter((p: any) => p.notification_prefs?.[type] === false).map((p: any) => p.id));
  } catch {
    return new Set(); // can't read preferences: better to notify than to drop
  }
}

/** Where each kind of notification should take the reader. */
export const links = {
  order: (orderId: string) => `/orders/${orderId}`,
  support: (ticketId: string) => `/support?ticket=${ticketId}`,
  vendorOrder: (orderNumber?: string | null) =>
    orderNumber ? `/sell/orders?order=${encodeURIComponent(orderNumber)}` : '/sell/orders',
  vendorProducts: '/sell/products',
  vendorReturns: '/sell/returns',
  vendorPayments: '/sell/payments',
  vendorDashboard: '/sell/dashboard',
  vendorSupport: (ticketId: string) => `/sell/support?ticket=${ticketId}`,
  admin: (section: string, id?: string | null) => `/admin/${section}${id ? `?id=${encodeURIComponent(id)}` : ''}`,
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function row(userId: string, n: NotificationInput) {
  return {
    user_id: userId,
    title: clip(n.title, 140),
    message: clip(n.message || '', 600),
    type: n.type,
    link_url: n.link ?? null,
  };
}

export async function notify(userId: string | null | undefined, n: NotificationInput): Promise<void> {
  if (!userId) return;
  try {
    if (!n.essential && (await mutedFor([userId], n.type)).has(userId)) return;
    const { error } = await supabase.from('notifications').insert(row(userId, n));
    if (error) console.warn('[notify] insert failed:', error.message);
  } catch (e: any) {
    console.warn('[notify] failed:', e?.message || e);
  }
}

export async function notifyMany(userIds: Array<string | null | undefined>, n: NotificationInput): Promise<void> {
  let ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return;
  try {
    if (!n.essential) {
      const muted = await mutedFor(ids, n.type);
      ids = ids.filter(id => !muted.has(id));
      if (!ids.length) return;
    }
    const { error } = await supabase.from('notifications').insert(ids.map(id => row(id, n)));
    if (error) console.warn('[notify] batch insert failed:', error.message);
  } catch (e: any) {
    console.warn('[notify] batch failed:', e?.message || e);
  }
}

// ─── Recipients ──────────────────────────────────────────────────────────────

let adminCache: { at: number; ids: string[] } | null = null;

export async function adminIds(): Promise<string[]> {
  if (adminCache && Date.now() - adminCache.at < 5 * 60_000) return adminCache.ids;
  try {
    const { data } = await supabase.from('profiles').select('id').in('role', ['admin', 'super_admin']);
    adminCache = { at: Date.now(), ids: (data ?? []).map(r => r.id) };
    return adminCache.ids;
  } catch {
    return adminCache?.ids ?? [];
  }
}

export async function notifyAdmins(n: NotificationInput): Promise<void> {
  await notifyMany(await adminIds(), n);
}

export async function vendorIdForRetailer(retailerId: string | null | undefined): Promise<string | null> {
  if (!retailerId) return null;
  const { data } = await supabase.from('retailers').select('vendor_id').eq('id', retailerId).maybeSingle();
  return data?.vendor_id ?? null;
}

/** The vendors with a shipment in this order (optionally only some retailers). */
export async function vendorsForOrder(orderId: string, retailerIds?: string[]): Promise<{ vendorId: string; retailerId: string }[]> {
  try {
    let q = supabase.from('order_shipments').select('retailer_id, retailers ( vendor_id )').eq('order_id', orderId);
    if (retailerIds?.length) q = q.in('retailer_id', retailerIds);
    const { data } = await q;
    const seen = new Set<string>();
    const out: { vendorId: string; retailerId: string }[] = [];
    for (const s of data ?? []) {
      const vendorId = (s as any).retailers?.vendor_id;
      if (vendorId && !seen.has(`${vendorId}:${s.retailer_id}`)) {
        seen.add(`${vendorId}:${s.retailer_id}`);
        out.push({ vendorId, retailerId: s.retailer_id });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function orderSummary(orderId: string): Promise<{ order_number: string; user_id: string | null; currency: string | null } | null> {
  const { data } = await supabase.from('orders').select('order_number, user_id, currency').eq('id', orderId).maybeSingle();
  return data ?? null;
}

/** Tell every vendor on an order the same thing. */
export async function notifyOrderVendors(orderId: string, build: (orderNumber: string) => NotificationInput, retailerIds?: string[]) {
  const [order, vendors] = await Promise.all([orderSummary(orderId), vendorsForOrder(orderId, retailerIds)]);
  if (!order || !vendors.length) return;
  await notifyMany(vendors.map(v => v.vendorId), build(order.order_number));
}
