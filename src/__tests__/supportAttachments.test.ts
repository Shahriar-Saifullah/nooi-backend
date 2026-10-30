const uploads: { path: string; buf: Buffer }[] = [];
const removed: string[] = [];

jest.mock('../services/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: async (path: string, buf: Buffer) => { uploads.push({ path, buf }); return { error: null }; },
        remove: async (paths: string[]) => { removed.push(...paths); return { error: null }; },
        createSignedUrls: async (paths: string[]) => ({ data: paths.map(p => ({ path: p, signedUrl: `https://signed/${p}` })) }),
      }),
    },
  },
  supabaseAuth: {},
}));

import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { storeTicketPhotos, withSignedPhotos, acceptPhotos, AttachmentError } from '../services/supportAttachments.service';

const file = (buffer: Buffer, originalname = 'photo.jpg') =>
  ({ buffer, originalname, mimetype: 'image/jpeg' } as Express.Multer.File);

async function phonePhoto(w = 4000, h = 3000) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#8a6d3b' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'Phone', Model: 'X' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '24/1 42/1 0/1' } })
    .toBuffer();
}

beforeEach(() => { uploads.length = 0; removed.length = 0; });

describe('support photos', () => {
  it('shrinks photos and strips their EXIF/GPS data', async () => {
    const original = await phonePhoto();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const [a] = await storeTicketPhotos('t1', [file(original)]);
    expect(a.path).toMatch(/^tickets\/t1\/[0-9a-f-]+\.jpg$/);
    expect(Math.max(a.width, a.height)).toBeLessThanOrEqual(2000);

    const meta = await sharp(uploads[0].buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('rejects a file that is not a photo, and stores nothing', async () => {
    const good = await phonePhoto(800, 600);
    await expect(storeTicketPhotos('t1', [file(good), file(Buffer.from('not an image'), 'notes.txt')]))
      .rejects.toBeInstanceOf(AttachmentError);
    expect(uploads).toHaveLength(0);
  });

  it('adds signed links when reading', async () => {
    const [m] = await withSignedPhotos([{ id: 'm1', attachments: [{ path: 'tickets/t1/a.jpg', name: 'a', size: 1, width: 1, height: 1 }] }]);
    expect(m.attachments[0].url).toBe('https://signed/tickets/t1/a.jpg');
  });

  it('turns upload limits into a readable 400', async () => {
    const app = express();
    app.post('/x', acceptPhotos, (req, res) => res.json({ ok: true, n: (req as any).files?.length ?? 0, body: req.body.body }));
    const img = await phonePhoto(200, 200);

    const ok = await request(app).post('/x').field('body', 'hello').attach('photos', img, 'a.jpg');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, n: 1, body: 'hello' });

    let tooMany = request(app).post('/x');
    for (let i = 0; i < 6; i++) tooMany = tooMany.attach('photos', img, `p${i}.jpg`);
    const r = await tooMany;
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/up to 5 photos/);

    const notImage = await request(app).post('/x').attach('photos', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(notImage.status).toBe(400);
    expect(notImage.body.error).toMatch(/Only photos/);
  });
});
