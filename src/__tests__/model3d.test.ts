jest.mock('../services/supabase', () => ({ supabase: {}, supabaseAuth: {} }));

import { normaliseImages, productPhotos } from '../services/model3d';
import { activeModelProvider } from '../services/model3d/providers';

const A = 'https://x.supabase.co/a.jpg';
const B = 'https://x.supabase.co/b.jpg';
const C = 'https://x.supabase.co/c.jpg';

describe('productPhotos', () => {
  it('collects distinct real photos across variants and skips placeholders', () => {
    const p = { product_variants: [
      { images: [A, B] },
      { images: [B, 'https://picsum.photos/seed/x/800/600', 'data:image/png;base64,xx', C] },
    ] };
    expect(productPhotos(p)).toEqual([A, B, C]);
  });
});

describe('normaliseImages', () => {
  const photos = [A, B, C];

  it('falls back to the first photo as a single front view', () => {
    expect(normaliseImages(undefined, photos)).toEqual({ mode: 'single', images: [{ view: 'front', url: A }] });
  });

  it('builds a multiview set in front/left/back/right order', () => {
    const r = normaliseImages([{ view: 'back', url: C }, { view: 'front', url: B }, { view: 'left', url: A }], photos);
    expect(r).toEqual({ mode: 'multiview', images: [
      { view: 'front', url: B }, { view: 'left', url: A }, { view: 'back', url: C },
    ] });
  });

  it('requires a front view when views are given', () => {
    expect(normaliseImages([{ view: 'left', url: A }], photos)).toEqual({ error: 'Mark one photo as the front view.' });
  });

  it('refuses photos that are not on the listing', () => {
    expect('error' in normaliseImages([{ view: 'front', url: 'https://evil.example/x.jpg' }], photos)).toBe(true);
  });

  it('errors when the listing has no photos', () => {
    expect('error' in normaliseImages(undefined, [])).toBe(true);
  });
});

describe('providers', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  it('tripo waits for its key', () => {
    delete process.env.MODEL3D_PROVIDER; delete process.env.TRIPO_API_KEY;
    expect(activeModelProvider().name).toBe('tripo');
    expect(activeModelProvider().configured()).toBe(false);
  });

  it('mock runs, then finishes with a GLB', async () => {
    process.env.MODEL3D_PROVIDER = 'mock';
    const p = activeModelProvider();
    expect(p.configured()).toBe(true);
    const id = await p.submit({ mode: 'single', images: [{ view: 'front', url: A }] });
    expect((await p.poll(id)).state).toBe('running');
    const r = await p.poll(`mock_${Date.now() - 60_000}`);
    expect(r.state).toBe('done');
  });

  it('off never runs', () => {
    process.env.MODEL3D_PROVIDER = 'off';
    expect(activeModelProvider().configured()).toBe(false);
  });
});
