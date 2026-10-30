/**
 * 3D models for listings — services/model3d/index.ts
 * ============================================================================
 * Queue, worker, storage and publishing for product GLBs. See the migration
 * 20261029_product_3d_models.sql for the job lifecycle.
 *
 * The worker runs inside the API process on a timer. Each tick claims a few
 * due jobs with an optimistic lock on next_poll_at, so two Railway instances
 * never submit the same job twice.
 */

import { supabase } from '../supabase';
import { activeModelProvider, VIEWS, type SourceImage, type View } from './providers';
import { ProviderError } from './tripo';
import { optimizeGlb, turnToFrontDeg } from './optimize';
import { notifyAdmins, links } from '../notifications.service';

export { activeModelProvider, VIEWS };
export type { SourceImage, View };

const BUCKET = 'vendor-assets';
const MAX_GLB_BYTES = 60 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const POLL_EVERY_MS = 15_000;
const GIVE_UP_AFTER_MS = 45 * 60_000;
export const ACTIVE = ['queued', 'processing', 'review'] as const;

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const now = () => new Date().toISOString();

// ─── Photos ──────────────────────────────────────────────────────────────────

/** Every distinct photo on a product's variants, in upload order. */
export function productPhotos(product: any): string[] {
  const seen = new Set<string>();
  for (const v of product?.product_variants ?? []) {
    for (const url of v?.images ?? []) {
      if (typeof url === 'string' && /^https?:\/\//.test(url) && !url.includes('picsum.photos')) seen.add(url);
    }
  }
  return [...seen];
}

/**
 * Clean the admin's view assignment. Multiview needs a front plus at least one
 * other side; otherwise fall back to a single front photo.
 */
export function normaliseImages(raw: unknown, photos: string[]): { mode: 'single' | 'multiview'; images: SourceImage[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  const byView = new Map<View, string>();
  for (const r of list) {
    const view = String((r as any)?.view || '') as View;
    const url = String((r as any)?.url || '');
    if (!VIEWS.includes(view) || !url) continue;
    if (!photos.includes(url)) return { error: 'Only the listing\'s own photos can be used.' };
    if (!byView.has(view)) byView.set(view, url);
  }
  if (byView.size === 0) {
    if (!photos.length) return { error: 'This listing has no photos to build a model from.' };
    return { mode: 'single', images: [{ view: 'front', url: photos[0] }] };
  }
  if (!byView.has('front')) return { error: 'Mark one photo as the front view.' };
  const images = VIEWS.filter(v => byView.has(v)).map(v => ({ view: v, url: byView.get(v)! }));
  return { mode: images.length > 1 ? 'multiview' : 'single', images };
}

// ─── Queue ───────────────────────────────────────────────────────────────────

export type QueueResult = { ok: true; job: any } | { ok: false; status: number; error: string };

export async function queueModelJob(productId: string, opts: { images?: unknown; requestedBy?: string | null } = {}): Promise<QueueResult> {
  const { data: product } = await supabase.from('products')
    .select('id, product_variants ( images )').eq('id', productId).maybeSingle();
  if (!product) return { ok: false, status: 404, error: 'Listing not found' };

  const picked = normaliseImages(opts.images, productPhotos(product));
  if ('error' in picked) return { ok: false, status: 400, error: picked.error };

  const { data: job, error } = await supabase.from('product_model_jobs').insert({
    product_id: productId,
    provider: activeModelProvider().name,
    mode: picked.mode,
    source_images: picked.images,
    requested_by: opts.requestedBy ?? null,
  }).select('*').single();

  if (error) {
    if (error.code === '23505') return { ok: false, status: 409, error: 'A model for this listing is already being made or waiting for review.' };
    return { ok: false, status: 500, error: error.message };
  }
  return { ok: true, job };
}

/** Called when an admin approves a listing. Never throws. */
export async function autoQueueOnApprove(productId: string, specs: any, adminId?: string | null) {
  try {
    if ((process.env.MODEL3D_AUTO_ON_APPROVE || 'on').toLowerCase() === 'off') return;
    if (specs?.model_url) return; // vendor already supplied one
    // Use the sides the vendor marked; if they don't add up (no front, say),
    // fall back to the main photo rather than not making a model at all.
    let r = await queueModelJob(productId, { images: specs?.photo_views, requestedBy: adminId ?? null });
    if (!r.ok && r.status === 400 && specs?.photo_views) r = await queueModelJob(productId, { requestedBy: adminId ?? null });
    if (!r.ok && r.status !== 409 && r.status !== 400) console.warn('[model3d] auto-queue failed:', r.error);
  } catch (e) {
    console.warn('[model3d] auto-queue error:', e);
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function looksLikeGlb(buf: Buffer) {
  return buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'glTF';
}

/** Put a GLB in our bucket — provider links expire, ours must not. */
export async function storeGlbBuffer(productId: string, key: string, buf: Buffer) {
  if (!looksLikeGlb(buf)) throw new Error('That file is not a binary glTF (.glb).');
  if (buf.length > MAX_GLB_BYTES) throw new Error('The model is larger than 60 MB.');
  const path = `models/${productId}/${key}.glb`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, {
    contentType: 'model/gltf-binary', upsert: true, cacheControl: '31536000',
  });
  if (error) throw new Error(`Could not store the model: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path, bytes: buf.length };
}

const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024; // raw provider output, before optimising

export async function downloadGlb(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Could not download the model (${res.status}).`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error('The model file is too large to process.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!looksLikeGlb(buf)) throw new Error('The downloaded file is not a binary glTF (.glb).');
  return buf;
}

/** Download a provider's model, turn it to face +Z, shrink it, and store it. */
export async function storeGlbFromUrl(productId: string, key: string, url: string, forwardAxis?: string) {
  const raw = await downloadGlb(url);
  const { buffer, before, after, optimized } = await optimizeGlb(raw, { rotateDeg: turnToFrontDeg(forwardAxis) });
  console.log(`[model3d] ${key}: ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB${optimized ? '' : ' (not optimised)'}`);
  return storeGlbBuffer(productId, key, buffer);
}

/** An admin's own GLB: shrink it, keep its orientation. */
export async function storeUploadedGlb(productId: string, key: string, raw: Buffer) {
  if (!looksLikeGlb(raw)) throw new Error('That file is not a binary glTF (.glb).');
  const { buffer } = await optimizeGlb(raw, { rotateDeg: 0 });
  return storeGlbBuffer(productId, key, buffer);
}

/** Turn a stored model a quarter (or any) turn — for a model that came out facing sideways. */
export async function rotateStoredGlb(productId: string, key: string, url: string, deg: number) {
  const raw = await downloadGlb(url);
  const r = await optimizeGlb(raw, { rotateDeg: deg, compress: false });
  if (!r.optimized) throw new Error('Could not rotate this model.');
  return storeGlbBuffer(productId, `${key}-r${Date.now()}`, r.buffer);
}

// ─── Publishing ──────────────────────────────────────────────────────────────

/** Show a GLB on the listing. specs_json.model_url is what the shop reads. */
export async function publishModel(productId: string, glbUrl: string, source: 'nooi_generated' | 'admin_upload', jobId: string) {
  const { data: p } = await supabase.from('products').select('specs_json').eq('id', productId).maybeSingle();
  const specs = { ...(p?.specs_json ?? {}), model_url: glbUrl, has_3d: true, model_source: source, model_job_id: jobId };
  const { error } = await supabase.from('products').update({ specs_json: specs }).eq('id', productId);
  if (error) throw new Error(error.message);
}

export async function unpublishModel(productId: string) {
  const { data: p } = await supabase.from('products').select('specs_json').eq('id', productId).maybeSingle();
  const { model_url, model_source, model_job_id, ...rest } = (p?.specs_json ?? {}) as any;
  void model_url; void model_source; void model_job_id;
  const { error } = await supabase.from('products').update({ specs_json: { ...rest, has_3d: false } }).eq('id', productId);
  if (error) throw new Error(error.message);
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async function claim(job: any): Promise<boolean> {
  const { data } = await supabase.from('product_model_jobs')
    .update({ next_poll_at: later(60_000), updated_at: now() })
    .eq('id', job.id).eq('next_poll_at', job.next_poll_at).eq('status', job.status)
    .select('id');
  return Boolean(data?.length);
}

async function setJob(id: string, patch: Record<string, unknown>) {
  await supabase.from('product_model_jobs').update({ ...patch, updated_at: now() }).eq('id', id);
}

async function step(job: any) {
  const provider = activeModelProvider();

  if (job.status === 'queued') {
    try {
      const taskId = await provider.submit({ mode: job.mode, images: job.source_images });
      await setJob(job.id, {
        status: 'processing', provider: provider.name, provider_task_id: taskId, started_at: now(),
        attempts: job.attempts + 1, progress: 0, error: null, next_poll_at: later(POLL_EVERY_MS),
      });
    } catch (e: any) {
      const message = e?.message || 'Could not start the job.';
      if (e instanceof ProviderError && e.permanent) {
        await setJob(job.id, { status: 'failed', attempts: job.attempts + 1, error: message });
      } else if (e instanceof ProviderError && e.waitMs) {
        // Out of credits, busy, rate-limited: not this job's fault. Wait and
        // try again without using up an attempt.
        await setJob(job.id, { error: message, next_poll_at: later(e.waitMs) });
      } else {
        const attempts = job.attempts + 1;
        await setJob(job.id, attempts >= MAX_ATTEMPTS
          ? { status: 'failed', attempts, error: message }
          : { attempts, error: message, next_poll_at: later(60_000 * attempts) });
      }
    }
    return;
  }

  // processing
  if (Date.now() - new Date(job.started_at || job.created_at).getTime() > GIVE_UP_AFTER_MS) {
    await setJob(job.id, { status: 'failed', error: 'The 3D provider took too long.' });
    return;
  }
  try {
    const r = await provider.poll(job.provider_task_id);
    if (r.state === 'running') {
      await setJob(job.id, { progress: r.progress, next_poll_at: later(POLL_EVERY_MS) });
    } else if (r.state === 'failed') {
      await setJob(job.id, { status: 'failed', error: r.error });
      await notifyJob(job, '3D model failed', r.error);
    } else {
      const stored = await storeGlbFromUrl(job.product_id, job.id, r.glbUrl, provider.forwardAxis?.());
      await setJob(job.id, {
        status: 'review', progress: 100, error: null,
        glb_url: stored.url, glb_path: stored.path, glb_bytes: stored.bytes,
        ...(r.credits ? { credits_used: r.credits } : {}),
      });
      await notifyJob(job, '3D model ready to review', 'Check it against the photos and approve it onto the listing.');
    }
  } catch (e: any) {
    if (e instanceof ProviderError && e.permanent) {
      await setJob(job.id, { status: 'failed', error: e.message });
      return;
    }
    // A network blip shouldn't fail a job that may be fine on the provider.
    await setJob(job.id, { error: e?.message || 'Poll failed', next_poll_at: later(e?.waitMs || 60_000) });
  }
}

/** Admins hear when a model is ready for review or failed. */
async function notifyJob(job: any, title: string, message: string) {
  const { data: p } = await supabase.from('products').select('title').eq('id', job.product_id).maybeSingle();
  await notifyAdmins({ title: `${title}: ${p?.title ?? 'a listing'}`, message, type: 'admin', link: links.admin('models', job.product_id) });
}

let running = false;
export async function workerTick() {
  if (running) return;
  if (!activeModelProvider().configured()) return;
  running = true;
  try {
    const { data: jobs } = await supabase.from('product_model_jobs')
      .select('*').in('status', ['queued', 'processing']).lte('next_poll_at', now())
      .order('next_poll_at', { ascending: true }).limit(5);
    for (const job of jobs ?? []) {
      if (await claim(job)) await step(job);
    }
  } catch (e) {
    console.error('[model3d] worker tick failed:', e);
  } finally {
    running = false;
  }
}

/** Provider name, whether it can run, and its credit balance (cached a minute). */
let balanceCache: { at: number; value: { balance: number; frozen: number } | null } | null = null;
export async function providerStatus() {
  const p = activeModelProvider();
  const ready = p.configured();
  let balance: { balance: number; frozen: number } | null = null;
  if (ready && p.balance) {
    if (balanceCache && Date.now() - balanceCache.at < 60_000) balance = balanceCache.value;
    else {
      balance = await p.balance().catch(() => null);
      balanceCache = { at: Date.now(), value: balance };
    }
  }
  return { name: p.name, ready, balance };
}

export function startModelWorker() {
  if ((process.env.MODEL3D_WORKER || 'on').toLowerCase() === 'off') return;
  const t = setInterval(() => { void workerTick(); }, 10_000);
  t.unref?.();
  console.log(`[model3d] worker started (provider: ${activeModelProvider().name}, ready: ${activeModelProvider().configured()})`);
}
