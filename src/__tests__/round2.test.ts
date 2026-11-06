jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn() } }));

import { cleanOptionGroups, cleanPricing, configKey, normalizeConfig, priceLine } from '../services/configure';
import { cleanKitchenPrices, DEFAULT_KITCHEN_PRICES, quoteKitchen } from '../services/kitchenPricing';
import { validateSettingsPatch } from '../services/settings.service';
import { listingForPricing } from '../services/listingPricing';

const sofa = {
  price_unit: 'metre' as const, min_width_cm: 160, max_width_cm: 400, width_cm: 240,
  options: cleanOptionGroups([
    { name: 'Fabric', kind: 'fabric', choices: [{ name: 'Linen' }, { name: 'Velvet green', code: 'VG-12', hex: '#2F5D4A', price_delta: 150 }] },
    { name: 'Legs', kind: 'legs', choices: [{ name: 'Oak' }, { name: 'Brass', price_delta: 40 }] },
  ]),
};

describe('configure: per-metre and options', () => {
  it('cleans vendor groups, with ids and swatches', () => {
    expect(sofa.options.map(g => g.id)).toEqual(['fabric', 'legs']);
    expect(sofa.options[0].choices[1]).toEqual({ id: 'velvet-green', name: 'Velvet green', code: 'VG-12', hex: '#2f5d4a', price_delta: 150 });
    expect(cleanOptionGroups([{ name: '', choices: [{ name: 'x' }] }, { name: 'Empty', choices: [] }])).toEqual([]);
  });

  it('prices per metre of width, deltas per metre too', () => {
    const r = priceLine(sofa, 1000, { width_cm: 300, options: { fabric: 'velvet-green', legs: 'brass' } });
    expect(r.ok && r.unit_price).toBe((1000 + 150 + 40) * 3);
    expect(r.ok && r.label).toBe('300 cm wide · Fabric: Velvet green (VG-12) · Legs: Brass');
  });

  it('defaults: the listed width and each group\'s first choice', () => {
    const r = priceLine(sofa, 1000, {});
    expect(r.ok && r.unit_price).toBe(2400);
    expect(r.ok && r.width_cm).toBe(240);
  });

  it('refuses widths outside the range and unknown choices', () => {
    expect(priceLine(sofa, 1000, { width_cm: 100 })).toMatchObject({ ok: false, error: 'WIDTH_OUT_OF_RANGE' });
    expect(priceLine(sofa, 1000, { options: { fabric: 'silk' } })).toMatchObject({ ok: false, error: 'OPTION_UNKNOWN' });
  });

  it('per-piece listings ignore width', () => {
    const chair = { price_unit: 'unit' as const, options: sofa.options };
    const r = priceLine(chair, 500, { width_cm: 999, options: { legs: 'brass' } });
    expect(r.ok && r.unit_price).toBe(540);
  });

  it('keys are stable and order-free', () => {
    const a = normalizeConfig({ width_cm: 240.4, options: { legs: 'brass', fabric: 'linen' } });
    const b = normalizeConfig({ options: { fabric: 'linen', legs: 'brass' }, width_cm: 240 });
    expect(configKey(a)).toBe('w240|fabric=linen|legs=brass');
    expect(configKey(a)).toBe(configKey(b));
    expect(configKey(normalizeConfig(null))).toBe('');
    expect(normalizeConfig({ options: { 'bad key!': 'x', ok: 'Not valid' } })).toEqual({});
  });

  it('pricing ranges default around the listed width', () => {
    expect(cleanPricing({ price_unit: 'metre' }, 200)).toEqual({ price_unit: 'metre', min_width_cm: 100, max_width_cm: 500 });
    expect(cleanPricing({ price_unit: 'metre', min_width_cm: 300, max_width_cm: 150 }, 200)).toEqual({ price_unit: 'metre', min_width_cm: 150, max_width_cm: 300 });
    expect(cleanPricing({ price_unit: 'unit', min_width_cm: 1 }, 200)).toEqual({ price_unit: 'unit', min_width_cm: null, max_width_cm: null });
  });

  it('reads a product row', () => {
    expect(listingForPricing({ price_unit: 'metre', min_width_cm: 1, options: null }, { dimensions_cm: { width: 210 } }))
      .toEqual({ price_unit: 'metre', min_width_cm: 1, max_width_cm: null, options: [], width_cm: 210 });
  });
});

describe('kitchen price list', () => {
  it('fills gaps with defaults and rejects junk', () => {
    const p = cleanKitchenPrices({ upper_per_m: '1500', hood_unit: -4, cabinet_per_m: { 'base-door': 2000, hacker: 1 }, install_percent: 500 });
    expect(p.upper_per_m).toBe(1500);
    expect(p.hood_unit).toBe(DEFAULT_KITCHEN_PRICES.hood_unit);
    expect(p.cabinet_per_m['base-door']).toBe(2000);
    expect((p.cabinet_per_m as any).hacker).toBeUndefined();
    expect(p.install_percent).toBe(DEFAULT_KITCHEN_PRICES.install_percent);
  });

  it('quotes per metre with VAT and fitting', () => {
    const q = quoteKitchen({
      runs: [{ modules: [{ kind: 'base-door', width: 0.6, upper: 'cabinet' }, { kind: 'oven-tower', width: 0.6, upper: null }] }],
      style: { frontStyle: 'slab', handleStyle: 'none', front: '#f6f4ef', countertop: 'granite-black', hardware: 'chrome' },
    }, DEFAULT_KITCHEN_PRICES);
    // 0.6×1600 + 0.6×3600 + 0.6×1300 + countertop 0.6×900 (not over the tower)
    expect(q.subtotal).toBe(960 + 2160 + 780 + 540);
    expect(q.install).toBe(Math.round(q.subtotal * 12) / 100);
    expect(q.total).toBe(Math.round((q.subtotal + q.install) * 1.15 * 100) / 100);
  });

  it('is accepted by the admin settings patch', () => {
    const v = validateSettingsPatch({ kitchen_prices: { upper_per_m: 1400 } });
    expect('patch' in v && v.patch.kitchen_prices?.upper_per_m).toBe(1400);
    expect(validateSettingsPatch({ kitchen_prices: 'cheap' })).toEqual({ error: 'Kitchen prices must be an object.' });
  });
});
