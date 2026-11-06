const rpc = jest.fn();
jest.mock('../services/supabase', () => ({ supabase: { rpc: (...a: any[]) => rpc(...a), from: jest.fn() } }));

import { cleanQuery, kindsFor, scopeForRole, searchPlatform } from '../services/search.service';

describe('platform search', () => {
  it('scope comes from the account, not the request', () => {
    expect(scopeForRole('admin', true)).toBe('admin');
    expect(scopeForRole('super_admin', true)).toBe('admin');
    expect(scopeForRole('vendor', true)).toBe('vendor');
    expect(scopeForRole('user', true)).toBe('client');
    expect(scopeForRole('admin', false)).toBe('public');
  });

  it('only kinds the scope may see', () => {
    expect(kindsFor('public', 'product,order,account')).toEqual(['product']);
    expect(kindsFor('public', undefined)).toEqual(['product', 'vendor']);
    expect(kindsFor('client', 'account')).toEqual(['product', 'vendor', 'project', 'order', 'invoice', 'ticket']);
    expect(kindsFor('admin', ['account', 'order'])).toEqual(['account', 'order']);
    expect(kindsFor('vendor', 'invoice')).not.toContain('invoice');
  });

  it('cleans the query', () => {
    expect(cleanQuery('  oak   sofa ')).toBe('oak sofa');
    expect(cleanQuery('a')).toBeNull();
    expect(cleanQuery(undefined)).toBeNull();
    expect(cleanQuery('x'.repeat(200))!.length).toBe(80);
  });

  it('groups hits in kind order, best first', async () => {
    rpc.mockResolvedValueOnce({ data: [
      { kind: 'vendor', id: 'v1', title: 'Atelier', score: 0.9 },
      { kind: 'product', id: 'p1', title: 'Sofa', score: 0.5 },
      { kind: 'product', id: 'p2', title: 'Oak sofa', score: 0.95 },
    ], error: null });
    const r = await searchPlatform('sofa', 'u1', 'client', ['product', 'vendor', 'order']);
    expect(rpc).toHaveBeenCalledWith('platform_search', { p_q: 'sofa', p_user: 'u1', p_scope: 'client', p_kinds: ['product', 'vendor', 'order'], p_limit: 6 });
    expect(r.groups.map(g => g.kind)).toEqual(['product', 'vendor']);
    expect(r.groups[0].hits.map(h => h.id)).toEqual(['p2', 'p1']);
    expect(r.total).toBe(3);
  });
});
