/**
 * Photo renders — services/render.service.ts
 * ============================================================================
 * A photo render is made by Blender (Cycles) on a RunPod serverless GPU, not
 * in the browser. The flow:
 *
 *   1. POST /renders            the browser says what it wants (quality, the
 *                               camera/light spec, the scene's sha-256). We
 *                               check the limits, create a job, and hand back
 *                               a signed upload URL — unless that exact scene
 *                               is already stored (same room, new angle).
 *   2. browser uploads          scene.glb.gz straight to storage
 *   3. POST /renders/:id/start  we check the scene is there and send the job
 *                               to RunPod with a webhook back to us
 *   4. RunPod → webhook         the worker has uploaded the image; we mark the
 *                               job done, record GPU time and cost, notify
 *   5. GET /renders/:id         the browser polls; if a webhook went missing
 *                               we ask RunPod directly
 *
 * Free for now, so it is fenced: renders per person per day, a monthly spend
 * cap across everyone, at most two in flight per person, and a hard time
 * limit per job. Cost is recorded per job so it can be charged later.
 *
 * Setup (Railway env):
 *   RUNPOD_API_KEY, RUNPOD_RENDER_ENDPOINT_ID   the serverless endpoint
 *   RENDER_WEBHOOK_SECRET                       any long random string
 *   RENDER_CALLBACK_BASE_URL                    this API's public URL
 *   RENDER_DAILY_PER_USER      (default 20)
 *   RENDER_MONTHLY_CAP_USD     (default 50)
 *   RENDER_USD_PER_SECOND      (default 0.0004 — set to the endpoint's GPU price)
 */

import crypto from 'crypto';
import { supabase } from './supabase';
import { notify } from './notifications.service';

export const BUCKET = 'nooi-projects';

export type Quality = 'standard' | 'high';
export type JobStatus = 'uploading' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What each quality may ask for. The browser's spec is clamped to this. */
export const QUALITY: Record<Quality, { long: number; samples: number; timeLimitS: number; estimateUsd: number }> = {
  standard: { long: 1920, samples: 256, timeLimitS: 240, estimateUsd: 0.05 },
  high: { long: 3840, samples: 512, timeLimitS: 300, estimateUsd: 0.12 },
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function renderConfig() {
  return {
    apiKey: process.env.RUNPOD_API_KEY || '',
    endpointId: process.env.RUNPOD_RENDER_ENDPOINT_ID || '',
    webhookSecret: process.env.RENDER_WEBHOOK_SECRET || '',
    callbackBase: (process.env.RENDER_CALLBACK_BASE_URL || '').replace(/\/+$/, ''),
    dailyPerUser: num(process.env.RENDER_DAILY_PER_USER, 20),
    monthlyCapUsd: num(process.env.RENDER_MONTHLY_CAP_USD, 50),
    usdPerSecond: num(process.env.RENDER_USD_PER_SECOND, 0.0004),
    maxInFlight: 2,
  };
}

export const renderConfigured = () => {
  const c = renderConfig();
  return !!(c.apiKey && c.endpointId && c.webhookSecret && c.callbackBase);
};

// ── the spec ───────────────────────────────────────────────────────────────

type V3 = [number, number, number];
export interface RenderSpec {
  version: 1;
  width: number;
  height: number;
  samples: number;
  camera: { position: V3; quaternion: [number, number, number, number]; fovDeg: number };
  sun: { direction: V3; color: string; intensity: number } | null;
  lamps: { position: V3; color: string; intensity: number; distance: number }[];
  environment: number;
}

const finite = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
const vec = (v: unknown, n: number, lo = -1e4, hi = 1e4): number[] | null => {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out = v.map(x => finite(x, lo, hi));
  return out.every(x => x !== null) ? (out as number[]) : null;
};
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The browser's spec, checked and clamped: the size and samples come from the
 * quality, whatever was sent, so nobody can order a 16K render on the free
 * tier. Null when it can't be used at all.
 */
export function cleanSpec(raw: unknown, quality: Quality): RenderSpec | null {
  const r = (raw ?? {}) as Record<string, any>;
  const cam = r.camera ?? {};
  const position = vec(cam.position, 3);
  const quaternion = vec(cam.quaternion, 4, -1, 1);
  const fovDeg = finite(cam.fovDeg, 10, 120);
  if (!position || !quaternion || fovDeg === null) return null;

  // keep the browser's shape, at this quality's size
  const w = finite(r.width, 1, 1e5) ?? 16, h = finite(r.height, 1, 1e5) ?? 9;
  const aspect = Math.min(3, Math.max(1 / 3, w / h));
  const long = QUALITY[quality].long;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const size = aspect >= 1 ? { width: long, height: even(long / aspect) } : { width: even(long * aspect), height: long };

  let sun: RenderSpec['sun'] = null;
  if (r.sun) {
    const direction = vec(r.sun.direction, 3, -1, 1);
    const intensity = finite(r.sun.intensity, 0, 20);
    if (direction && intensity !== null && HEX.test(String(r.sun.color))) {
      sun = { direction: direction as V3, color: String(r.sun.color), intensity };
    }
  }
  const lamps: RenderSpec['lamps'] = [];
  for (const l of Array.isArray(r.lamps) ? r.lamps.slice(0, 64) : []) {
    const p = vec(l?.position, 3);
    const intensity = finite(l?.intensity, 0, 200);
    const distance = finite(l?.distance, 0, 1000);
    if (p && intensity !== null && distance !== null && HEX.test(String(l?.color))) {
      lamps.push({ position: p as V3, color: String(l.color), intensity, distance });
    }
  }
  return {
    version: 1,
    ...size,
    samples: QUALITY[quality].samples,
    camera: { position: position as V3, quaternion: quaternion as RenderSpec['camera']['quaternion'], fovDeg },
    sun,
    lamps,
    environment: finite(r.environment, 0, 10) ?? 0.6,
  };
}

export const cleanQuality = (q: unknown): Quality => (q === 'high' ? 'high' : 'standard');

export interface PanoSpec extends Omit<RenderSpec, 'camera'> {
  panorama: true;
  camera: { position: V3; quaternion: [0, 0, 0, 1]; fovDeg: 90 };
}

/** A panorama's spec: the lights from the browser, the point it's taken
 *  from, and the size and samples from the quality. */
export function cleanPanoSpec(lights: unknown, position: unknown, quality: Quality): PanoSpec | null {
  const pos = vec(position, 3);
  if (!pos) return null;
  // reuse the image spec's checks for the sun and the lamps
  const base = cleanSpec({ ...(lights as object ?? {}), camera: { position: pos, quaternion: [0, 0, 0, 1], fovDeg: 90 } }, quality);
  if (!base) return null;
  const q = PANO_QUALITY[quality];
  return {
    ...base,
    panorama: true,
    width: q.width,
    height: q.height,
    samples: q.samples,
    camera: { position: pos as V3, quaternion: [0, 0, 0, 1], fovDeg: 90 },
  };
}
export const SHA256 = /^[a-f0-9]{64}$/;

export const scenePath = (userId: string, hash: string) => `render-scenes/${userId}/${hash}.glb.gz`;
export const resultPath = (userId: string, projectId: string, jobId: string) => `renders/${userId}/${projectId}/${jobId}.jpg`;

// ── limits ─────────────────────────────────────────────────────────────────

export interface Usage { today: number; inFlight: number; monthUsd: number }

/** Why this render can't start, or null. Pure, so it is tested on its own. */
export function limitReason(u: Usage, quality: Quality, cfg = renderConfig()): string | null {
  if (u.inFlight >= cfg.maxInFlight) return 'You already have renders in progress. Please wait for them to finish.';
  if (u.today >= cfg.dailyPerUser) return `You've reached today's limit of ${cfg.dailyPerUser} photo renders. Try again tomorrow.`;
  if (u.monthUsd + QUALITY[quality].estimateUsd > cfg.monthlyCapUsd) {
    return 'Photo renders are paused for the rest of the month. Please try again later.';
  }
  return null;
}

const COUNTED: JobStatus[] = ['queued', 'running', 'done'];

/** Why a tour of `rooms` panoramas can't start, or null. */
export function tourLimitReason(u: Usage, rooms: number, quality: Quality, cfg = renderConfig()): string | null {
  if (u.today + rooms * jobWeight('panorama') > cfg.dailyPerUser) {
    return `A tour of ${rooms} rooms would go over today's render limit. Try fewer rooms, or again tomorrow.`;
  }
  if (u.monthUsd + rooms * PANO_QUALITY[quality].estimateUsd > cfg.monthlyCapUsd) {
    return 'Renders are paused for the rest of the month. Please try again later.';
  }
  return null;
}

/** A panorama is about two images' worth of GPU time; it counts as two. */
export const jobWeight = (kind: unknown) => (kind === 'panorama' ? 2 : 1);

/** 360° panoramas: 2:1, one per room. */
export const PANO_QUALITY: Record<Quality, { width: number; height: number; samples: number; timeLimitS: number; estimateUsd: number }> = {
  standard: { width: 4096, height: 2048, samples: 256, timeLimitS: 300, estimateUsd: 0.06 },
  high: { width: 8192, height: 4096, samples: 256, timeLimitS: 480, estimateUsd: 0.18 },
};

export const estimateFor = (kind: unknown, quality: unknown) =>
  kind === 'panorama' ? PANO_QUALITY[cleanQuality(quality)].estimateUsd : QUALITY[cleanQuality(quality)].estimateUsd;

export async function usageFor(userId: string): Promise<Usage> {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);

  const [{ data: mine }, { data: month }] = await Promise.all([
    supabase.from('render_jobs').select('status, kind').eq('user_id', userId).in('status', COUNTED).gte('created_at', dayAgo),
    supabase.from('render_jobs').select('status, kind, quality, cost_usd').in('status', COUNTED).gte('created_at', monthStart.toISOString()),
  ]);
  const monthUsd = (month ?? []).reduce((s: number, j: any) =>
    s + (j.status === 'done' ? Number(j.cost_usd) || 0 : estimateFor(j.kind, j.quality)), 0);
  return {
    today: (mine ?? []).reduce((s: number, j: any) => s + jobWeight(j.kind), 0),
    // only single photos: a tour queues several panoramas on purpose
    inFlight: (mine ?? []).filter((j: any) => (j.status === 'queued' || j.status === 'running') && j.kind !== 'panorama').length,
    monthUsd,
  };
}

// ── storage ────────────────────────────────────────────────────────────────

export async function fileExists(path: string): Promise<boolean> {
  const i = path.lastIndexOf('/');
  const { data } = await supabase.storage.from(BUCKET).list(path.slice(0, i), { search: path.slice(i + 1), limit: 1 });
  return !!data?.some(f => f.name === path.slice(i + 1));
}

// ── RunPod ─────────────────────────────────────────────────────────────────

const RUNPOD = 'https://api.runpod.ai/v2';

/** RunPod's job status → ours. */
export function mapProviderStatus(s: unknown): JobStatus | null {
  switch (s) {
    case 'IN_QUEUE': return 'queued';
    case 'IN_PROGRESS': return 'running';
    case 'COMPLETED': return 'done';
    case 'FAILED': case 'TIMED_OUT': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: return null;
  }
}

export const costFor = (executionMs: unknown, cfg = renderConfig()) => {
  const s = Math.max(0, Number(executionMs) || 0) / 1000;
  return { gpuSeconds: Math.round(s * 100) / 100, costUsd: Math.round(s * cfg.usdPerSecond * 10000) / 10000 };
};

export function webhookUrl(cfg = renderConfig()) {
  return `${cfg.callbackBase}/renders/webhook?secret=${encodeURIComponent(cfg.webhookSecret)}`;
}

export function secretMatches(given: unknown, cfg = renderConfig()): boolean {
  if (!cfg.webhookSecret || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(cfg.webhookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Send a job to the GPU. Returns RunPod's job id. */
export async function dispatch(job: { id: string; user_id: string; project_id: string; quality: string; kind?: string; spec: RenderSpec | PanoSpec; scene_path: string }) {
  const cfg = renderConfig();
  const quality = cleanQuality(job.quality);
  const out = resultPath(job.user_id, job.project_id, job.id);

  const [{ data: sceneUrl, error: e1 }, { data: upload, error: e2 }] = await Promise.all([
    supabase.storage.from(BUCKET).createSignedUrl(job.scene_path, 3600),
    supabase.storage.from(BUCKET).createSignedUploadUrl(out, { upsert: true }),
  ]);
  if (e1 || !sceneUrl?.signedUrl) throw new Error(`scene link: ${e1?.message ?? 'missing'}`);
  if (e2 || !upload?.signedUrl) throw new Error(`upload link: ${e2?.message ?? 'missing'}`);

  const limit = (job as any).kind === 'panorama' ? PANO_QUALITY[quality].timeLimitS : QUALITY[quality].timeLimitS;
  const res = await fetch(`${RUNPOD}/${cfg.endpointId}/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: {
        job_id: job.id,
        scene_url: sceneUrl.signedUrl,
        spec: job.spec,
        result_upload_url: upload.signedUrl,
        time_limit_s: limit,
      },
      webhook: webhookUrl(cfg),
      // waiting in the queue for a GPU, then the run itself (+ start-up)
      policy: { executionTimeout: (limit + 60) * 1000, ttl: 30 * 60 * 1000 },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.id) throw new Error(`RunPod: ${res.status} ${body?.error ?? ''}`.trim());
  return { providerJobId: String(body.id), resultPath: out };
}

export async function providerStatus(providerJobId: string) {
  const cfg = renderConfig();
  const res = await fetch(`${RUNPOD}/${cfg.endpointId}/status/${encodeURIComponent(providerJobId)}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<any>;
}

// ── job updates (webhook and polling share these) ──────────────────────────

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Apply a RunPod status payload ({id, status, output, error, executionTime})
 * to our job. Idempotent: a finished job is never changed again, so a late
 * webhook after a poll (or a repeat) does nothing.
 */
export async function applyProviderUpdate(payload: any): Promise<void> {
  const providerJobId = payload?.id ? String(payload.id) : '';
  const next = mapProviderStatus(payload?.status);
  if (!providerJobId || !next) return;

  const { data: job } = await supabase.from('render_jobs')
    .select('id, user_id, project_id, status, result_path, tour_id')
    .eq('provider_job_id', providerJobId).maybeSingle();
  if (!job || TERMINAL.includes(job.status)) return;

  const patch: Record<string, unknown> = { status: next };
  if (next === 'running' && job.status !== 'running') patch.started_at = new Date().toISOString();

  if (TERMINAL.includes(next)) {
    const { gpuSeconds, costUsd } = costFor(payload.executionTime);
    Object.assign(patch, { finished_at: new Date().toISOString(), gpu_seconds: gpuSeconds, cost_usd: costUsd });
    const ok = next === 'done' && payload.output?.ok === true;
    if (next === 'done' && !ok) {
      patch.status = 'failed';
      patch.error = 'The render did not finish.';
    } else if (ok) {
      patch.stats = payload.output?.stats ?? null;
    } else {
      patch.error = String(payload.error ?? payload.status).slice(0, 500);
    }
  }

  // only move forward from where it was (guards against a racing update)
  const { data: updated } = await supabase.from('render_jobs').update(patch)
    .eq('id', job.id).not('status', 'in', `(${TERMINAL.join(',')})`).select('id').maybeSingle();
  if (!updated) return;

  // a tour's panoramas report once, when the whole tour is finished
  if (job.tour_id) {
    if (TERMINAL.includes(patch.status as JobStatus)) await finishTourIfDone(job.tour_id);
    return;
  }

  if (patch.status === 'done') {
    await notify(job.user_id, {
      title: 'Your photo render is ready',
      message: 'Open the project to see and download it.',
      type: 'render',
      link: `/canvas?projectId=${job.project_id}`,
    });
  } else if (patch.status === 'failed') {
    await notify(job.user_id, {
      title: 'A photo render failed',
      message: 'Something went wrong while rendering. Please try again.',
      type: 'render',
      link: `/canvas?projectId=${job.project_id}`,
    });
  }
}

/** The job as the browser sees it: no internal paths, a link to the image. */
export async function publicJob(job: any) {
  let url: string | null = null;
  if (job.status === 'done' && job.result_path) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(job.result_path, 24 * 3600);
    url = data?.signedUrl ?? null;
  }
  return {
    id: job.id,
    projectId: job.project_id,
    kind: job.kind,
    quality: job.quality,
    status: job.status as JobStatus,
    width: job.width,
    height: job.height,
    url,
    error: job.status === 'failed' ? (job.error ? 'The render failed. Please try again.' : 'The render failed.') : null,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
  };
}

/**
 * When every panorama of a tour has finished: mark the tour done (or partly
 * done, if some rooms failed) and tell its owner. Safe to call repeatedly —
 * only the call that moves the tour out of "rendering" notifies.
 */
export async function finishTourIfDone(tourId: string): Promise<void> {
  const { data: jobs } = await supabase.from('render_jobs').select('status').eq('tour_id', tourId);
  if (!jobs?.length || jobs.some((j: any) => !TERMINAL.includes(j.status))) return;
  const ok = jobs.filter((j: any) => j.status === 'done').length;
  const status = ok === jobs.length ? 'done' : ok > 0 ? 'partial' : 'failed';
  const { data: tour } = await supabase.from('tours')
    .update({ status, finished_at: new Date().toISOString() })
    .eq('id', tourId).eq('status', 'rendering')
    .select('id, user_id, project_id').maybeSingle();
  if (!tour) return;
  await notify(tour.user_id, status === 'failed'
    ? { title: 'A 360° tour failed', message: 'Something went wrong while rendering it. Please try again.', type: 'render', link: `/tour/${tour.id}` }
    : {
        title: 'Your 360° tour is ready',
        message: status === 'partial' ? `${ok} of ${jobs.length} rooms are ready; the others failed.` : 'Open it to walk through your design.',
        type: 'render',
        link: `/tour/${tour.id}`,
      });
}
