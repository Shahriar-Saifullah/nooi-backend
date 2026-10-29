/**
 * Tripo3D provider — services/model3d/tripo.ts
 * ============================================================================
 * Tripo API v3 (https://developers.tripo3d.com):
 *
 *   one photo     POST /v3/generation/image-to-model       { input: url, ... }
 *   2–4 sides     POST /v3/generation/multiview-to-model   { inputs: [{ front: url }, { left: url }, ...] }
 *   status        GET  /v3/tasks/{task_id}  → queued | running | success | failed | cancelled
 *   balance       GET  /v3/account/balance  (no credits used — scripts/tripo-check.ts)
 *
 * Photos are passed as their public Supabase URLs, so nothing is uploaded to
 * Tripo first. The finished GLB link is downloaded straight away by the worker
 * (Tripo's links are temporary).
 *
 * Settings (env):
 *   TRIPO_API_KEY          required
 *   TRIPO_MODEL            default v3.1-20260211 (Tripo's best H-series model)
 *   TRIPO_FACE_LIMIT       default 40000 — plenty for furniture on the web
 *   TRIPO_TEXTURE_QUALITY  standard (default) | detailed (+10 credits per model)
 *
 * Cost: 30 credits per model (textured), either endpoint, at standard quality.
 */

import type { ModelProvider, PollResult, SubmitInput } from './providers';

const BASE = (process.env.TRIPO_API_BASE || 'https://openapi.tripo3d.com/v3').replace(/\/+$/, '');

/** `permanent`: retrying the same request can't help (bad photo, bad key).
 *  `waitMs`: not a failure of the job — try again later (no credits, busy). */
export class ProviderError extends Error {
  constructor(message: string, public permanent = false, public waitMs = 0) { super(message); }
}

function key() {
  const k = process.env.TRIPO_API_KEY;
  if (!k) throw new ProviderError('TRIPO_API_KEY is not set.', false, 15 * 60_000);
  return k;
}

/** Tripo's error codes → what the job should do. */
function toError(httpStatus: number, body: any): ProviderError {
  const code = Number(body?.code);
  const msg = String(body?.message || `Tripo returned HTTP ${httpStatus}`);
  switch (code) {
    case 2010: return new ProviderError('The Tripo account is out of credits. Top up — jobs resume by themselves.', false, 15 * 60_000);
    case 2000: return new ProviderError('Tripo is busy with other jobs; will retry.', false, 60_000);
    case 1007: return new ProviderError('Tripo rate limit; will retry.', false, 60_000);
    case 1000: case 1001: return new ProviderError('Tripo rejected the API key. Check TRIPO_API_KEY.', false, 15 * 60_000);
    case 2008: return new ProviderError('Tripo refused these photos (content policy).', true);
    case 2003: case 2004: return new ProviderError('Tripo couldn\'t read a photo (empty or unsupported format — use JPG, PNG or WebP).', true);
    case 2002: return new ProviderError(`Tripo rejected the request: ${msg}`, true);
  }
  if (httpStatus === 429 || httpStatus >= 500) return new ProviderError(`Tripo is unavailable (${httpStatus}); will retry.`, false, 60_000);
  if (httpStatus === 401) return new ProviderError('Tripo rejected the API key. Check TRIPO_API_KEY.', false, 15 * 60_000);
  if (httpStatus === 403) return new ProviderError('The Tripo account is out of credits or not allowed to do this.', false, 15 * 60_000);
  return new ProviderError(msg, httpStatus === 400);
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`Could not reach Tripo (${e?.message || 'network error'}); will retry.`, false, 60_000);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || (json?.code !== undefined && json.code !== 0)) throw toError(res.status, json);
  return json.data ?? {};
}

function options() {
  const faceLimit = Number(process.env.TRIPO_FACE_LIMIT || 40000);
  const quality = (process.env.TRIPO_TEXTURE_QUALITY || 'standard').toLowerCase();
  return {
    model: process.env.TRIPO_MODEL || 'v3.1-20260211',
    texture: true,
    pbr: true,
    ...(Number.isFinite(faceLimit) && faceLimit > 0 ? { face_limit: Math.round(faceLimit) } : {}),
    texture_quality: ['standard', 'detailed'].includes(quality) ? quality : 'standard',
    // Orientation and compression are handled by us afterwards (optimize.ts),
    // as Tripo's docs advise when post-processing.
  };
}

export function tripoRequest(input: SubmitInput): { path: string; body: Record<string, unknown> } {
  if (input.mode === 'multiview' && input.images.length >= 2) {
    return {
      path: '/generation/multiview-to-model',
      body: { inputs: input.images.map(i => ({ [i.view]: i.url })), ...options() },
    };
  }
  const front = input.images.find(i => i.view === 'front') ?? input.images[0];
  if (!front) throw new ProviderError('No photo to build the model from.', true);
  return { path: '/generation/image-to-model', body: { input: front.url, ...options() } };
}

export const tripo: ModelProvider = {
  name: 'tripo',
  configured: () => Boolean(process.env.TRIPO_API_KEY),
  // Tripo exports with the front along +X unless told otherwise.
  forwardAxis: () => process.env.MODEL3D_FORWARD_AXIS || '+x',

  async submit(input) {
    const { path, body } = tripoRequest(input);
    const data = await call('POST', path, body);
    if (!data?.task_id) throw new ProviderError('Tripo did not return a task id; will retry.', false, 60_000);
    return String(data.task_id);
  },

  async poll(taskId): Promise<PollResult> {
    const t = await call('GET', `/tasks/${encodeURIComponent(taskId)}`);
    switch (t?.status) {
      case 'success': {
        const url = t.output?.model_url || t.output?.pbr_model || t.output?.model;
        if (!url) return { state: 'failed', error: 'Tripo finished but returned no model file.' };
        return { state: 'done', glbUrl: String(url), credits: Number(t.credits_consumed) || undefined };
      }
      case 'failed':
      case 'cancelled':
      case 'banned':
      case 'expired':
        return { state: 'failed', error: t.error_message || `Tripo task ${t.status}.` };
      default:
        return { state: 'running', progress: Math.max(0, Math.min(99, Number(t?.progress) || 0)) };
    }
  },

  async balance() {
    const d = await call('GET', '/account/balance');
    return { balance: Number(d.balance) || 0, frozen: Number(d.frozen) || 0 };
  },
};
