jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn(), storage: { from: jest.fn() } } }));
jest.mock('../services/notifications.service', () => ({ notify: jest.fn() }));
import {
  cleanSpec, cleanQuality, limitReason, mapProviderStatus, costFor, secretMatches, scenePath, resultPath, SHA256,
} from '../services/render.service';

const cfg = {
  apiKey: 'k', endpointId: 'e', webhookSecret: 's3cret', callbackBase: 'https://api.x',
  dailyPerUser: 20, monthlyCapUsd: 50, usdPerSecond: 0.0004, maxInFlight: 2,
};

const spec = {
  width: 1280, height: 760, samples: 99999,
  camera: { position: [1, 1.6, 2], quaternion: [0, 0.7, 0, 0.7], fovDeg: 60 },
  sun: { direction: [0.5, 0.8, 0.3], color: '#fff1c8', intensity: 2.8 },
  lamps: [{ position: [2, 2.4, 0.3], color: '#ffeedd', intensity: 5, distance: 9 }, { position: 'x' }],
  environment: 0.6,
};

describe('photo render spec', () => {
  it('takes size and samples from the quality, keeping the shape', () => {
    const s = cleanSpec(spec, 'standard')!;
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1140);
    expect(s.samples).toBe(256);
    const h = cleanSpec(spec, 'high')!;
    expect(h.width).toBe(3840);
    expect(h.samples).toBe(512);
    const tall = cleanSpec({ ...spec, width: 600, height: 1000 }, 'standard')!;
    expect(tall.height).toBe(1920);
    expect(tall.width % 2).toBe(0);
  });
  it('drops bad lamps and rejects a bad camera', () => {
    expect(cleanSpec(spec, 'standard')!.lamps).toHaveLength(1);
    expect(cleanSpec({ ...spec, camera: { position: [1, 2], quaternion: [0, 0, 0, 1], fovDeg: 50 } }, 'standard')).toBeNull();
    expect(cleanSpec({ ...spec, sun: { direction: [0, 1, 0], color: 'red', intensity: 1 } }, 'standard')!.sun).toBeNull();
    expect(cleanSpec(null, 'standard')).toBeNull();
  });
  it('defaults quality to standard', () => {
    expect(cleanQuality('high')).toBe('high');
    expect(cleanQuality('ultra')).toBe('standard');
  });
});

describe('photo render limits', () => {
  it('blocks a third render in flight, the daily quota and the monthly cap', () => {
    expect(limitReason({ today: 3, inFlight: 0, monthUsd: 1 }, 'standard', cfg)).toBeNull();
    expect(limitReason({ today: 3, inFlight: 2, monthUsd: 1 }, 'standard', cfg)).toMatch(/in progress/);
    expect(limitReason({ today: 20, inFlight: 0, monthUsd: 1 }, 'standard', cfg)).toMatch(/limit of 20/);
    expect(limitReason({ today: 1, inFlight: 0, monthUsd: 49.97 }, 'standard', cfg)).toMatch(/paused/);
    expect(limitReason({ today: 1, inFlight: 0, monthUsd: 49.9 }, 'standard', cfg)).toBeNull();
  });
});

describe('RunPod glue', () => {
  it('maps statuses', () => {
    expect(mapProviderStatus('IN_QUEUE')).toBe('queued');
    expect(mapProviderStatus('IN_PROGRESS')).toBe('running');
    expect(mapProviderStatus('COMPLETED')).toBe('done');
    expect(mapProviderStatus('TIMED_OUT')).toBe('failed');
    expect(mapProviderStatus('CANCELLED')).toBe('cancelled');
    expect(mapProviderStatus('???')).toBeNull();
  });
  it('costs GPU time', () => {
    expect(costFor(90_000, cfg)).toEqual({ gpuSeconds: 90, costUsd: 0.036 });
    expect(costFor(undefined, cfg)).toEqual({ gpuSeconds: 0, costUsd: 0 });
  });
  it('checks the webhook secret', () => {
    expect(secretMatches('s3cret', cfg)).toBe(true);
    expect(secretMatches('s3creT', cfg)).toBe(false);
    expect(secretMatches(undefined, cfg)).toBe(false);
    expect(secretMatches('x', { ...cfg, webhookSecret: '' })).toBe(false);
  });
  it('keeps files under the owner', () => {
    const h = 'a'.repeat(64);
    expect(SHA256.test(h)).toBe(true);
    expect(SHA256.test('../x')).toBe(false);
    expect(scenePath('u1', h)).toBe(`render-scenes/u1/${h}.glb.gz`);
    expect(resultPath('u1', 'p1', 'j1')).toBe('renders/u1/p1/j1.jpg');
  });
});

describe('applyProviderUpdate', () => {
  const { supabase } = jest.requireMock('../services/supabase');
  const { notify } = jest.requireMock('../services/notifications.service');
  const { applyProviderUpdate } = require('../services/render.service');

  function mockJob(job: any) {
    const updates: any[] = [];
    supabase.from.mockImplementation(() => {
      const q: any = {
        select: () => q, eq: () => q, not: () => q,
        maybeSingle: async () => ({ data: q._update ? { id: job.id } : job }),
        update: (p: any) => { updates.push(p); q._update = p; return q; },
      };
      return q;
    });
    return updates;
  }
  beforeEach(() => { notify.mockReset(); });

  it('marks a finished job done, records cost and tells the owner', async () => {
    const updates = mockJob({ id: 'j1', user_id: 'u1', project_id: 'p1', status: 'running' });
    await applyProviderUpdate({ id: 'rp1', status: 'COMPLETED', executionTime: 60000, output: { ok: true, stats: { device: 'OPTIX' } } });
    expect(updates[0]).toMatchObject({ status: 'done', gpu_seconds: 60, stats: { device: 'OPTIX' } });
    expect(notify).toHaveBeenCalledWith('u1', expect.objectContaining({ type: 'render', link: '/canvas?projectId=p1' }));
  });
  it('treats a "completed" job without an image as failed', async () => {
    const updates = mockJob({ id: 'j1', user_id: 'u1', project_id: 'p1', status: 'running' });
    await applyProviderUpdate({ id: 'rp1', status: 'COMPLETED', executionTime: 1000, output: {} });
    expect(updates[0]).toMatchObject({ status: 'failed' });
  });
  it('never changes a finished job', async () => {
    const updates = mockJob({ id: 'j1', user_id: 'u1', project_id: 'p1', status: 'done' });
    await applyProviderUpdate({ id: 'rp1', status: 'FAILED' });
    expect(updates).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
