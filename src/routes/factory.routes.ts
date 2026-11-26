/**
 * /factory — drawings and specs for factories (services/factory.service.ts).
 *
 *   POST   /factory/uploads                         sign an upload (listing, listing draft or order line)
 *   GET    /factory/listings/:id/drawings           a listing's drawings (vendor who sells it, admins)
 *   POST   /factory/listings/:id/drawings           attach an uploaded file
 *   DELETE /factory/listings/:id/drawings?path=     remove one
 *   GET    /factory/orders/:id                      an order's lines with spec + drawings (client, its vendors, admins)
 *   POST   /factory/order-items/:id/drawings        attach an uploaded file to a line
 *   DELETE /factory/order-items/:id/drawings?path=  remove one (whoever added it, or an admin)
 *   PUT    /factory/order-items/:id/spec            save the line's factory spec (client while open, admins)
 *   GET    /factory/spec-fields                     the spec form's fields
 */

import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types';
import { supabase } from '../services/supabase';
import {
  DRAWINGS_BUCKET, MAX_DRAWINGS, SPEC_FIELDS, cleanDrawingRef, cleanSpec, drawingExists, listingAccess,
  newDrawingPath, orderItemAccess, orderLines, prefixFor, removeDrawingFiles, signDrawings, uploadProblem,
  type Caller, type Drawing, type UploadScope,
} from '../services/factory.service';

const router = Router();
const caller = (req: AuthRequest): Caller => ({ id: req.user!.id, role: req.userProfile?.role ?? 'user' });
const fail = (res: Response, code: number, error: string) => res.status(code).json({ success: false, error });

router.get('/spec-fields', (_req, res) => res.json({ success: true, data: { fields: SPEC_FIELDS } }));

/** POST /factory/uploads { scope, id?, name, size } → { path, token, signedUrl, bucket } */
router.post('/uploads', requireAuth, async (req: AuthRequest, res: Response) => {
  const c = caller(req);
  const { scope, id, name, size } = req.body ?? {};
  const problem = uploadProblem(name, size);
  if (problem) return fail(res, 400, problem);
  let target: UploadScope;
  if (scope === 'listing-draft') {
    if (c.role !== 'vendor' && c.role !== 'admin' && c.role !== 'super_admin') return fail(res, 403, 'Only sellers can add listing drawings.');
    target = { scope: 'listing-draft', userId: c.id };
  } else if (scope === 'listing') {
    const l = await listingAccess(c, String(id ?? ''));
    if (!l) return fail(res, 404, 'Listing not found.');
    if (l.drawings.length >= MAX_DRAWINGS) return fail(res, 400, `A listing can have up to ${MAX_DRAWINGS} drawings.`);
    target = { scope: 'listing', productId: l.id };
  } else if (scope === 'order-item') {
    const a = await orderItemAccess(c, String(id ?? ''));
    if (!a) return fail(res, 404, 'Order line not found.');
    if (a.item.drawings.length >= MAX_DRAWINGS) return fail(res, 400, `An order line can have up to ${MAX_DRAWINGS} drawings.`);
    target = { scope: 'order-item', orderId: a.item.order_id, itemId: a.item.id };
  } else return fail(res, 400, 'Unknown upload.');

  const path = newDrawingPath(target, String(name));
  const { data, error } = await supabase.storage.from(DRAWINGS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return fail(res, 500, 'Could not start the upload. Please try again.');
  return res.json({ success: true, data: { bucket: DRAWINGS_BUCKET, path: data.path ?? path, token: data.token, signedUrl: data.signedUrl } });
});

// ── listings ────────────────────────────────────────────────────────────────

router.get('/listings/:id/drawings', requireAuth, async (req: AuthRequest, res: Response) => {
  const l = await listingAccess(caller(req), String(req.params.id));
  if (!l) return fail(res, 404, 'Listing not found.');
  return res.json({ success: true, data: { drawings: await signDrawings(l.drawings) } });
});

router.post('/listings/:id/drawings', requireAuth, async (req: AuthRequest, res: Response) => {
  const c = caller(req);
  const l = await listingAccess(c, String(req.params.id));
  if (!l) return fail(res, 404, 'Listing not found.');
  const d = cleanDrawingRef(req.body, prefixFor({ scope: 'listing', productId: l.id }), { id: c.id, role: l.role });
  if (!d) return fail(res, 400, 'That file was not uploaded for this listing.');
  if (!(await drawingExists(d.path))) return fail(res, 400, 'The upload did not finish. Please try again.');
  const next = [...l.drawings.filter(x => x.path !== d.path), d].slice(-MAX_DRAWINGS);
  const { error } = await supabase.from('products').update({ drawings: next }).eq('id', l.id);
  if (error) return fail(res, 500, error.message);
  return res.json({ success: true, data: { drawings: await signDrawings(next) } });
});

router.delete('/listings/:id/drawings', requireAuth, async (req: AuthRequest, res: Response) => {
  const l = await listingAccess(caller(req), String(req.params.id));
  if (!l) return fail(res, 404, 'Listing not found.');
  const path = String(req.query.path ?? '');
  if (!l.drawings.some(d => d.path === path)) return fail(res, 404, 'Drawing not found.');
  const next = l.drawings.filter(d => d.path !== path);
  const { error } = await supabase.from('products').update({ drawings: next }).eq('id', l.id);
  if (error) return fail(res, 500, error.message);
  await removeDrawingFiles([path]);
  return res.json({ success: true, data: { drawings: await signDrawings(next) } });
});

// ── orders ──────────────────────────────────────────────────────────────────

router.get('/orders/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const lines = await orderLines(caller(req), String(req.params.id));
    if (!lines) return fail(res, 404, 'Order not found.');
    return res.json({ success: true, data: { ...lines, fields: SPEC_FIELDS } });
  } catch (e: any) {
    return fail(res, 500, e.message);
  }
});

router.post('/order-items/:id/drawings', requireAuth, async (req: AuthRequest, res: Response) => {
  const c = caller(req);
  const a = await orderItemAccess(c, String(req.params.id));
  if (!a) return fail(res, 404, 'Order line not found.');
  const d = cleanDrawingRef(req.body, prefixFor({ scope: 'order-item', orderId: a.item.order_id, itemId: a.item.id }), { id: c.id, role: a.role });
  if (!d) return fail(res, 400, 'That file was not uploaded for this order line.');
  if (!(await drawingExists(d.path))) return fail(res, 400, 'The upload did not finish. Please try again.');
  const next = [...a.item.drawings.filter(x => x.path !== d.path), d].slice(-MAX_DRAWINGS);
  const { error } = await supabase.from('order_items').update({ drawings: next }).eq('id', a.item.id);
  if (error) return fail(res, 500, error.message);
  return res.json({ success: true, data: { drawings: await signDrawings(next) } });
});

router.delete('/order-items/:id/drawings', requireAuth, async (req: AuthRequest, res: Response) => {
  const c = caller(req);
  const a = await orderItemAccess(c, String(req.params.id));
  if (!a) return fail(res, 404, 'Order line not found.');
  const path = String(req.query.path ?? '');
  const d: Drawing | undefined = a.item.drawings.find(x => x.path === path);
  if (!d) return fail(res, 404, 'Drawing not found.');
  if (a.role !== 'admin' && d.uploaded_by !== c.id) return fail(res, 403, 'Only whoever added a drawing can remove it.');
  const next = a.item.drawings.filter(x => x.path !== path);
  const { error } = await supabase.from('order_items').update({ drawings: next }).eq('id', a.item.id);
  if (error) return fail(res, 500, error.message);
  await removeDrawingFiles([path]);
  return res.json({ success: true, data: { drawings: await signDrawings(next) } });
});

router.put('/order-items/:id/spec', requireAuth, async (req: AuthRequest, res: Response) => {
  const c = caller(req);
  const a = await orderItemAccess(c, String(req.params.id));
  if (!a) return fail(res, 404, 'Order line not found.');
  if (!a.canEditSpec) return fail(res, 403, a.role === 'vendor' ? 'The client or Nooi updates these details.' : 'This item is already on its way, so its details can no longer change.');
  const spec = { fields: cleanSpec(req.body), updated_at: new Date().toISOString(), updated_by: c.id };
  const { error } = await supabase.from('order_items').update({ factory_spec: spec }).eq('id', a.item.id);
  if (error) return fail(res, 500, error.message);
  return res.json({ success: true, data: { spec } });
});

export default router;
