jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn(), storage: { from: jest.fn() } } }));
import {
  MAX_DRAWING_BYTES, SPEC_FIELDS, cleanDrawingRef, cleanSpec, drawingKind, drawingsOf, newDrawingPath, prefixFor, safeFileName, uploadProblem,
} from '../services/factory.service';

describe('factory drawings', () => {
  it('accepts DWG, DXF and PDF only', () => {
    expect(drawingKind('柜体图.DWG')).toBe('dwg');
    expect(drawingKind('plan.dxf')).toBe('dxf');
    expect(drawingKind('quote.pdf')).toBe('pdf');
    expect(drawingKind('photo.jpg')).toBeNull();
    expect(drawingKind('dwg')).toBeNull();
    expect(uploadProblem('a.exe', 10)).toMatch(/DWG, DXF or PDF/);
    expect(uploadProblem('a.dwg', 0)).toMatch(/empty/);
    expect(uploadProblem('a.dwg', MAX_DRAWING_BYTES + 1)).toMatch(/under 50 MB/);
    expect(uploadProblem('a.dwg', 6_700_000)).toBeNull();
  });

  it('keeps names storage-safe and the extension right', () => {
    expect(safeFileName('二层 卧室.dwg')).toBe('drawing.dwg');
    expect(safeFileName('Kitchen plan v2.PDF')).toBe('Kitchen-plan-v2.pdf');
    const p = newDrawingPath({ scope: 'order-item', orderId: 'o1', itemId: 'i1' }, 'x.dwg');
    expect(p).toMatch(/^orders\/o1\/i1\/[0-9a-f-]{36}\/x\.dwg$/);
  });

  it('only accepts a file uploaded under the expected place', () => {
    const who = { id: 'u1', role: 'customer' as const };
    const prefix = prefixFor({ scope: 'order-item', orderId: 'o1', itemId: 'i1' });
    const now = new Date('2026-11-22T00:00:00Z');
    expect(cleanDrawingRef({ path: 'orders/o1/i1/abc/x.dwg', name: '柜体图.dwg', size: 1000 }, prefix, who, now))
      .toEqual({ path: 'orders/o1/i1/abc/x.dwg', name: '柜体图.dwg', size: 1000, kind: 'dwg', uploaded_at: '2026-11-22T00:00:00.000Z', uploaded_by: 'u1', role: 'customer' });
    expect(cleanDrawingRef({ path: 'orders/o2/i9/abc/x.dwg', size: 1000 }, prefix, who)).toBeNull();
    expect(cleanDrawingRef({ path: 'orders/o1/i1/../../o2/x.dwg', size: 1000 }, prefix, who)).toBeNull();
    expect(cleanDrawingRef({ path: 'orders/o1/i1/abc/x.exe', size: 1000 }, prefix, who)).toBeNull();
    expect(cleanDrawingRef({ path: 'orders/o1/i1/abc/x.pdf', size: 0 }, prefix, who)).toBeNull();
    expect(prefixFor({ scope: 'listing-draft', userId: 'v1' })).toBe('listings/draft/v1/');
  });

  it('reads stored drawings defensively', () => {
    expect(drawingsOf(null)).toEqual([]);
    expect(drawingsOf([{ path: 'a/b.dwg' }, { path: 'a/b.jpg' }, null, 'x'])).toHaveLength(1);
  });
});

describe('factory spec', () => {
  it('keeps known fields as trimmed text and drops the rest', () => {
    const s = cleanSpec({ fields: { carcass: '  18 mm particleboard, white 505 ', hinges: 12, oops: 'x', back: '', notes: 'a'.repeat(3000) } });
    expect(s).toEqual({ carcass: '18 mm particleboard, white 505', hinges: '12', notes: 'a'.repeat(2000) });
    expect(cleanSpec({ doors: 'x'.repeat(500) }).doors).toHaveLength(300);
    expect(cleanSpec(null)).toEqual({});
  });
  it('has the factory form fields, each with a Chinese label', () => {
    expect(SPEC_FIELDS.map(f => f.key)).toEqual(expect.arrayContaining(['carcass', 'back', 'doors', 'hinges', 'handles', 'runners', 'fillers', 'kick', 'end_panels', 'install_on', 'notes']));
    expect(SPEC_FIELDS.every(f => f.zh.length > 0)).toBe(true);
  });
});
