jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn() } }));
import { cleanFavourite } from '../services/favourites.service';

describe('favourites', () => {
  it('accepts library slugs and product uuids only', () => {
    expect(cleanFavourite({ kind: 'library', ref: 'sofa-3seat' })).toEqual({ kind: 'library', ref: 'sofa-3seat' });
    expect(cleanFavourite({ kind: 'product', ref: 'A1B2C3D4-0000-4000-8000-000000000001' }))
      .toEqual({ kind: 'product', ref: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(cleanFavourite({ kind: 'product', ref: 'sofa-3seat' })).toBeNull();
    expect(cleanFavourite({ kind: 'library', ref: '../etc' })).toBeNull();
    expect(cleanFavourite({ kind: 'project', ref: 'x' })).toBeNull();
    expect(cleanFavourite(null)).toBeNull();
  });
});
