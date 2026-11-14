/**
 * Photo renders — routes/render.routes.ts. The flow is described in
 * services/render.service.ts.
 *
 *   POST /renders                { projectId, quality, spec, sceneHash, sceneBytes }
 *   POST /renders/:id/start
 *   GET  /renders?projectId=     the project's renders, newest first
 *   GET  /renders/:id            one render (checks RunPod if it's overdue)
 *   POST /renders/webhook?secret RunPod's callback
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { AuthRequest } from '../types';
import { supabase } from '../services/supabase';
import {
  BUCKET, SHA256, applyProviderUpdate, cleanQuality, cleanSpec, dispatch, fileExists, limitReason,
  providerStatus, publicJob, renderConfigured, scenePath, secretMatches, usageFor,
} from '../services/render.service';

const router = Router();

const MAX_SCENE_BYTES = 300 * 1024 * 1024;
const NOT_SET_UP = 'Photo render is not available yet.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownProject(projectId: string, userId: string) {
  if (!UUID.test(projectId)) return false;
  const { data } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle();
  return !!data;
}

async function ownJob(id: string, userId: string) {
  if (!UUID.test(id)) return null;
  const { data } = await supabase.from('render_jobs').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data;
}

// RunPod's callback. Before /:id so "webhook" is not taken for an id.
router.post('/webhook', async (req: Request, res: Response) => {
  if (!secretMatches(req.query.secret)) return res.status(401).json({ success: false });
  try {
    await applyProviderUpdate(req.body);
  } catch (err: any) {
    console.error('[renders] webhook', err?.message);
  }
  // always 200 for a valid caller: a retry storm helps nobody, and a missed
  // update is picked up by polling
  return res.json({ success: true });
});

/** Ask for a render: limits, then a job and (if needed) an upload link. */
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!renderConfigured()) return res.status(503).json({ success: false, error: NOT_SET_UP });
  const userId = req.user!.id;
  const { projectId, sceneHash, sceneBytes } = req.body ?? {};
  const quality = cleanQuality(req.body?.quality);
  const spec = cleanSpec(req.body?.spec, quality);
  if (typeof projectId !== 'string' || !spec) return res.status(400).json({ success: false, error: 'Bad render request.' });
  if (typeof sceneHash !== 'string' || !SHA256.test(sceneHash)) return res.status(400).json({ success: false, error: 'Bad scene.' });
  if (!(Number(sceneBytes) > 0 && Number(sceneBytes) <= MAX_SCENE_BYTES)) {
    return res.status(413).json({ success: false, error: 'This scene is too large to render.' });
  }
  try {
    if (!(await ownProject(projectId, userId))) return res.status(404).json({ success: false, error: 'Project not found.' });
    const why = limitReason(await usageFor(userId), quality);
    if (why) return res.status(429).json({ success: false, error: why });

    const path = scenePath(userId, sceneHash);
    const have = await fileExists(path);
    let upload: { signedUrl: string; token: string; path: string } | null = null;
    if (!have) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(error?.message ?? 'upload link');
      upload = data;
    }
    const { data: job, error } = await supabase.from('render_jobs').insert({
      project_id: projectId, user_id: userId, kind: 'image', quality,
      status: 'uploading', spec, scene_path: path, width: spec.width, height: spec.height,
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({
      success: true,
      data: { job: await publicJob(job), upload: upload ? { url: upload.signedUrl } : null },
    });
  } catch (err: any) {
    console.error('[renders] create', err?.message);
    return res.status(500).json({ success: false, error: 'Could not start the render.' });
  }
});

/** The scene is uploaded: send the job to the GPU. */
router.post('/:id/start', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!renderConfigured()) return res.status(503).json({ success: false, error: NOT_SET_UP });
  const userId = req.user!.id;
  try {
    const job = await ownJob(String(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, error: 'Render not found.' });
    if (job.status !== 'uploading') return res.json({ success: true, data: { job: await publicJob(job) } });
    if (!(await fileExists(job.scene_path))) {
      return res.status(409).json({ success: false, error: 'The scene upload did not arrive. Please try again.' });
    }
    // the limits again: other renders may have started since the job was made
    const why = limitReason(await usageFor(userId), cleanQuality(job.quality));
    if (why) {
      await supabase.from('render_jobs').update({ status: 'cancelled', error: why }).eq('id', job.id);
      return res.status(429).json({ success: false, error: why });
    }
    // claim it first, so a double click can't send it twice
    const { data: claimed } = await supabase.from('render_jobs').update({ status: 'queued' })
      .eq('id', job.id).eq('status', 'uploading').select('*').maybeSingle();
    if (!claimed) return res.json({ success: true, data: { job: await publicJob(await ownJob(job.id, userId)) } });
    try {
      const { providerJobId, resultPath } = await dispatch(claimed);
      const { data: sent } = await supabase.from('render_jobs')
        .update({ provider_job_id: providerJobId, result_path: resultPath })
        .eq('id', job.id).select('*').single();
      return res.json({ success: true, data: { job: await publicJob(sent) } });
    } catch (err: any) {
      console.error('[renders] dispatch', err?.message);
      await supabase.from('render_jobs').update({ status: 'failed', error: String(err?.message).slice(0, 500), finished_at: new Date().toISOString() }).eq('id', job.id);
      return res.status(502).json({ success: false, error: 'The render server did not accept the job. Please try again.' });
    }
  } catch (err: any) {
    console.error('[renders] start', err?.message);
    return res.status(500).json({ success: false, error: 'Could not start the render.' });
  }
});

/** A project's renders, newest first (finished and in progress). */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const projectId = String(req.query.projectId ?? '');
  try {
    if (!(await ownProject(projectId, req.user!.id))) return res.status(404).json({ success: false, error: 'Project not found.' });
    const { data, error } = await supabase.from('render_jobs').select('*')
      .eq('project_id', projectId).eq('user_id', req.user!.id)
      .in('status', ['queued', 'running', 'done', 'failed'])
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ success: true, data: { items: await Promise.all((data ?? []).map(publicJob)), available: renderConfigured() } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/** One render. If RunPod has gone quiet for a while, ask it directly. */
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    let job = await ownJob(String(req.params.id), req.user!.id);
    if (!job) return res.status(404).json({ success: false, error: 'Render not found.' });
    const inFlight = job.status === 'queued' || job.status === 'running';
    const ageS = (Date.now() - new Date(job.created_at).getTime()) / 1000;
    if (inFlight && job.provider_job_id && ageS > 20 && renderConfigured()) {
      const st = await providerStatus(job.provider_job_id).catch(() => null);
      if (st) {
        await applyProviderUpdate(st);
        job = await ownJob(job.id, req.user!.id);
      }
    }
    return res.json({ success: true, data: { job: await publicJob(job) } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
