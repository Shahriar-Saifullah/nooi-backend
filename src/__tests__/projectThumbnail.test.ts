/** PUT /projects/:id/thumbnail — the project picture shown on "Shop this room". */
const uploads: { path: string; buf: Buffer; opts: any }[] = [];
const updates: any[] = [];
let owned = true;

jest.mock('../services/supabase', () => {
  const chain = (result: () => any) => {
    const c: any = {
      select: () => c, eq: () => c,
      single: async () => result(),
      then: (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad),
    };
    return c;
  };
  return {
    supabase: {
      from: () => ({
        select: () => chain(() => ({ data: owned ? { id: 'p1', room_data: {} } : null })),
        update: (row: any) => { updates.push(row); return chain(() => ({ error: null })); },
      }),
      storage: {
        from: () => ({
          upload: async (path: string, buf: Buffer, opts: any) => { uploads.push({ path, buf, opts }); return { error: null }; },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn/${path}` } }),
        }),
      },
    },
    supabaseAuth: {},
  };
});

import sharp from 'sharp';
import { saveThumbnail } from '../controllers/project.controller';
import { saveThumbnailSchema } from '../schemas/project.schema';

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
const req = (image: string) => ({ user: { id: 'u1' }, params: { id: 'p1' }, body: { image } } as any);

beforeEach(() => { uploads.length = 0; updates.length = 0; owned = true; });

describe('project picture', () => {
  it('stores one JPEG per project and saves a cache-busted link', async () => {
    const png = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#eef1ef' } }).png().toBuffer();
    const r = res();
    await saveThumbnail(req(`data:image/png;base64,${png.toString('base64')}`), r);
    expect(r.statusCode).toBe(200);
    expect(uploads[0].path).toBe('thumbnails/u1/p1.jpg');
    expect(uploads[0].opts.upsert).toBe(true);
    const meta = await sharp(uploads[0].buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1600);                 // shrunk, aspect kept
    expect(r.body.data.thumbnail_url).toMatch(/^https:\/\/cdn\/thumbnails\/u1\/p1\.jpg\?v=\d+$/);
    expect(updates[0]).toEqual({ thumbnail_url: r.body.data.thumbnail_url });   // updated_at untouched
  });

  it('refuses other people\'s projects and unreadable pictures', async () => {
    owned = false;
    const r1 = res();
    await saveThumbnail(req('data:image/jpeg;base64,AAAA'), r1);
    expect(r1.statusCode).toBe(404);

    owned = true;
    const r2 = res();
    await saveThumbnail(req('data:image/jpeg;base64,bm90IGFuIGltYWdl'), r2);
    expect(r2.statusCode).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  it('only accepts image data-URLs', () => {
    expect(saveThumbnailSchema.safeParse({ image: 'data:image/jpeg;base64,AAAA' }).success).toBe(true);
    expect(saveThumbnailSchema.safeParse({ image: 'https://evil/x.jpg' }).success).toBe(false);
    expect(saveThumbnailSchema.safeParse({ image: 'data:text/html;base64,AAAA' }).success).toBe(false);
  });
});
