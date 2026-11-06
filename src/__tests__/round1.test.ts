jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn() } }));

import { buildInvoice, readZatcaTlv, zatcaTlv, InvoiceError } from '../services/invoice.service';
import { missingFor, REQUIRED_BY_ROLE, TERMS_VERSIONS } from '../services/terms.service';
import { countryCode } from '../services/countries';

const settings = {
  legal_name: 'Nooi Trading Co.',
  vat_number: '310123456700003',
  cr_number: '1010101010',
  legal_address: 'Riyadh, Saudi Arabia',
};

const order = {
  id: 'o1',
  user_id: 'u1',
  subtotal: 2400,
  discount_amount: 100,
  shipping_amount: 50,
  tax_amount: 352.5,
  total_amount: 2702.5,
  currency: 'sar',
  created_at: '2026-11-01T10:00:00Z',
  shipping_address: { fullName: 'Sara A.', street: '12 King Fahd Rd', city: 'Riyadh', state: 'Riyadh', zipCode: '12211', country: 'SA' },
  order_items: [
    { retailer_id: 'r1', quantity: 2, unit_price: 900, total_price: 1800, product_variants: { sku: 'SOFA-1', products: { title: 'Oak sofa' } } },
    { retailer_id: 'r2', quantity: 1, unit_price: 600, total_price: 600, product_variants: { sku: 'TBL-1', products: { title: 'Side table' } } },
  ],
  order_shipments: [
    { retailer_id: 'r1', retailers: { name: 'Atelier Rawda' } },
    { retailer_id: 'r2', retailers: { name: 'Najd Works' } },
  ],
};

describe('ZATCA QR payload', () => {
  it('round-trips the five fields, Arabic included', () => {
    const b64 = zatcaTlv({ sellerName: 'نوي للتجارة', vatNumber: '310123456700003', timestamp: '2026-11-06T09:00:00Z', total: 2702.5, vat: 352.5 });
    expect(readZatcaTlv(b64)).toEqual(['نوي للتجارة', '310123456700003', '2026-11-06T09:00:00Z', '2702.50', '352.50']);
  });

  it('uses byte length, not character length', () => {
    const b64 = zatcaTlv({ sellerName: 'نوي', vatNumber: '3', timestamp: 't', total: 1, vat: 0 });
    const buf = Buffer.from(b64, 'base64');
    expect(buf[0]).toBe(1);
    expect(buf[1]).toBe(Buffer.byteLength('نوي', 'utf8'));
  });
});

describe('buildInvoice', () => {
  it('is issued by Nooi with one line per item and the order totals', () => {
    const inv = buildInvoice(order, settings);
    expect(inv.seller).toEqual({ legal_name: 'Nooi Trading Co.', vat_number: '310123456700003', cr_number: '1010101010', address: 'Riyadh, Saudi Arabia' });
    expect(inv.buyer.name).toBe('Sara A.');
    expect(inv.buyer.address).toContain('Riyadh');
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ title: 'Oak sofa', sku: 'SOFA-1', vendor: 'Atelier Rawda', quantity: 2, unit_price: 900, total: 1800 });
    expect(inv).toMatchObject({ subtotal: 2400, discount: 100, shipping: 50, vat_amount: 352.5, total: 2702.5, currency: 'SAR', vat_rate: 15 });
  });

  it('refuses without Nooi\'s VAT number', () => {
    expect(() => buildInvoice(order, { ...settings, vat_number: null as any })).toThrow(InvoiceError);
  });
});

describe('terms by role', () => {
  it('a client needs terms + privacy', () => {
    expect(missingFor('client', [])).toEqual(['terms', 'privacy']);
  });

  it('only the current version counts, and only for that role', () => {
    const rows = [
      { role: 'client', document: 'terms', version: TERMS_VERSIONS.terms },
      { role: 'client', document: 'privacy', version: 'old' },
      { role: 'vendor', document: 'privacy', version: TERMS_VERSIONS.privacy },
    ];
    expect(missingFor('client', rows)).toEqual(['privacy']);
    expect(missingFor('vendor', rows)).toEqual(['terms', 'vendor_agreement']);
  });

  it('factories sign the vendor agreement; employees the employee policy', () => {
    expect(REQUIRED_BY_ROLE.factory).toContain('vendor_agreement');
    expect(REQUIRED_BY_ROLE.employee).toContain('employee_policy');
    expect(REQUIRED_BY_ROLE.client).not.toContain('vendor_agreement');
  });
});

describe('countryCode', () => {
  it('reads codes and names', () => {
    expect(countryCode('sa')).toBe('SA');
    expect(countryCode('Saudi Arabia')).toBe('SA');
    expect(countryCode('KSA')).toBe('SA');
    expect(countryCode('United Arab Emirates')).toBe('AE');
    expect(countryCode('')).toBeNull();
    expect(countryCode('Atlantis')).toBeNull();
  });
});
