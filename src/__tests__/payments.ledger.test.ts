/**
 * Vendor earnings maths and IBAN checks — pure functions, no database.
 */
import {
  buildEarnings, commissionOn, summarise, toMinor, fromMinor, normaliseSaudiIban, maskIban,
} from '../services/payments/ledger';

describe('Payments ledger maths', () => {
  it('converts SAR to halalas without float drift', () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor('2760.00')).toBe(276000);
    expect(toMinor(19.995)).toBe(2000);
    expect(fromMinor(276000)).toBe(2760);
  });

  it('takes commission to the halala, half up, clamped to 0–100%', () => {
    expect(commissionOn(240000, 10)).toBe(24000);
    expect(commissionOn(999, 12.5)).toBe(125);      // 124.875 → 125
    expect(commissionOn(1000, -5)).toBe(0);
    expect(commissionOn(1000, 150)).toBe(1000);
  });

  const retailers = [
    { id: 'r-vendor', vendor_id: 'v-1', commission_rate: '10.00' },
    { id: 'r-partner', vendor_id: null, commission_rate: 8 },
  ];

  it('credits each item net of commission, and shipping in full', () => {
    const rows = buildEarnings({
      orderId: 'o-1', currency: 'SAR',
      items: [
        { order_item_id: 'i-1', retailer_id: 'r-vendor', total_price: 2400 },
        { order_item_id: 'i-2', retailer_id: 'r-vendor', total_price: 199.99 },
      ],
      shipments: [{ shipment_id: 's-1', retailer_id: 'r-vendor', shipping_amount: 50 }],
      retailers,
    });
    expect(rows).toHaveLength(3);
    const [a, b, ship] = rows;
    expect(a).toMatchObject({ kind: 'sale', gross_minor: 240000, commission_minor: 24000, net_minor: 216000, shipment_id: 's-1', vendor_id: 'v-1' });
    expect(b).toMatchObject({ gross_minor: 19999, commission_minor: 2000, net_minor: 17999 });
    expect(ship).toMatchObject({ kind: 'shipping', gross_minor: 5000, commission_minor: 0, net_minor: 5000, order_item_id: null });
    for (const r of rows) expect(r.net_minor).toBe(r.gross_minor - r.commission_minor);
  });

  it('pays nobody for partner catalogues without a vendor account, or for free shipping', () => {
    const rows = buildEarnings({
      orderId: 'o-2', currency: 'SAR',
      items: [{ order_item_id: 'i-3', retailer_id: 'r-partner', total_price: 500 }],
      shipments: [
        { shipment_id: 's-2', retailer_id: 'r-partner', shipping_amount: 30 },
        { shipment_id: 's-3', retailer_id: 'r-vendor', shipping_amount: 0 },
      ],
      retailers,
    });
    expect(rows).toEqual([]);
  });

  it('summarises a balance, netting a reversal against payable money', () => {
    const s = summarise([
      { kind: 'sale', status: 'pending', gross_minor: 10000, commission_minor: 1000, net_minor: 9000 },
      { kind: 'sale', status: 'payable', gross_minor: 20000, commission_minor: 2000, net_minor: 18000 },
      { kind: 'reversal', status: 'payable', gross_minor: -5000, commission_minor: -500, net_minor: -4500 },
      { kind: 'sale', status: 'paid', gross_minor: 5000, commission_minor: 500, net_minor: 4500 },
      { kind: 'sale', status: 'reversed', gross_minor: 7000, commission_minor: 700, net_minor: 6300 },
    ] as any);
    expect(s.pending_minor).toBe(9000);
    expect(s.payable_minor).toBe(13500);
    expect(s.paid_minor).toBe(4500);
    // reversed lines are not sales; reversal rows cancel the paid one
    expect(s.gross_minor).toBe(30000);
    expect(s.commission_minor).toBe(3000);
  });
});

describe('Saudi IBAN', () => {
  // A structurally valid test IBAN (mod-97 = 1).
  const VALID = 'SA0380000000608010167519';

  it('accepts a valid IBAN in any spacing or case', () => {
    expect(normaliseSaudiIban(VALID)).toBe(VALID);
    expect(normaliseSaudiIban('sa03 8000 0000 6080 1016 7519')).toBe(VALID);
  });

  it('rejects a mistyped digit, wrong country or wrong length', () => {
    expect(normaliseSaudiIban('SA0380000000608010167518')).toBeNull();
    expect(normaliseSaudiIban('AE070331234567890123456')).toBeNull();
    expect(normaliseSaudiIban('SA03800000006080101675')).toBeNull();
    expect(normaliseSaudiIban('')).toBeNull();
  });

  it('masks all but the ends', () => {
    expect(maskIban(VALID)).toBe('SA03 •••• •••• 7519');
  });
});
