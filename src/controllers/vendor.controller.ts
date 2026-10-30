import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { releaseEarnings } from '../services/payments/earnings.service';
import { fromMinor, maskIban, normaliseSaudiIban, summarise } from '../services/payments/ledger';
import { payoutHoldDays } from '../services/payments';
import { notify, notifyAdmins, links } from '../services/notifications.service';
import { UpdateVendorProfileInput } from '../schemas/auth.schema';

export async function getVendorProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url, language, created_at')
      .eq('id', userId)
      .single();

    const { data: vendorProfile, error } = await supabase
      .from('vendor_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !vendorProfile) {
      return res.status(404).json({
        success: false,
        error: 'Vendor profile not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        profile,
        vendor: vendorProfile,
      },
    });
  } catch (err) {
    console.error('getVendorProfile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateVendorProfile(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const body = req.body as UpdateVendorProfileInput;

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.business_name !== undefined) updateData.business_name = body.business_name;
    if (body.business_email !== undefined) updateData.business_email = body.business_email;
    if (body.phone !== undefined) updateData.phone = body.phone;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.website !== undefined) updateData.website = body.website || null;
    if (body.tax_id !== undefined) updateData.tax_id = body.tax_id || null;
    if (body.description !== undefined) updateData.description = body.description || null;
    if (body.address !== undefined) updateData.address = body.address || null;
    if (body.city !== undefined) updateData.city = body.city || null;
    if (body.country !== undefined) updateData.country = body.country || null;
    if (body.logo_url !== undefined) updateData.logo_url = body.logo_url || null;

    const { data, error } = await supabase
      .from('vendor_profiles')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { vendor: data },
      message: 'Vendor profile updated successfully',
    });
  } catch (err) {
    console.error('updateVendorProfile error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getVendorDashboardSummary(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;

    const { data: vendor, error } = await supabase
      .from('vendor_profiles')
      .select('business_name, status, category, verified_at, created_at')
      .eq('id', userId)
      .single();

    if (error || !vendor) {
      return res.status(404).json({ success: false, error: 'Vendor profile not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          business_name: vendor.business_name,
          category: vendor.category,
          status: vendor.status,
          verified_at: vendor.verified_at,
          total_products: 0,
          total_orders: 0,
          pending_orders: 0,
          total_revenue: 0,
        },
      },
    });
  } catch (err) {
    console.error('getVendorDashboardSummary error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Vendor orders and dispatch — add to src/controllers/vendor.controller.ts
 * ============================================================================
 * NOOI-69's write path. Until this exists every shipment sits at
 * label_pending forever, the shopper's tracking timeline never moves, and
 * carrier polling has nothing to poll.
 *
 * Routes (vendor.routes.ts):
 *   router.get('/orders',                       requireVendor, getVendorOrders);
 *   router.get('/orders/:shipmentId',           requireVendor, getVendorShipment);
 *   router.post('/orders/:shipmentId/dispatch', requireVendor, dispatchShipment);
 *   router.post('/orders/:shipmentId/status',   requireVendor, advanceShipmentStatus);
 *
 * A vendor acts on SHIPMENTS, not orders. order_shipments is already one row
 * per vendor, so filtering by their retailer gives exactly their slice — they
 * never see what the customer bought from anyone else, or the order total.
 *
 * The shipping address is the exception: they need it to post the goods, so it
 * comes from the parent order. Only that field — total_amount, discount_amount
 * and payment_intent_id live on the same row and are none of their business.
 */

/** Carriers worth accepting. Extend as real ones are onboarded. */
const CARRIERS: Record<string, { name: string; trackingUrl: (n: string) => string }> = {
  ARAMEX:  { name: 'Aramex',  trackingUrl: n => `https://www.aramex.com/track/results?ShipmentNumber=${n}` },
  DHL:     { name: 'DHL',     trackingUrl: n => `https://www.dhl.com/en/express/tracking.html?AWB=${n}` },
  FEDEX:   { name: 'FedEx',   trackingUrl: n => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  UPS:     { name: 'UPS',     trackingUrl: n => `https://www.ups.com/track?tracknum=${n}` },
  SMSA:    { name: 'SMSA',    trackingUrl: n => `https://www.smsaexpress.com/trackingdetails?tracknumbers=${n}` },
  NAQEL:   { name: 'Naqel',   trackingUrl: n => `https://www.naqelexpress.com/en/track?waybill=${n}` },
  OTHER:   { name: 'Other',   trackingUrl: () => '' },
};

/** Forward order. A vendor may move along it, never back. */
const PROGRESSION = [
  'label_pending', 'label_created', 'in_transit', 'out_for_delivery', 'delivered',
] as const;

/** The retailers this vendor owns. Every query is scoped through this. */
async function vendorRetailerIds(vendorId: string): Promise<string[]> {
  const { data } = await supabase
    .from('retailers')
    .select('id')
    .eq('vendor_id', vendorId);
  return (data || []).map((r: any) => r.id);
}

export async function getVendorOrders(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user?.id;
    if (!vendorId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const tab = (req.query.tab as string) || 'to_fulfil';   // to_fulfil|shipped|delivered|all
    const retailerIds = await vendorRetailerIds(vendorId);

    if (retailerIds.length === 0) {
      // Approved but no storefront, or not approved at all. Not an error —
      // they simply have nothing yet.
      return res.status(200).json({
        success: true,
        data: { shipments: [], counts: { to_fulfil: 0, shipped: 0, delivered: 0, all: 0 } },
      });
    }

    let query = supabase
      .from('order_shipments')
      .select(`
        id, order_id, retailer_id, carrier_code, tracking_number, tracking_url,
        shipment_status, estimated_delivery, dispatched_at, delivered_at,
        exception_code, exception_note, created_at,
        orders ( id, order_number, created_at, shipping_address, status )
      `)
      .in('retailer_id', retailerIds);

    if (tab === 'to_fulfil') {
      query = query.in('shipment_status', ['label_pending', 'label_created']);
    } else if (tab === 'shipped') {
      query = query.in('shipment_status', ['in_transit', 'out_for_delivery']);
    } else if (tab === 'delivered') {
      query = query.eq('shipment_status', 'delivered');
    }

    // Oldest first. A fulfilment queue sorted newest first is how an order sits
    // for three weeks while fresher ones get picked.
    const { data: shipments, error } = await query.order('created_at', { ascending: true });

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const rows = shipments || [];

    // Their items only — one query, grouped after.
    const orderIds = [...new Set(rows.map((s: any) => s.order_id))];
    const { data: items } = orderIds.length
      ? await supabase
          .from('order_items')
          .select(`
            id, order_id, retailer_id, quantity, unit_price, total_price, item_status,
            product_variants ( sku, color, images, products ( title ) )
          `)
          .in('order_id', orderIds)
          .in('retailer_id', retailerIds)
      : { data: [] as any[] };

    const itemsByOrder = new Map<string, any[]>();
    for (const it of (items || []) as any[]) {
      const list = itemsByOrder.get(it.order_id) || [];
      list.push(it);
      itemsByOrder.set(it.order_id, list);
    }

    const shaped = rows.map((s: any) => {
      const mine = (itemsByOrder.get(s.order_id) || []).filter(i => i.retailer_id === s.retailer_id);
      const addr = s.orders?.shipping_address || {};
      return {
        id: s.id,
        order_number: s.orders?.order_number ?? null,
        placed_at: s.orders?.created_at ?? s.created_at,
        shipment_status: s.shipment_status,
        carrier_code: s.carrier_code,
        tracking_number: s.tracking_number,
        tracking_url: s.tracking_url,
        estimated_delivery: s.estimated_delivery,
        dispatched_at: s.dispatched_at,
        delivered_at: s.delivered_at,
        exception_code: s.exception_code,
        exception_note: s.exception_note,
        // Only what is needed to post a parcel. Deliberately not the order
        // total, the discount or the payment reference.
        deliver_to: {
          name: addr.fullName ?? null,
          street: addr.street ?? null,
          city: addr.city ?? null,
          state: addr.state ?? null,
          postcode: addr.zipCode ?? null,
          country: addr.country ?? null,
        },
        items: mine.map((i: any) => ({
          id: i.id,
          title: i.product_variants?.products?.title ?? 'Item',
          color: i.product_variants?.color ?? null,
          sku: i.product_variants?.sku ?? null,
          image: i.product_variants?.images?.[0] ?? null,
          quantity: i.quantity,
          item_status: i.item_status,
        })),
        item_count: mine.reduce((n: number, i: any) => n + (i.quantity ?? 0), 0),
        // What this shipment is worth to THEM, not the order total.
        value: Number(mine.reduce((n: number, i: any) => n + Number(i.total_price ?? 0), 0).toFixed(2)),
      };
    });

    // Counts from the same source as the rows, so a tab can never claim a
    // number the list fails to produce.
    const { data: allStatuses } = await supabase
      .from('order_shipments')
      .select('shipment_status')
      .in('retailer_id', retailerIds);

    const counts = { to_fulfil: 0, shipped: 0, delivered: 0, all: 0 };
    for (const r of (allStatuses || []) as any[]) {
      counts.all += 1;
      if (['label_pending', 'label_created'].includes(r.shipment_status)) counts.to_fulfil += 1;
      else if (['in_transit', 'out_for_delivery'].includes(r.shipment_status)) counts.shipped += 1;
      else if (r.shipment_status === 'delivered') counts.delivered += 1;
    }

    return res.status(200).json({
      success: true,
      data: { shipments: shaped, counts, carriers: Object.keys(CARRIERS) },
    });
  } catch (err) {
    console.error('getVendorOrders error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getVendorShipment(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user?.id;
    const shipmentId = req.params.shipmentId as string;
    if (!vendorId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const retailerIds = await vendorRetailerIds(vendorId);

    const { data: shipment, error } = await supabase
      .from('order_shipments')
      .select(`
        *,
        orders ( order_number, created_at, shipping_address ),
        order_tracking_events ( id, status, location, description, timestamp )
      `)
      .eq('id', shipmentId)
      .in('retailer_id', retailerIds)   // scoping, not filtering
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });
    // Not found and not yours are the same answer on purpose — otherwise the
    // response tells a vendor whether someone else's shipment id is real.
    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    const { data: items } = await supabase
      .from('order_items')
      .select(`
        id, quantity, unit_price, total_price, item_status,
        product_variants ( sku, color, material, images, products ( title ) )
      `)
      .eq('order_id', shipment.order_id)
      .eq('retailer_id', shipment.retailer_id);

    return res.status(200).json({
      success: true,
      data: { shipment, items: items || [], carriers: CARRIERS },
    });
  } catch (err) {
    console.error('getVendorShipment error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Mark a shipment dispatched.
 *
 * This is the moment a tracking number comes into existence. Before it, the
 * shipment has none and carrier polling correctly ignores it; after, polling
 * picks it up on the next run.
 *
 * Conditional on the shipment still being pre-dispatch, so two people in the
 * same warehouse cannot both dispatch it and overwrite each other's tracking
 * number.
 */
export async function dispatchShipment(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user?.id;
    const shipmentId = req.params.shipmentId as string;
    const { carrier_code, tracking_number, service_code } = req.body || {};

    if (!vendorId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const carrier = String(carrier_code || '').toUpperCase();
    if (!CARRIERS[carrier]) {
      return res.status(400).json({
        success: false,
        error: `Carrier must be one of: ${Object.keys(CARRIERS).join(', ')}`,
      });
    }

    const tracking = String(tracking_number || '').trim();
    if (!tracking) {
      return res.status(400).json({ success: false, error: 'A tracking number is required' });
    }
    // Carriers vary, so this is a sanity check rather than a format rule — but
    // a two-character entry is a mistake, and polling it forever helps nobody.
    if (tracking.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'That tracking number looks too short. Check it and try again.',
      });
    }

    const retailerIds = await vendorRetailerIds(vendorId);

    const { data: updated, error } = await supabase
      .from('order_shipments')
      .update({
        carrier_code: carrier,
        tracking_number: tracking,
        service_code: service_code || null,
        tracking_url: CARRIERS[carrier].trackingUrl(tracking) || null,
        shipment_status: 'in_transit',
        dispatched_at: new Date().toISOString(),
        // A redispatch clears any previous exception and poll history — this is
        // effectively a new parcel as far as the carrier is concerned.
        exception_code: null,
        exception_note: null,
        poll_failures: 0,
        last_polled_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', shipmentId)
      .in('retailer_id', retailerIds)
      .in('shipment_status', ['label_pending', 'label_created'])
      .select('id, shipment_status, carrier_code, tracking_number, tracking_url, order_id, retailer_id')
      .maybeSingle();

    if (error) return res.status(400).json({ success: false, error: error.message });

    if (!updated) {
      // Either not theirs, or already dispatched. Distinguish, because the
      // second is routine and the first is not.
      const { data: existing } = await supabase
        .from('order_shipments')
        .select('shipment_status')
        .eq('id', shipmentId)
        .in('retailer_id', retailerIds)
        .maybeSingle();

      if (!existing) {
        return res.status(404).json({ success: false, error: 'Shipment not found' });
      }
      return res.status(409).json({
        success: false,
        error: `This shipment is already ${String(existing.shipment_status).replace(/_/g, ' ')}.`,
      });
    }

    // Their items are on the way too.
    await supabase
      .from('order_items')
      .update({ item_status: 'shipped' })
      .eq('order_id', updated.order_id)
      .eq('retailer_id', updated.retailer_id)
      .not('item_status', 'in', '("returned","cancelled")');

    // First event on the timeline. Carrier scans will add to it from here.
    await supabase.from('order_tracking_events').insert({
      shipment_id: shipmentId,
      status: 'in_transit',
      description: `Dispatched with ${CARRIERS[carrier].name}`,
      timestamp: new Date().toISOString(),
    });

    await notifyCustomerOfShipment(updated.order_id, updated.retailer_id, 'in_transit', {
      carrier: CARRIERS[carrier].name, tracking,
    });

    return res.status(200).json({
      success: true,
      data: updated,
      message: `Dispatched with ${CARRIERS[carrier].name}`,
    });
  } catch (err) {
    console.error('dispatchShipment error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Move a shipment along by hand.
 *
 * Carrier polling will do this automatically once NOOI-61 lands, but a vendor
 * delivering their own goods, or using a carrier Nooi cannot poll, needs to say
 * so. Forward only: a delivered parcel does not become in-transit because
 * someone picked the wrong row.
 */
export async function advanceShipmentStatus(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user?.id;
    const shipmentId = req.params.shipmentId as string;
    const { status, note } = req.body || {};

    if (!vendorId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const target = String(status || '');
    const targetIndex = PROGRESSION.indexOf(target as typeof PROGRESSION[number]);
    if (targetIndex === -1) {
      return res.status(400).json({
        success: false,
        error: `Status must be one of: ${PROGRESSION.join(', ')}`,
      });
    }

    const retailerIds = await vendorRetailerIds(vendorId);

    const { data: current } = await supabase
      .from('order_shipments')
      .select('id, shipment_status, order_id, retailer_id')
      .eq('id', shipmentId)
      .in('retailer_id', retailerIds)
      .maybeSingle();

    if (!current) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    const currentIndex = PROGRESSION.indexOf(current.shipment_status as typeof PROGRESSION[number]);
    if (currentIndex === -1) {
      return res.status(409).json({
        success: false,
        error: `A ${current.shipment_status} shipment cannot be moved from here.`,
      });
    }
    if (targetIndex <= currentIndex) {
      return res.status(409).json({
        success: false,
        error: `This shipment is already ${String(current.shipment_status).replace(/_/g, ' ')}.`,
      });
    }

    const patch: Record<string, any> = {
      shipment_status: target,
      updated_at: new Date().toISOString(),
    };
    if (target === 'delivered') patch.delivered_at = new Date().toISOString();

    const { error } = await supabase
      .from('order_shipments')
      .update(patch)
      .eq('id', shipmentId)
      .in('retailer_id', retailerIds);

    if (error) return res.status(400).json({ success: false, error: error.message });

    if (target === 'delivered') {
      await supabase
        .from('order_items')
        .update({ item_status: 'delivered' })
        .eq('order_id', current.order_id)
        .eq('retailer_id', current.retailer_id)
        .not('item_status', 'in', '("returned","cancelled")');
    }

    // Delivered + approved order = the vendor's share becomes payable.
    if (target === 'delivered') await releaseEarnings(current.order_id);

    await supabase.from('order_tracking_events').insert({
      shipment_id: shipmentId,
      status: target,
      description: note ? String(note).slice(0, 200) : `Marked ${target.replace(/_/g, ' ')} by vendor`,
      timestamp: new Date().toISOString(),
    });

    await notifyCustomerOfShipment(current.order_id, current.retailer_id, target);

    return res.status(200).json({
      success: true,
      data: { shipment_status: target },
      message: `Shipment marked ${target.replace(/_/g, ' ')}`,
    });
  } catch (err) {
    console.error('advanceShipmentStatus error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
// ════════════════════════════════════════════════════════════════════════════
// Earnings and payouts
// ════════════════════════════════════════════════════════════════════════════

/**
 * router.get('/payments', requireVendor, getVendorPayments)
 * Balance, the ledger lines (most recent first) and payout history.
 * Amounts in SAR; the ledger itself is in halalas.
 */
export async function getVendorPayments(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user!.id;
    await releaseEarnings();

    const [{ data: rows, error }, { data: payouts }, { data: acct }, { data: rates }] = await Promise.all([
      supabase.from('vendor_earnings')
        .select('id, order_id, order_item_id, kind, gross_minor, commission_rate, commission_minor, net_minor, status, payout_id, created_at, payable_at, paid_at, note, orders ( order_number, approved_at )')
        .eq('vendor_id', vendorId)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('vendor_payouts')
        .select('id, amount_minor, currency, status, sequence_number, channel, failure_reason, created_at, paid_at, destination')
        .eq('vendor_id', vendorId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('vendor_payout_accounts').select('*').eq('vendor_id', vendorId).maybeSingle(),
      supabase.from('retailers').select('name, commission_rate').eq('vendor_id', vendorId),
    ]);
    if (error) return res.status(400).json({ success: false, error: error.message });

    const sum = summarise((rows || []) as any);
    const lines = (rows || []).map((r: any) => ({
      id: r.id,
      order_id: r.order_id,
      order_number: r.orders?.order_number ?? null,
      kind: r.kind,
      gross: fromMinor(Number(r.gross_minor)),
      commission_rate: Number(r.commission_rate),
      commission: fromMinor(Number(r.commission_minor)),
      net: fromMinor(Number(r.net_minor)),
      status: r.status,
      // Why a pending line is not payable yet — the question vendors ask.
      waiting_for: r.status !== 'pending' ? null
        : !r.orders?.approved_at ? 'approval' : 'delivery',
      created_at: r.created_at,
      payable_at: r.payable_at,
      paid_at: r.paid_at,
      note: r.note,
    }));

    return res.json({
      success: true,
      data: {
        currency: 'SAR',
        hold_days: await payoutHoldDays(),
        balance: {
          pending: fromMinor(sum.pending_minor),
          payable: fromMinor(sum.payable_minor),
          in_payout: fromMinor(sum.in_payout_minor),
          paid: fromMinor(sum.paid_minor),
          gross_sales: fromMinor(sum.gross_minor),
          commission: fromMinor(sum.commission_minor),
        },
        commission_rates: rates || [],
        account: acct ? {
          account_holder: acct.account_holder, iban_masked: maskIban(acct.iban), bank_name: acct.bank_name,
          city: acct.city, mobile: acct.mobile, verified: Boolean(acct.verified_at),
        } : null,
        lines,
        payouts: (payouts || []).map((p: any) => ({
          ...p, amount: fromMinor(Number(p.amount_minor)),
          destination: { name: p.destination?.name, iban: maskIban(p.destination?.iban || '') },
        })),
      },
    });
  } catch (err) {
    console.error('getVendorPayments error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** router.get('/payout-account', requireVendor, getVendorPayoutAccount) */
export async function getVendorPayoutAccount(req: AuthRequest, res: Response) {
  const { data } = await supabase.from('vendor_payout_accounts').select('*').eq('vendor_id', req.user!.id).maybeSingle();
  return res.json({
    success: true,
    data: { account: data ? {
      account_holder: data.account_holder, iban_masked: maskIban(data.iban), bank_name: data.bank_name,
      mobile: data.mobile, city: data.city, verified: Boolean(data.verified_at), updated_at: data.updated_at,
    } : null },
  });
}

/**
 * router.put('/payout-account', requireVendor, saveVendorPayoutAccount)
 * body: { account_holder, iban, bank_name?, mobile, city }
 *
 * Changing the IBAN or holder clears verification: payouts stop until an
 * admin re-checks it. That is the guard against a stolen vendor login
 * redirecting money.
 */
export async function saveVendorPayoutAccount(req: AuthRequest, res: Response) {
  try {
    const vendorId = req.user!.id;
    const b = req.body || {};
    const iban = normaliseSaudiIban(b.iban);
    const holder = String(b.account_holder || '').trim().slice(0, 140);
    const mobile = String(b.mobile || '').replace(/[\s-]/g, '').slice(0, 20);
    const city = String(b.city || '').trim().slice(0, 80);
    const bank = String(b.bank_name || '').trim().slice(0, 80) || null;

    if (!iban) return res.status(400).json({ success: false, error: 'Enter a valid Saudi IBAN (SA followed by 22 digits).' });
    if (holder.length < 2) return res.status(400).json({ success: false, error: 'Enter the account holder name exactly as the bank has it.' });
    if (!/^\+?\d{9,15}$/.test(mobile)) return res.status(400).json({ success: false, error: 'Enter a mobile number, e.g. +9665XXXXXXXX.' });
    if (!city) return res.status(400).json({ success: false, error: 'Enter the city of the bank account.' });

    const { data: prev } = await supabase.from('vendor_payout_accounts').select('*').eq('vendor_id', vendorId).maybeSingle();
    const sameAccount = Boolean(prev && prev.iban === iban && prev.account_holder === holder);
    const now = new Date().toISOString();
    const row = {
      vendor_id: vendorId, account_holder: holder, iban, bank_name: bank, mobile, city, country: 'SA',
      verified_at: sameAccount ? prev!.verified_at : null,
      verified_by: sameAccount ? prev!.verified_by : null,
      updated_at: now,
    };
    const { error } = await supabase.from('vendor_payout_accounts').upsert(row, { onConflict: 'vendor_id' });
    if (error) return res.status(400).json({ success: false, error: error.message });
    await supabase.from('vendor_profiles').update({ payout_connected: Boolean(row.verified_at) }).eq('id', vendorId);
    if (!row.verified_at) {
      const { data: vp } = await supabase.from('vendor_profiles').select('store_name, business_name').eq('id', vendorId).maybeSingle();
      await notifyAdmins({
        title: 'Bank account to verify',
        message: `${vp?.store_name || vp?.business_name || 'A vendor'} added a payout account (${maskIban(iban)}). Check it against their documents before the next payout.`,
        type: 'admin', link: links.admin('payouts'),
      });
    }

    return res.json({
      success: true,
      data: { account: { account_holder: holder, iban_masked: maskIban(iban), bank_name: bank, mobile, city, verified: Boolean(row.verified_at) } },
      message: row.verified_at ? 'Saved' : 'Saved. Nooi will verify this account before your next payout.',
    });
  } catch (err) {
    console.error('saveVendorPayoutAccount error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * Tell the customer their shipment moved: shipped (with tracking), out for
 * delivery, delivered. Also used when Nooi confirms a delivery by hand.
 */
export async function notifyCustomerOfShipment(
  orderId: string, retailerId: string, status: string,
  extra: { carrier?: string; tracking?: string; byNooi?: boolean } = {},
) {
  try {
    const [{ data: order }, { data: retailer }] = await Promise.all([
      supabase.from('orders').select('order_number, user_id').eq('id', orderId).maybeSingle(),
      supabase.from('retailers').select('name').eq('id', retailerId).maybeSingle(),
    ]);
    if (!order?.user_id) return;
    const from = retailer?.name ? ` from ${retailer.name}` : '';
    const msg: Record<string, { title: string; message: string }> = {
      label_created: {
        title: `Your items${from} are being packed`,
        message: `Part of order ${order.order_number} is being prepared for shipping.`,
      },
      in_transit: {
        title: `Your items${from} have shipped`,
        message: extra.carrier
          ? `Order ${order.order_number} is on its way with ${extra.carrier}${extra.tracking ? ` — tracking ${extra.tracking}` : ''}.`
          : `Order ${order.order_number} is on its way.`,
      },
      out_for_delivery: {
        title: `Out for delivery today${from}`,
        message: `Part of order ${order.order_number} is out for delivery. Someone should be available to receive it.`,
      },
      delivered: {
        title: `Delivered${from}`,
        message: `Part of order ${order.order_number} has been delivered${extra.byNooi ? ' (confirmed by Nooi)' : ''}. If anything is wrong, you can request a return from the order page.`,
      },
    };
    const m = msg[status];
    if (!m) return;
    await notify(order.user_id, { ...m, type: 'shipment', link: links.order(orderId) });
  } catch (e: any) {
    console.warn('[notify] shipment notification failed:', e?.message || e);
  }
}
