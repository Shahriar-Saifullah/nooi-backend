/**
 * Photos on support tickets — services/supportAttachments.service.ts
 * ============================================================================
 * Customers and vendors attach photos (damage, wrong item, delivery issues);
 * admins can attach them to replies too.
 *
 *   - Up to 5 photos per message, 10 MB each before processing.
 *   - Every photo is re-encoded as a JPEG ≤ 2000 px. That keeps them small and
 *     strips EXIF — phone photos carry the GPS location of the customer's home.
 *   - Stored in the PRIVATE bucket "support-attachments"; reads get signed
 *     links valid for an hour, so a leaked message never exposes a photo.
 */

import { randomUUID } from 'crypto';
import sharp from 'sharp';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { supabase } from './supabase';

export const SUPPORT_BUCKET = 'support-attachments';
export const MAX_PHOTOS = 5;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 2000;
const SIGNED_FOR_SECONDS = 3600;

export interface Attachment { path: string; name: string; size: number; width: number; height: number }
export interface SignedAttachment extends Attachment { url: string | null }

/** Multer for "photos" fields: memory only, images only, size-capped. */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INPUT_BYTES, files: MAX_PHOTOS },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only photos can be attached (JPG, PNG or WebP).'));
  },
}).array('photos', MAX_PHOTOS);

/** Route middleware: parses multipart "photos" (plus text fields), and turns
 *  upload problems into a 400 the user can read. JSON requests pass through. */
export function acceptPhotos(req: Request, res: Response, next: NextFunction) {
  photoUpload(req, res, (err: unknown) => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    const msg = e.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 10 MB.'
      : e.code === 'LIMIT_FILE_COUNT' || e.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${MAX_PHOTOS} photos.`
      : e.message || 'Upload failed.';
    return res.status(400).json({ success: false, error: msg });
  });
}

export class AttachmentError extends Error {}

/** Re-encode and store photos for a ticket. Throws AttachmentError with a
 *  message fit for the user; nothing is stored if any photo fails. */
export async function storeTicketPhotos(ticketId: string, files: Express.Multer.File[] | undefined): Promise<Attachment[]> {
  if (!files?.length) return [];
  if (files.length > MAX_PHOTOS) throw new AttachmentError(`You can attach up to ${MAX_PHOTOS} photos.`);

  const processed: { buf: Buffer; name: string; width: number; height: number }[] = [];
  for (const f of files) {
    try {
      const { data, info } = await sharp(f.buffer, { failOn: 'error' })
        .rotate() // respect the phone's orientation before EXIF is dropped
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      processed.push({ buf: data, name: (f.originalname || 'photo').slice(0, 120), width: info.width, height: info.height });
    } catch {
      throw new AttachmentError(`"${f.originalname || 'A file'}" couldn't be read as a photo. Try a JPG or PNG.`);
    }
  }

  const stored: Attachment[] = [];
  try {
    for (const p of processed) {
      const path = `tickets/${ticketId}/${randomUUID()}.jpg`;
      const { error } = await supabase.storage.from(SUPPORT_BUCKET).upload(path, p.buf, {
        contentType: 'image/jpeg', upsert: false,
      });
      if (error) throw new Error(error.message);
      stored.push({ path, name: p.name, size: p.buf.length, width: p.width, height: p.height });
    }
  } catch (e: any) {
    await removeTicketPhotos(stored);
    console.error('[support] photo upload failed:', e?.message || e);
    throw new AttachmentError('Your photos couldn\'t be uploaded. Please try again.');
  }
  return stored;
}

export async function removeTicketPhotos(list: Attachment[]) {
  if (!list.length) return;
  await supabase.storage.from(SUPPORT_BUCKET).remove(list.map(a => a.path)).catch(() => undefined);
}

/** Add short-lived signed links to every attachment on these messages. */
export async function withSignedPhotos<M extends { attachments?: Attachment[] | null }>(messages: M[]): Promise<(M & { attachments: SignedAttachment[] })[]> {
  const paths = messages.flatMap(m => (m.attachments ?? []).map(a => a.path));
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from(SUPPORT_BUCKET).createSignedUrls(paths, SIGNED_FOR_SECONDS);
    for (const d of data ?? []) if (d.path && d.signedUrl) urls.set(d.path, d.signedUrl);
  }
  return messages.map(m => ({
    ...m,
    attachments: (m.attachments ?? []).map(a => ({ ...a, url: urls.get(a.path) ?? null })),
  }));
}
