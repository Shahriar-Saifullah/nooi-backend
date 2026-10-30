const inserted: any[] = [];
let failInsert = false;
let prefs: Record<string, Record<string, boolean>> = {};

jest.mock('../services/supabase', () => {
  const chain = (table: string) => {
    const q: any = {
      _table: table,
      select: () => q, eq: () => q, in: () => q,
      maybeSingle: async () => ({ data: table === 'retailers' ? { vendor_id: 'vendor-1' } : null }),
      insert: async (rows: any) => {
        if (failInsert) throw new Error('db down');
        inserted.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      then: (resolve: any) => resolve({
        data: table === 'profiles'
          ? ['admin-1', 'admin-2', 'user-1', 'a', 'b'].map(id => ({ id, notification_prefs: prefs[id] ?? {} }))
              .filter(p => ['admin-1', 'admin-2'].includes(p.id) || Object.keys(prefs).length)
          : [],
      }),
    };
    return q;
  };
  return { supabase: { from: chain }, supabaseAuth: {} };
});

import { notify, notifyMany, notifyAdmins, vendorIdForRetailer, links } from '../services/notifications.service';

beforeEach(() => { inserted.length = 0; failInsert = false; prefs = {}; });

describe('notifications.service', () => {
  it('writes one row with a link', async () => {
    await notify('user-1', { title: 'Order confirmed', message: 'Thanks', type: 'order_status', link: links.order('o1') });
    expect(inserted).toEqual([{ user_id: 'user-1', title: 'Order confirmed', message: 'Thanks', type: 'order_status', link_url: '/orders/o1' }]);
  });

  it('skips a missing recipient', async () => {
    await notify(null, { title: 'x', message: 'y', type: 'admin' });
    expect(inserted).toHaveLength(0);
  });

  it('never throws, even if the database does', async () => {
    failInsert = true;
    await expect(notify('user-1', { title: 'x', message: 'y', type: 'admin' })).resolves.toBeUndefined();
  });

  it('de-duplicates recipients', async () => {
    await notifyMany(['a', 'b', 'a', null, undefined], { title: 't', message: 'm', type: 'admin' });
    expect(inserted.map(r => r.user_id)).toEqual(['a', 'b']);
  });

  it('reaches every admin', async () => {
    await notifyAdmins({ title: 'New ticket', message: 'm', type: 'admin', link: links.admin('support', 't1') });
    expect(inserted.map(r => r.user_id)).toEqual(['admin-1', 'admin-2']);
    expect(inserted[0].link_url).toBe('/admin/support?id=t1');
  });

  it('finds the vendor behind a retailer', async () => {
    await expect(vendorIdForRetailer('r1')).resolves.toBe('vendor-1');
  });

  it('links vendors to the exact order', () => {
    expect(links.vendorOrder('NOOI-123456')).toBe('/sell/orders?order=NOOI-123456');
    expect(links.vendorOrder(null)).toBe('/sell/orders');
  });

  it('trims very long text', async () => {
    await notify('u', { title: 'T'.repeat(300), message: 'M'.repeat(900), type: 'admin' });
    expect(inserted[0].title.length).toBe(140);
    expect(inserted[0].message.length).toBe(600);
  });

  it('respects a switched-off type', async () => {
    prefs = { 'user-1': { shipment: false } };
    await notify('user-1', { title: 'Shipped', message: 'm', type: 'shipment' });
    expect(inserted).toHaveLength(0);
    await notify('user-1', { title: 'Confirmed', message: 'm', type: 'order_status' });
    expect(inserted).toHaveLength(1);
  });

  it('still sends essential ones', async () => {
    prefs = { 'user-1': { order_status: false } };
    await notify('user-1', { title: 'Refunded', message: 'm', type: 'order_status', essential: true });
    expect(inserted).toHaveLength(1);
  });

  it('drops only the people who switched it off', async () => {
    prefs = { a: { support: false } };
    await notifyMany(['a', 'b'], { title: 'Reply', message: 'm', type: 'support' });
    expect(inserted.map(r => r.user_id)).toEqual(['b']);
  });
});
