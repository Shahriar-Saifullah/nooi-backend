/**
 * 360° tours — routes/tour.routes.ts (see services/tour.service.ts).
 *
 *   POST /tours                  { projectId, quality, sceneHash, sceneBytes, lights, nodes, plan, title? }
 *   POST /tours/:id/start        the scene is uploaded: render every room
 *   GET  /tours?projectId=       a project's tours, newest first
 *   GET  /tours/shared/:token    a shared tour (no sign-in)
 *   GET  /tours/:id              one tour with each room's progress
 *   POST /tours/:id/share        { on } → a share link, or none
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types';
import { supabase } from '../services/supabase';
import {
  BUCKET, SHA256, applyProviderUpdate, cleanPanoSpec, cleanQuality, dispatch, fileExists,
  providerStatus, renderConfigured, scenePath, tourLimitReason, usageFor,
} from '../services/render.service';
import { cleanNodes, cleanPlan, newShareToken, tourView } from '../services/tour.service';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_SCENE_BYTES = 300 * 1024 * 1024;
const NOT_SET_UP = '360° tours are not available yet.';

async function ownTour(id: string, userId: string) {
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from('tours').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

/** Ask RunPod about panoramas that have gone quiet (a webhook may be lost). */
async function syncTour(tourId: string) {
  if (!renderConfigured()) return;
  const stale = new Date(Date.now() - 30 * 1000).toISOString();
  const { data: jobs } = await supabase.from('render_jobs')
    .select('provider_job_id').eq('tour_id', tourId).in('status', ['queued', 'running'])
    .lt('created_at', stale).not('provider_job_id', 'is', null).limit(4);
  for (const j of jobs ?? []) {
    const st = await providerStatus(j.provider_job_id).catch(() => null);
    if (st) await applyProviderUpdate(st).catch(() => undefined);
  }
}

// ── public ─────────────────────────────────────────────────────────────────

router.get('/shared/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token);
  if (!TOKEN.test(token)) return res.status(404).json({ success: false, error: 'Tour not found.' });
  try {
    const { data: tour } = await supabase.from('tours').select('*').eq('share_token', token).maybeSingle();
    if (!tour || !['done', 'partial'].includes(tour.status)) {
      return res.status(404).json({ success: false, error: 'Tour not found.' });
    }
    return res.json({ success: true, data: { tour: await tourView(tour, true) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── owner ──────────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!renderConfigured()) return res.status(503).json({ success: false, error: NOT_SET_UP });
  const userId = req.user!.id;
  const { projectId, sceneHash, sceneBytes } = req.body ?? {};
  const quality = cleanQuality(req.body?.quality);
  const nodes = cleanNodes(req.body?.nodes);
  const plan = cleanPlan(req.body?.plan);
  if (typeof projectId !== 'string' || !UUID.test(projectId) || !nodes || !plan) {
    return res.status(400).json({ success: false, error: 'Bad tour request.' });
  }
  if (typeof sceneHash !== 'string' || !SHA256.test(sceneHash)) return res.status(400).json({ success: false, error: 'Bad scene.' });
  if (!(Number(sceneBytes) > 0 && Number(sceneBytes) <= MAX_SCENE_BYTES)) {
    return res.status(413).json({ success: false, error: 'This scene is too large to render.' });
  }
  const specs = nodes.map(n => cleanPanoSpec(req.body?.lights, n.position, quality));
  if (specs.some(s => !s)) return res.status(400).json({ success: false, error: 'Bad tour request.' });
  try {
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle();
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
    const why = tourLimitReason(await usageFor(userId), nodes.length, quality);
    if (why) return res.status(429).json({ success: false, error: why });

    const path = scenePath(userId, sceneHash);
    let upload: { url: string } | null = null;
    if (!(await fileExists(path))) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(error?.message ?? 'upload link');
      upload = { url: data.signedUrl };
    }
    const title = (typeof req.body?.title === 'string' && req.body.title.trim().slice(0, 80)) || '360° tour';
    const { data: tour, error } = await supabase.from('tours').insert({
      project_id: projectId, user_id: userId, title, quality, status: 'uploading', nodes, plan, scene_path: path,
    }).select('*').single();
    if (error) throw error;
    const { error: e2 } = await supabase.from('render_jobs').insert(nodes.map((n, i) => ({
      project_id: projectId, user_id: userId, kind: 'panorama', quality, status: 'uploading',
      spec: specs[i], scene_path: path, width: specs[i]!.width, height: specs[i]!.height,
      tour_id: tour.id, node_id: n.id,
    })));
    if (e2) {
      await supabase.from('tours').delete().eq('id', tour.id);
      throw e2;
    }
    return res.status(201).json({ success: true, data: { tour: await tourView(tour), upload } });
  } catch (err: any) {
    console.error('[tours] create', err?.message);
    return res.status(500).json({ success: false, error: 'Could not start the tour.' });
  }
});

router.post('/:id/start', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!renderConfigured()) return res.status(503).json({ success: false, error: NOT_SET_UP });
  const userId = req.user!.id;
  try {
    const tour = await ownTour(String(req.params.id), userId);
    if (!tour) return res.status(404).json({ success: false, error: 'Tour not found.' });
    if (tour.status !== 'uploading') return res.json({ success: true, data: { tour: await tourView(tour) } });
    if (!(await fileExists(tour.scene_path))) {
      return res.status(409).json({ success: false, error: 'The scene upload did not arrive. Please try again.' });
    }
    // claim it, so a double click can't send the rooms twice
    const { data: claimed } = await supabase.from('tours').update({ status: 'rendering' })
      .eq('id', tour.id).eq('status', 'uploading').select('*').maybeSingle();
    if (!claimed) return res.json({ success: true, data: { tour: await tourView(await ownTour(tour.id, userId)) } });

    const { data: jobs } = await supabase.from('render_jobs').select('*').eq('tour_id', tour.id).eq('status', 'uploading');
    let sent = 0;
    for (const job of jobs ?? []) {
      try {
        await supabase.from('render_jobs').update({ status: 'queued' }).eq('id', job.id);
        const { providerJobId, resultPath } = await dispatch(job);
        await supabase.from('render_jobs').update({ provider_job_id: providerJobId, result_path: resultPath }).eq('id', job.id);
        sent++;
      } catch (err: any) {
        console.error('[tours] dispatch', err?.message);
        await supabase.from('render_jobs').update({
          status: 'failed', error: String(err?.message).slice(0, 500), finished_at: new Date().toISOString(),
        }).eq('id', job.id);
      }
    }
    if (!sent) {
      await supabase.from('tours').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', tour.id);
      return res.status(502).json({ success: false, error: 'The render server did not accept the tour. Please try again.' });
    }
    return res.json({ success: true, data: { tour: await tourView(claimed) } });
  } catch (err: any) {
    console.error('[tours] start', err?.message);
    return res.status(500).json({ success: false, error: 'Could not start the tour.' });
  }
});

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const projectId = String(req.query.projectId ?? '');
  if (!UUID.test(projectId)) return res.status(400).json({ success: false, error: 'Bad project.' });
  try {
    const { data, error } = await supabase.from('tours')
      .select('id, title, status, quality, created_at, nodes, share_token')
      .eq('project_id', projectId).eq('user_id', req.user!.id).neq('status', 'uploading')
      .order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return res.json({
      success: true,
      data: {
        items: (data ?? []).map((t: any) => ({
          id: t.id, title: t.title, status: t.status, quality: t.quality, createdAt: t.created_at,
          rooms: Array.isArray(t.nodes) ? t.nodes.length : 0, shared: !!t.share_token,
        })),
        available: renderConfigured(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    let tour = await ownTour(String(req.params.id), req.user!.id);
    if (!tour) return res.status(404).json({ success: false, error: 'Tour not found.' });
    if (tour.status === 'rendering') {
      await syncTour(tour.id);
      tour = await ownTour(tour.id, req.user!.id);
    }
    return res.json({ success: true, data: { tour: await tourView(tour) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/share', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const tour = await ownTour(String(req.params.id), req.user!.id);
    if (!tour) return res.status(404).json({ success: false, error: 'Tour not found.' });
    const on = req.body?.on !== false;
    const token = on ? (tour.share_token ?? newShareToken()) : null;
    const { data, error } = await supabase.from('tours').update({ share_token: token }).eq('id', tour.id).select('*').single();
    if (error) throw error;
    return res.json({ success: true, data: { tour: await tourView(data) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
