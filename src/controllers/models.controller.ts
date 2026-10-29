/**
 * 3D models — admin — controllers/models.controller.ts
 * ============================================================================
 * The /admin/models queue. Admins see which listings still need a 3D model,
 * start a generation from the listing's photos (marking which photo is the
 * front, left, back, right), review the result in a 3D viewer, and approve it
 * onto the listing — or upload a GLB themselves.
 */

import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import {
  providerStatus, queueModelJob, productPhotos, storeUploadedGlb, rotateStoredGlb,
  publishModel, unpublishModel, ACTIVE,
} from '../services/model3d';

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

async function audit(req: AuthRequest, action: string, entityId: string, summary: string, metadata: any = {}) {
  await supabase.from('admin_audit_log').insert({
    actor_id: req.user?.id, actor_email: req.user?.email || null,
    action, entity_type: 'product', entity_id: entityId, summary, metadata,
  });
}

async function notifyVendor(productId: string, title: string, message: string) {
  const { data } = await supabase.from('products').select('retailers ( vendor_id )').eq('id', productId).maybeSingle();
  const vendorId = (data as any)?.retailers?.vendor_id;
  if (vendorId) await supabase.from('notifications').insert({ user_id: vendorId, title, message, type: 'listing', link_url: '/sell/products' });
}

const PRODUCT_COLS = `id, title, listing_status, specs_json, created_at,
  retailers ( id, name ), product_variants ( images, dimensions_cm )`;

function shapeProduct(p: any) {
  return {
    id: p.id,
    title: p.title,
    listing_status: p.listing_status,
    vendor: p.retailers?.name ?? null,
    photo: productPhotos(p)[0] ?? null,
    photo_count: productPhotos(p).length,
    model_url: p.specs_json?.model_url ?? null,
    model_source: p.specs_json?.model_source ?? (p.specs_json?.model_url ? 'vendor_upload' : null),
  };
}

const provider = () => providerStatus();

const TABS = ['needs', 'working', 'review', 'live', 'failed'] as const;

async function tabCounts() {
  const jobsCount = async (statuses: string[]) => {
    const { count } = await supabase.from('product_model_jobs').select('id', { count: 'exact', head: true }).in('status', statuses);
    return count || 0;
  };
  const { count: live } = await supabase.from('products').select('id', { count: 'exact', head: true })
    .not('specs_json->>model_url', 'is', null);
  const { data: activeIds } = await supabase.from('product_model_jobs').select('product_id').in('status', [...ACTIVE]);
  const busy = new Set((activeIds ?? []).map(r => r.product_id));
  const { data: noModel } = await supabase.from('products').select('id')
    .in('listing_status', ['pending', 'approved']).is('specs_json->>model_url', null).limit(1000);
  return {
    needs: (noModel ?? []).filter(p => !busy.has(p.id)).length,
    working: await jobsCount(['queued', 'processing']),
    review: await jobsCount(['review']),
    live: live || 0,
    failed: await jobsCount(['failed']),
  };
}

/** GET /admin/models?tab=needs|working|review|live|failed&search= */
export async function listModels(req: AuthRequest, res: Response) {
  try {
    const tab = (TABS as readonly string[]).includes(String(req.query.tab)) ? String(req.query.tab) : 'needs';
    const search = clean(req.query.search, 80);
    let rows: any[] = [];

    if (tab === 'needs' || tab === 'live') {
      let q = supabase.from('products').select(PRODUCT_COLS).order('created_at', { ascending: false }).limit(100);
      if (tab === 'needs') q = q.in('listing_status', ['pending', 'approved']).is('specs_json->>model_url', null);
      else q = q.not('specs_json->>model_url', 'is', null);
      if (search) q = q.ilike('title', `%${search}%`);
      const { data, error } = await q;
      if (error) return res.status(400).json({ success: false, error: error.message });
      let products = data ?? [];
      if (tab === 'needs') {
        const { data: activeIds } = await supabase.from('product_model_jobs').select('product_id').in('status', [...ACTIVE]);
        const busy = new Set((activeIds ?? []).map(r => r.product_id));
        products = products.filter(p => !busy.has(p.id));
      }
      rows = products.map(p => ({ product: shapeProduct(p), job: null }));
    } else {
      const statuses = tab === 'working' ? ['queued', 'processing'] : tab === 'review' ? ['review'] : ['failed'];
      const { data, error } = await supabase.from('product_model_jobs')
        .select(`id, status, progress, error, provider, mode, created_at, updated_at, products ( ${PRODUCT_COLS} )`)
        .in('status', statuses).order('updated_at', { ascending: tab !== 'failed' }).limit(100);
      if (error) return res.status(400).json({ success: false, error: error.message });
      rows = (data ?? [])
        .filter((j: any) => j.products && (!search || j.products.title?.toLowerCase().includes(search.toLowerCase())))
        .map((j: any) => {
          const { products, ...job } = j;
          return { product: shapeProduct(products), job };
        });
    }

    return res.json({ success: true, data: { rows, counts: await tabCounts(), provider: await provider() } });
  } catch (err) {
    console.error('listModels error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/** GET /admin/models/products/:id — photos, live model, every attempt. */
export async function getModelProduct(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const { data: p, error } = await supabase.from('products').select(PRODUCT_COLS).eq('id', id).maybeSingle();
  if (error) return res.status(400).json({ success: false, error: error.message });
  if (!p) return res.status(404).json({ success: false, error: 'Listing not found' });
  const { data: jobs } = await supabase.from('product_model_jobs').select('*')
    .eq('product_id', id).order('created_at', { ascending: false }).limit(20);
  const dims = (p as any).product_variants?.find((v: any) => v.dimensions_cm)?.dimensions_cm ?? null;
  return res.json({
    success: true,
    data: { product: { ...shapeProduct(p), photos: productPhotos(p), photo_views: (p as any).specs_json?.photo_views ?? [], dimensions_cm: dims }, jobs: jobs ?? [], provider: await provider() },
  });
}

/** POST /admin/models/products/:id/generate { images: [{ view, url }] } */
export async function generateModel(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const r = await queueModelJob(id, { images: req.body?.images, requestedBy: req.user?.id });
  if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
  await audit(req, 'model.generate', id, 'Started a 3D model', { job_id: r.job.id, mode: r.job.mode });
  return res.json({ success: true, data: { job: r.job, provider: await provider() } });
}

/** POST /admin/models/products/:id/upload (multipart "file", .glb) — publishes immediately. */
export async function uploadModel(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
  if (!file) return res.status(400).json({ success: false, error: 'Choose a .glb file.' });
  const { data: p } = await supabase.from('products').select('id, title').eq('id', id).maybeSingle();
  if (!p) return res.status(404).json({ success: false, error: 'Listing not found' });

  try {
    // Anything in flight is now moot.
    await supabase.from('product_model_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('product_id', id).in('status', [...ACTIVE]);
    const { data: job, error } = await supabase.from('product_model_jobs').insert({
      product_id: id, provider: 'manual', mode: 'manual', status: 'approved', progress: 100,
      requested_by: req.user?.id, reviewed_by: req.user?.id, reviewed_at: new Date().toISOString(),
    }).select('*').single();
    if (error) throw new Error(error.message);
    const stored = await storeUploadedGlb(id, job.id, file.buffer);
    await supabase.from('product_model_jobs').update({ glb_url: stored.url, glb_path: stored.path, glb_bytes: stored.bytes }).eq('id', job.id);
    await publishModel(id, stored.url, 'admin_upload', job.id);
    await audit(req, 'model.upload', id, `Uploaded a 3D model for "${p.title}"`, { job_id: job.id, bytes: stored.bytes });
    await notifyVendor(id, `3D model added to "${p.title}"`, 'Shoppers can now view it in 3D and place it in their rooms.');
    return res.json({ success: true, data: { model_url: stored.url } });
  } catch (e: any) {
    return res.status(400).json({ success: false, error: e?.message || 'Upload failed' });
  }
}

async function loadJob(req: AuthRequest, res: Response) {
  const { data: job } = await supabase.from('product_model_jobs').select('*, products ( id, title )').eq('id', req.params.id as string).maybeSingle();
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return null; }
  return job as any;
}

/** POST /admin/models/jobs/:id/approve — put the GLB on the listing. */
export async function approveModelJob(req: AuthRequest, res: Response) {
  const job = await loadJob(req, res); if (!job) return;
  if (job.status !== 'review' || !job.glb_url) return res.status(409).json({ success: false, error: 'Only a finished model waiting for review can be approved.' });
  try {
    await publishModel(job.product_id, job.glb_url, 'nooi_generated', job.id);
    await supabase.from('product_model_jobs').update({
      status: 'approved', reviewed_by: req.user?.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', job.id);
    await audit(req, 'model.approve', job.product_id, `Approved the 3D model for "${job.products?.title}"`, { job_id: job.id });
    await notifyVendor(job.product_id, `3D model added to "${job.products?.title}"`, 'Shoppers can now view it in 3D and place it in their rooms.');
    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Could not publish' });
  }
}

/** POST /admin/models/jobs/:id/reject { note } */
export async function rejectModelJob(req: AuthRequest, res: Response) {
  const job = await loadJob(req, res); if (!job) return;
  if (job.status !== 'review') return res.status(409).json({ success: false, error: 'Only a model waiting for review can be rejected.' });
  const note = clean(req.body?.note, 500) || null;
  await supabase.from('product_model_jobs').update({
    status: 'rejected', review_note: note, reviewed_by: req.user?.id, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', job.id);
  await audit(req, 'model.reject', job.product_id, `Rejected a 3D model for "${job.products?.title}"`, { job_id: job.id, note });
  return res.json({ success: true });
}

/** POST /admin/models/jobs/:id/cancel — stop a queued or running job. */
export async function cancelModelJob(req: AuthRequest, res: Response) {
  const job = await loadJob(req, res); if (!job) return;
  if (!['queued', 'processing'].includes(job.status)) return res.status(409).json({ success: false, error: 'This job is not running.' });
  await supabase.from('product_model_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', job.id);
  await audit(req, 'model.cancel', job.product_id, `Cancelled a 3D model job for "${job.products?.title}"`, { job_id: job.id });
  return res.json({ success: true });
}

/** POST /admin/models/products/:id/remove — take the model off the listing. */
export async function removeModel(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  try {
    await unpublishModel(id);
    await audit(req, 'model.remove', id, 'Removed the 3D model from a listing');
    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Could not remove' });
  }
}

/**
 * POST /admin/models/products/:id/size { width, depth, height } (cm)
 * The canvas scales a model to exactly this size, so it has to be right.
 * Applied to every variant of the listing.
 */
export async function setModelSize(req: AuthRequest, res: Response) {
  const id = req.params.id as string;
  const dims = ['width', 'depth', 'height'].map(k => Number(req.body?.[k]));
  if (!dims.every(n => Number.isFinite(n) && n >= 1 && n <= 2000)) {
    return res.status(400).json({ success: false, error: 'Width, depth and height must each be between 1 and 2000 cm.' });
  }
  const [width, depth, height] = dims.map(n => Math.round(n * 10) / 10);
  const { data, error } = await supabase.from('product_variants')
    .update({ dimensions_cm: { width, depth, height } }).eq('product_id', id).select('id');
  if (error) return res.status(400).json({ success: false, error: error.message });
  if (!data?.length) return res.status(404).json({ success: false, error: 'Listing not found' });
  await audit(req, 'model.size', id, `Set size to ${width} × ${depth} × ${height} cm`, { width, depth, height });
  return res.json({ success: true, data: { dimensions_cm: { width, depth, height } } });
}

/**
 * POST /admin/models/rotate { job_id } | { product_id }, degrees? (default 90)
 * Turn a model that came out facing the wrong way. A job's model is turned
 * before review; a product's live model is turned in place on the listing.
 */
export async function rotateModel(req: AuthRequest, res: Response) {
  const deg = [90, 180, 270, -90].includes(Number(req.body?.degrees)) ? Number(req.body.degrees) : 90;
  try {
    if (req.body?.job_id) {
      const { data: job } = await supabase.from('product_model_jobs').select('*').eq('id', String(req.body.job_id)).maybeSingle();
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (job.status !== 'review' || !job.glb_url) return res.status(409).json({ success: false, error: 'Only a model waiting for review can be turned here.' });
      const stored = await rotateStoredGlb(job.product_id, job.id, job.glb_url, deg);
      await supabase.from('product_model_jobs').update({ glb_url: stored.url, glb_path: stored.path, glb_bytes: stored.bytes, updated_at: new Date().toISOString() }).eq('id', job.id);
      return res.json({ success: true, data: { glb_url: stored.url } });
    }
    const productId = String(req.body?.product_id || '');
    const { data: p } = await supabase.from('products').select('id, specs_json').eq('id', productId).maybeSingle();
    const url = (p as any)?.specs_json?.model_url;
    if (!p || !url) return res.status(404).json({ success: false, error: 'This listing has no model to turn.' });
    const stored = await rotateStoredGlb(productId, `live-${productId}`, url, deg);
    const source = (p as any).specs_json?.model_source ?? 'admin_upload';
    await publishModel(productId, stored.url, source === 'nooi_generated' ? 'nooi_generated' : 'admin_upload', (p as any).specs_json?.model_job_id ?? 'rotated');
    await audit(req, 'model.rotate', productId, `Turned the 3D model ${deg}°`);
    return res.json({ success: true, data: { glb_url: stored.url } });
  } catch (e: any) {
    return res.status(400).json({ success: false, error: e?.message || 'Could not turn the model.' });
  }
}
