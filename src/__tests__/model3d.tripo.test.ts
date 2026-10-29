jest.mock('../services/supabase', () => ({ supabase: {}, supabaseAuth: {} }));

import { tripo, tripoRequest, ProviderError } from '../services/model3d/tripo';
import { optimizeGlb, rotateY, turnToFrontDeg } from '../services/model3d/optimize';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

const A = 'https://x.supabase.co/front.jpg';
const B = 'https://x.supabase.co/left.jpg';

describe('tripoRequest', () => {
  it('uses image-to-model for one photo', () => {
    const r = tripoRequest({ mode: 'single', images: [{ view: 'front', url: A }] });
    expect(r.path).toBe('/generation/image-to-model');
    expect(r.body).toMatchObject({ input: A, texture: true, pbr: true, model: 'v3.1-20260211', face_limit: 40000, texture_quality: 'standard' });
  });

  it('uses multiview-to-model with view keys for several sides', () => {
    const r = tripoRequest({ mode: 'multiview', images: [{ view: 'front', url: A }, { view: 'left', url: B }] });
    expect(r.path).toBe('/generation/multiview-to-model');
    expect(r.body.inputs).toEqual([{ front: A }, { left: B }]);
  });
});

describe('tripo provider (simulated API)', () => {
  const realFetch = global.fetch;
  const OLD = process.env.TRIPO_API_KEY;
  let calls: { url: string; init: any }[] = [];
  const reply = (status: number, body: unknown) =>
    (global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }) as any);

  beforeEach(() => { calls = []; process.env.TRIPO_API_KEY = 'tsk_test'; });
  afterAll(() => { global.fetch = realFetch; process.env.TRIPO_API_KEY = OLD; });

  it('submits with the bearer key and returns the task id', async () => {
    reply(200, { code: 0, data: { task_id: 'task_1' } });
    await expect(tripo.submit({ mode: 'single', images: [{ view: 'front', url: A }] })).resolves.toBe('task_1');
    expect(calls[0].url).toBe('https://openapi.tripo3d.com/v3/generation/image-to-model');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tsk_test');
  });

  it('reads progress, success and failure', async () => {
    reply(200, { code: 0, data: { status: 'running', progress: 42 } });
    await expect(tripo.poll('task_1')).resolves.toEqual({ state: 'running', progress: 42 });
    reply(200, { code: 0, data: { status: 'success', output: { model_url: 'https://cdn/x.glb' }, credits_consumed: 30 } });
    await expect(tripo.poll('task_1')).resolves.toEqual({ state: 'done', glbUrl: 'https://cdn/x.glb', credits: 30 });
    reply(200, { code: 0, data: { status: 'failed', error_message: 'bad image' } });
    await expect(tripo.poll('task_1')).resolves.toEqual({ state: 'failed', error: 'bad image' });
  });

  it('waits (does not fail) when out of credits', async () => {
    reply(403, { code: 2010, status: 'error', message: "You don't have enough credit" });
    const e = await tripo.submit({ mode: 'single', images: [{ view: 'front', url: A }] }).catch(x => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.permanent).toBe(false);
    expect(e.waitMs).toBeGreaterThan(0);
  });

  it('fails for good on a rejected photo', async () => {
    reply(400, { code: 2008, status: 'error', message: 'content policy' });
    const e = await tripo.submit({ mode: 'single', images: [{ view: 'front', url: A }] }).catch(x => x);
    expect(e.permanent).toBe(true);
  });

  it('reads the balance', async () => {
    reply(200, { code: 0, data: { balance: 120, frozen: 30 } });
    await expect(tripo.balance!()).resolves.toEqual({ balance: 120, frozen: 30 });
  });
});

describe('optimizeGlb', () => {
  it('turns Tripo models (+X front) a quarter turn to face +Z', async () => {
    expect(turnToFrontDeg('+x')).toBe(-90);
    expect(turnToFrontDeg('+z')).toBe(0);
    const { Document } = await esmImport('@gltf-transform/core');
    const doc = new Document();
    doc.createScene('s').addChild(doc.createNode('a'));
    rotateY(doc, -90);
    const pivot = doc.getRoot().listScenes()[0].listChildren()[0] as any;
    expect(pivot.getName()).toBe('nooi-orientation');
    expect(pivot.listChildren()[0].getName()).toBe('a');
    const [, y, , w] = pivot.getRotation();
    expect(y).toBeCloseTo(-Math.SQRT1_2, 5);   // −90° about Y: +X → +Z
    expect(w).toBeCloseTo(Math.SQRT1_2, 5);
  });

  // Texture/geometry compression itself is checked with plain Node (Jest's
  // sandbox can't load glTF-Transform's ES modules): see the PR notes.

  it('keeps the original if the file is not a GLB', async () => {
    const junk = Buffer.from('not a model');
    const r = await optimizeGlb(junk);
    expect(r.optimized).toBe(false);
    expect(r.buffer).toBe(junk);
  });
});
