jest.mock('../services/supabase', () => ({ supabase: { from: jest.fn(), storage: { from: jest.fn() } } }));
jest.mock('../services/notifications.service', () => ({ notify: jest.fn() }));
import { cleanNodes, cleanPlan, newShareToken, MAX_TOUR_ROOMS } from '../services/tour.service';
import { cleanPanoSpec, tourLimitReason, jobWeight, PANO_QUALITY } from '../services/render.service';

const cfg = {
  apiKey: 'k', endpointId: 'e', webhookSecret: 's', callbackBase: 'https://x',
  dailyPerUser: 20, monthlyCapUsd: 50, usdPerSecond: 0.0002, maxInFlight: 2,
};

describe('tour nodes and plan', () => {
  const nodes = [
    { id: 'n1', roomId: 'r1', name: 'Living', position: [0, 1.55, 0], links: [{ to: 'n2', at: [1, 0] }, { to: 'nope', at: [0, 0] }, { to: 'n1', at: [0, 0] }] },
    { id: 'n2', roomId: 'r2', name: 'Kitchen', position: [3, 1.55, 0], links: [{ to: 'n1', at: [1, 0] }] },
  ];
  it('keeps good nodes and drops links to unknown rooms or to itself', () => {
    const c = cleanNodes(nodes)!;
    expect(c).toHaveLength(2);
    expect(c[0].links).toEqual([{ to: 'n2', at: [1, 0] }]);
  });
  it('rejects bad input', () => {
    expect(cleanNodes([])).toBeNull();
    expect(cleanNodes([{ ...nodes[0], id: '../x' }])).toBeNull();
    expect(cleanNodes([{ ...nodes[0], position: [0, 1] }])).toBeNull();
    expect(cleanNodes([nodes[0], nodes[0]])).toBeNull(); // duplicate ids
    expect(cleanNodes(Array.from({ length: MAX_TOUR_ROOMS + 1 }, (_, i) => ({ ...nodes[0], id: `n${i}`, links: [] })))).toBeNull();
  });
  it('checks the plan outline', () => {
    const plan = cleanPlan({ rooms: [{ id: 'r1', name: 'Living', poly: [[0, 0], [4, 0], [4, 3]] }, { id: 'bad', poly: [[0, 0]] }], bounds: [0, 0, 4, 3] })!;
    expect(plan.rooms).toHaveLength(1);
    expect(cleanPlan({ rooms: [], bounds: [0, 0, 0, 3] })).toBeNull();
    expect(cleanPlan(null)).toBeNull();
  });
  it('makes unguessable share tokens', () => {
    const a = newShareToken(), b = newShareToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});

describe('panorama spec and limits', () => {
  const lights = { sun: { direction: [0.5, 0.8, 0.3], color: '#fff1c8', intensity: 2.8 }, lamps: [], environment: 0.6 };
  it('takes size from the quality and the point from the node', () => {
    const s = cleanPanoSpec(lights, [1, 1.55, 2], 'standard')!;
    expect(s.panorama).toBe(true);
    expect([s.width, s.height]).toEqual([4096, 2048]);
    expect(s.camera.position).toEqual([1, 1.55, 2]);
    expect(s.sun?.intensity).toBe(2.8);
    expect(cleanPanoSpec(lights, [1, 2], 'standard')).toBeNull();
    expect(cleanPanoSpec(lights, [0, 1.5, 0], 'high')!.width).toBe(8192);
  });
  it('counts a panorama as two renders against the daily limit', () => {
    expect(jobWeight('panorama')).toBe(2);
    expect(jobWeight('image')).toBe(1);
    expect(tourLimitReason({ today: 6, inFlight: 0, monthUsd: 1 }, 7, 'standard', cfg)).toBeNull();
    expect(tourLimitReason({ today: 7, inFlight: 0, monthUsd: 1 }, 7, 'standard', cfg)).toMatch(/7 rooms/);
    expect(tourLimitReason({ today: 0, inFlight: 0, monthUsd: 50 - 5 * PANO_QUALITY.standard.estimateUsd + 0.01 }, 5, 'standard', cfg)).toMatch(/paused/);
  });
});

describe('finishing a tour', () => {
  const { supabase } = jest.requireMock('../services/supabase');
  const { notify } = jest.requireMock('../services/notifications.service');
  const { finishTourIfDone } = require('../services/render.service');

  function mock(jobs: any[], claimed = true) {
    const updates: any[] = [];
    supabase.from.mockImplementation((table: string) => {
      const q: any = {
        select: () => q, eq: () => q,
        update: (p: any) => { updates.push(p); return q; },
        maybeSingle: async () => ({ data: claimed ? { id: 't1', user_id: 'u1', project_id: 'p1' } : null }),
        then: (fn: any) => fn({ data: table === 'render_jobs' ? jobs : null }),
      };
      return q;
    });
    return updates;
  }
  beforeEach(() => notify.mockReset());

  it('waits while rooms are still rendering', async () => {
    const u = mock([{ status: 'done' }, { status: 'running' }]);
    await finishTourIfDone('t1');
    expect(u).toHaveLength(0);
  });
  it('marks it done and notifies once everything is in', async () => {
    const u = mock([{ status: 'done' }, { status: 'done' }]);
    await finishTourIfDone('t1');
    expect(u[0]).toMatchObject({ status: 'done' });
    expect(notify).toHaveBeenCalledWith('u1', expect.objectContaining({ link: '/tour/t1' }));
  });
  it('calls it partial when some rooms failed', async () => {
    const u = mock([{ status: 'done' }, { status: 'failed' }]);
    await finishTourIfDone('t1');
    expect(u[0]).toMatchObject({ status: 'partial' });
  });
});

describe('architectural details are kept when saving', () => {
  const { roomSchema, saveFurnitureSchema } = require('../schemas/project.schema');
  it('keeps a room ceiling design', () => {
    const r = roomSchema.parse({ id: 'a', name: 'Lounge', height: 3, ceiling: { style: 'tray', drop: 0.25, inset: 0.6, led: true, ledTone: 'warm' } });
    expect(r.ceiling).toEqual({ style: 'tray', drop: 0.25, inset: 0.6, led: true, ledTone: 'warm' });
    expect(() => roomSchema.parse({ id: 'a', name: 'L', ceiling: { style: 'dome' } })).toThrow();
  });
  it('keeps wall panelling', () => {
    const f = saveFurnitureSchema.parse({ furniture: [], wall_panels: { 'w1:A': { style: 'fluted' }, 'w2:B': { style: 'box', color: '#f4f1ec' } } });
    expect(f.wall_panels).toEqual({ 'w1:A': { style: 'fluted' }, 'w2:B': { style: 'box', color: '#f4f1ec' } });
    expect(() => saveFurnitureSchema.parse({ furniture: [], wall_panels: { x: { style: 'gothic' } } })).toThrow();
  });
});
