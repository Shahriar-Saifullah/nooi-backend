/**
 * 3D model providers — services/model3d/providers.ts
 * ============================================================================
 * Something that turns product photos into a GLB. The job pipeline only talks
 * to this interface, so the provider can change without touching the queue,
 * the admin page or the shop.
 *
 *   MODEL3D_PROVIDER=tripo  (default) Tripo3D — needs TRIPO_API_KEY (tripo.ts).
 *   MODEL3D_PROVIDER=mock   Finishes every job with a sample chair after ~20s.
 *                           For testing the whole flow without spending credits.
 *   MODEL3D_PROVIDER=off    Nothing generates. Admins can still upload GLBs.
 *
 * With tripo selected but no key, jobs simply wait in the queue and start as
 * soon as the key is set.
 */

export type View = 'front' | 'left' | 'back' | 'right';
import { tripo } from './tripo';

export const VIEWS: View[] = ['front', 'left', 'back', 'right'];

export interface SourceImage { view: View; url: string; }

export interface SubmitInput {
  mode: 'single' | 'multiview';
  images: SourceImage[];
}

export type PollResult =
  | { state: 'running'; progress: number }
  | { state: 'done'; glbUrl: string; credits?: number }
  | { state: 'failed'; error: string };

export interface ModelProvider {
  name: string;
  /** Has what it needs (keys) to run jobs right now. */
  configured(): boolean;
  /** Start a job; returns the provider's task id. */
  submit(input: SubmitInput): Promise<string>;
  poll(taskId: string): Promise<PollResult>;
  /** Which way the provider's models face, e.g. '+x'. We turn them to +Z. */
  forwardAxis?(): string;
  /** Remaining credits, where the provider has them. */
  balance?(): Promise<{ balance: number; frozen: number }>;
}

// ─── Mock ────────────────────────────────────────────────────────────────────

const MOCK_GLB =
  process.env.MODEL3D_MOCK_GLB_URL ||
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/SheenChair/glTF-Binary/SheenChair.glb';
const MOCK_SECONDS = 20;

const mock: ModelProvider = {
  name: 'mock',
  forwardAxis: () => '+z', // the sample chair already faces +Z
  configured: () => true,
  async submit() {
    return `mock_${Date.now()}`;
  },
  async poll(taskId) {
    const started = Number(taskId.replace('mock_', '')) || 0;
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed < MOCK_SECONDS) return { state: 'running', progress: Math.min(95, Math.round((elapsed / MOCK_SECONDS) * 100)) };
    return { state: 'done', glbUrl: MOCK_GLB };
  },
};

const off: ModelProvider = {
  name: 'off',
  configured: () => false,
  async submit() { throw new Error('3D generation is turned off.'); },
  async poll() { throw new Error('3D generation is turned off.'); },
};

export function activeModelProvider(): ModelProvider {
  const name = (process.env.MODEL3D_PROVIDER || 'tripo').toLowerCase();
  if (name === 'mock') return mock;
  if (name === 'off') return off;
  return tripo;
}
