/**
 * Tax invoices — services/invoice.service.ts
 * ============================================================================
 * Nooi sells as the merchant of record, so every order gets ONE invoice from
 * Nooi, carrying Nooi's legal name, VAT and CR numbers (admin → Settings),
 * however many vendors ship it.
 *
 * Issued on first request (the Documents tab or the order page), never twice:
 * invoices.order_id is unique, and the number comes from a sequence, so a
 * second call returns the invoice already issued.
 *
 * The QR code is ZATCA's phase-1 (simplified invoice) payload: five TLV fields
 * — seller name, VAT number, timestamp, total with VAT, VAT — base64 encoded.
 * Phase-2 integration (cryptographic stamp, reporting to Fatoora) is a
 * separate project and is not done here.
 */

import { supabase } from './supabase';
import { getSettings, type PlatformSettings } from './settings.service';

export const VAT_RATE_PERCENT = 15;

export class InvoiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InvoiceError';
    this.status = status;
  }
}

const money = (n: unknown) => Number(Number(n || 0).toFixed(2));

/** ZATCA phase-1 TLV → base64. Lengths are UTF-8 byte lengths (Arabic names). */
export function zatcaTlv(fields: {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: number | string;
  vat: number | string;
}): string {
  const values = [
    fields.sellerName,
    fields.vatNumber,
    fields.timestamp,
    Number(fields.total).toFixed(2),
    Number(fields.vat).toFixed(2),
  ];
  const parts: Buffer[] = [];
  values.forEach((v, i) => {
    const bytes = Buffer.from(String(v), 'utf8');
    if (bytes.length > 255) throw new InvoiceError(`Invoice field ${i + 1} is too long for the QR code.`);
    parts.push(Buffer.from([i + 1, bytes.length]), bytes);
  });
  return Buffer.concat(parts).toString('base64');
}

/** Decode a TLV payload — used by the tests and handy when checking a QR. */
export function readZatcaTlv(b64: string): string[] {
  const buf = Buffer.from(b64, 'base64');
  const out: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i + 1];
    out[buf[i] - 1] = buf.subarray(i + 2, i + 2 + len).toString('utf8');
    i += 2 + len;
  }
  return out;
}

export interface InvoiceLine {
  title: string;
  sku: string | null;
  vendor: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}

export interface InvoiceDraft {
  order_id: string;
  user_id: string | null;
  kind: 'simplified';
  supply_date: string | null;
  seller: { legal_name: string; vat_number: string; cr_number: string | null; address: string | null };
  buyer: { name: string | null; address: string | null };
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  shipping: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  currency: string;
}

/** Pure: an order row (with items) + Nooi's settings → the invoice to store. */
export function buildInvoice(order: any, settings: Pick<PlatformSettings, 'legal_name' | 'vat_number' | 'cr_number' | 'legal_address'>): InvoiceDraft {
  if (!settings.vat_number || !settings.legal_name) {
    throw new InvoiceError(
      "Invoices aren't available yet: Nooi's legal name and VAT number must be set in Admin → Settings.",
      409,
    );
  }
  const vendorNames = new Map<string, string>();
  for (const s of order.order_shipments ?? []) {
    if (s.retailer_id && s.retailers?.name) vendorNames.set(s.retailer_id, s.retailers.name);
  }
  const lines: InvoiceLine[] = (order.order_items ?? []).map((it: any) => ({
    title: [it.product_variants?.products?.title || it.title || 'Item', it.config_label].filter(Boolean).join(' — '),
    sku: it.product_variants?.sku ?? null,
    vendor: vendorNames.get(it.retailer_id) ?? null,
    quantity: Number(it.quantity || 0),
    unit_price: money(it.unit_price),
    total: money(it.total_price ?? Number(it.unit_price) * Number(it.quantity)),
  }));
  const a = order.shipping_address || {};
  const address = [a.street, a.city, a.state, a.zipCode, a.country].filter(Boolean).join(', ') || null;
  return {
    order_id: order.id,
    user_id: order.user_id ?? null,
    kind: 'simplified',
    supply_date: order.created_at ?? null,
    seller: {
      legal_name: settings.legal_name,
      vat_number: settings.vat_number,
      cr_number: settings.cr_number ?? null,
      address: settings.legal_address ?? null,
    },
    buyer: { name: a.fullName || null, address },
    lines,
    subtotal: money(order.subtotal),
    discount: money(order.discount_amount),
    shipping: money(order.shipping_amount),
    vat_rate: VAT_RATE_PERCENT,
    vat_amount: money(order.tax_amount),
    total: money(order.total_amount),
    currency: String(order.currency || 'SAR').toUpperCase(),
  };
}

const ORDER_FOR_INVOICE = `
  id, order_number, user_id, status, subtotal, tax_amount, shipping_amount,
  discount_amount, total_amount, currency, shipping_address, created_at,
  order_items ( id, retailer_id, quantity, unit_price, total_price, config_label,
    product_variants ( sku, products ( title ) ) ),
  order_shipments ( retailer_id, retailers ( name ) )
`;

const INVOICE_COLUMNS = `
  id, invoice_number, order_id, user_id, kind, issued_at, supply_date, seller,
  buyer, lines, subtotal, discount, shipping, vat_rate, vat_amount, total,
  currency, qr_tlv
`;

/**
 * The invoice for this order, issuing it on first call. Only the buyer (or an
 * admin, with `asAdmin`) can get it.
 */
export async function invoiceForOrder(orderId: string, userId: string, asAdmin = false) {
  const { data: order, error } = await supabase
    .from('orders').select(ORDER_FOR_INVOICE).eq('id', orderId).maybeSingle();
  if (error) throw new InvoiceError(error.message, 500);
  if (!order) throw new InvoiceError('Order not found', 404);
  if ((order as any).user_id !== userId && !asAdmin) throw new InvoiceError('Order not found', 404);

  const { data: existing } = await supabase
    .from('invoices').select(INVOICE_COLUMNS).eq('order_id', orderId).maybeSingle();
  if (existing) return { ...existing, order_number: (order as any).order_number };

  const draft = buildInvoice(order, await getSettings());
  const issuedAt = new Date().toISOString();
  const qr_tlv = zatcaTlv({
    sellerName: draft.seller.legal_name,
    vatNumber: draft.seller.vat_number,
    timestamp: issuedAt.replace(/\.\d{3}Z$/, 'Z'),
    total: draft.total,
    vat: draft.vat_amount,
  });

  const { data: created, error: insErr } = await supabase
    .from('invoices').insert({ ...draft, issued_at: issuedAt, qr_tlv }).select(INVOICE_COLUMNS).single();
  if (insErr) {
    // Someone else issued it a moment ago (unique order_id) — return theirs.
    const { data: again } = await supabase
      .from('invoices').select(INVOICE_COLUMNS).eq('order_id', orderId).maybeSingle();
    if (again) return { ...again, order_number: (order as any).order_number };
    throw new InvoiceError(insErr.message, 500);
  }
  return { ...created, order_number: (order as any).order_number };
}

/**
 * Every order this user has, with its invoice if one is issued. The Documents
 * tab lists these; opening one issues the invoice.
 */
export async function documentsForUser(userId: string) {
  const [{ data: orders, error }, { data: invoices }] = await Promise.all([
    supabase.from('orders')
      .select('id, order_number, total_amount, currency, created_at, status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase.from('invoices')
      .select('id, invoice_number, order_id, issued_at, total, currency')
      .eq('user_id', userId),
  ]);
  if (error) throw new InvoiceError(error.message, 500);
  const byOrder = new Map((invoices ?? []).map((i: any) => [i.order_id, i]));
  return (orders ?? []).map((o: any) => ({ ...o, invoice: byOrder.get(o.id) ?? null }));
}
