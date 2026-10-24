/**
 * Vendor earnings maths — pure, no database. services/payments/ledger.ts
 * ============================================================================
 * Everything is integer minor units (halalas: 1 SAR = 100). Floats only at
 * the edges, converted once with toMinor().
 *
 * What a vendor earns on an order, by policy:
 *   - each item: its price × quantity, less Nooi's commission
 *     (retailers.commission_rate, a percentage, taken at order time);
 *   - their shipping charge on the order, in full — the vendor ships it.
 *     No commission on shipping.
 *   - VAT is NOT the vendor's: Nooi collected it as the seller of record and
 *     remits it. (Confirm with your accountant if vendors invoice VAT
 *     themselves — then add the VAT share here.)
 *   - Promo discounts are funded by Nooi: the vendor is paid on the
 *     undiscounted price.
 */

export const toMinor = (amount: number | string | null | undefined): number =>
  Math.round(Number(amount || 0) * 100);

export const fromMinor = (minor: number): number => Number((minor / 100).toFixed(2));

/** Commission on a gross amount. Rounded half-up to the halala, never negative. */
export function commissionOn(grossMinor: number, ratePercent: number): number {
  const rate = Math.min(Math.max(Number(ratePercent) || 0, 0), 100);
  return Math.max(0, Math.round((grossMinor * rate) / 100));
}

export interface LedgerItem {
  order_item_id: string;
  retailer_id: string;
  total_price: number;          // major units, as stored on order_items
}

export interface LedgerShipment {
  shipment_id: string;
  retailer_id: string;
  shipping_amount: number;      // major units, from the checkout snapshot
}

export interface LedgerRetailer {
  id: string;
  vendor_id: string | null;
  commission_rate: number | string | null;
}

export interface EarningRow {
  vendor_id: string;
  retailer_id: string;
  order_id: string;
  order_item_id: string | null;
  shipment_id: string | null;
  kind: 'sale' | 'shipping';
  currency: string;
  gross_minor: number;
  commission_rate: number;
  commission_minor: number;
  net_minor: number;
  status: 'pending';
}

/**
 * The earnings rows for one paid order. Items from storefronts with no vendor
 * account (ingested partner catalogues) earn nothing here — there is no one
 * to pay out to.
 */
export function buildEarnings(args: {
  orderId: string;
  currency: string;
  items: LedgerItem[];
  shipments: LedgerShipment[];
  retailers: LedgerRetailer[];
}): EarningRow[] {
  const byId = new Map(args.retailers.map(r => [r.id, r]));
  const shipmentFor = new Map(args.shipments.map(s => [s.retailer_id, s.shipment_id]));
  const rows: EarningRow[] = [];

  for (const it of args.items) {
    const r = byId.get(it.retailer_id);
    if (!r?.vendor_id) continue;
    const rate = Number(r.commission_rate ?? 0);
    const gross = toMinor(it.total_price);
    const commission = commissionOn(gross, rate);
    rows.push({
      vendor_id: r.vendor_id, retailer_id: r.id, order_id: args.orderId,
      order_item_id: it.order_item_id, shipment_id: shipmentFor.get(r.id) ?? null,
      kind: 'sale', currency: args.currency, gross_minor: gross,
      commission_rate: rate, commission_minor: commission, net_minor: gross - commission,
      status: 'pending',
    });
  }

  for (const s of args.shipments) {
    const r = byId.get(s.retailer_id);
    const gross = toMinor(s.shipping_amount);
    if (!r?.vendor_id || gross <= 0) continue;
    rows.push({
      vendor_id: r.vendor_id, retailer_id: r.id, order_id: args.orderId,
      order_item_id: null, shipment_id: s.shipment_id,
      kind: 'shipping', currency: args.currency, gross_minor: gross,
      commission_rate: 0, commission_minor: 0, net_minor: gross,
      status: 'pending',
    });
  }
  return rows;
}

export type EarningStatus = 'pending' | 'payable' | 'in_payout' | 'paid' | 'reversed';

/** A vendor's position, from their ledger rows. */
export function summarise(rows: { status: EarningStatus; net_minor: number; gross_minor: number; commission_minor: number; kind: string }[]) {
  const sum = (pred: (r: typeof rows[number]) => boolean, f: 'net_minor' | 'gross_minor' | 'commission_minor' = 'net_minor') =>
    rows.filter(pred).reduce((a, r) => a + Number(r[f]), 0);
  const live = (r: typeof rows[number]) => r.status !== 'reversed';
  return {
    /** Sold, not yet released (awaiting approval / delivery). */
    pending_minor:   sum(r => r.status === 'pending'),
    /** Released, will go in the next payout. Can be negative after a refund. */
    payable_minor:   sum(r => r.status === 'payable'),
    in_payout_minor: sum(r => r.status === 'in_payout'),
    paid_minor:      sum(r => r.status === 'paid'),
    gross_minor:      sum(live, 'gross_minor'),
    commission_minor: sum(live, 'commission_minor'),
  };
}

// ── IBAN ───────────────────────────────────────────────────────────────────

/** Normalise and validate a Saudi IBAN (SA + 22 digits, ISO 13616 mod-97). */
export function normaliseSaudiIban(raw: string): string | null {
  const iban = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? iban : null;
}

export const maskIban = (iban: string) =>
  iban ? `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}` : '';
