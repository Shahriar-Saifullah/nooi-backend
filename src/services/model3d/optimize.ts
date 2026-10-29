/**
 * GLB clean-up — services/model3d/optimize.ts
 * ============================================================================
 * Generated models come back at 10–30 MB with 2K textures. A room with a few
 * of them would take ages to open, so every model goes through:
 *
 *   1. orientation  turn it so its front faces +Z, the way the canvas and every
 *                   library model face (Tripo's front is +X by default)
 *   2. textures     resized to ≤1024 px and re-encoded as WebP
 *   3. geometry     meshopt compression (three.js / drei decode it natively)
 *
 * Typical result: 1–3 MB. If anything fails, the original file is kept — a big
 * model is better than no model.
 *
 * Env: MODEL3D_FORWARD_AXIS (+x default | -x | +z | -z) — which way the
 *      provider's models face; MODEL3D_TEXTURE_SIZE (default 1024).
 */

import type { Document, NodeIO } from '@gltf-transform/core';

// glTF-Transform and meshoptimizer depend on ES-only modules. Loading them
// with require() works on Node 22+ but crashes older Node at startup, so they
// are imported lazily as ESM, the first time a model is processed. (A plain
// `import()` would be compiled to require() by TypeScript; this one isn't.)
// If loading fails, optimizeGlb just keeps the original file.
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
let libsPromise: Promise<{ io: NodeIO; encoder: any; fns: any; sharp: any; core: any }> | null = null;

function getLibs() {
  libsPromise ??= (async () => {
    const [core, ext, fns, mo, sharpMod] = await Promise.all([
      esmImport('@gltf-transform/core'),
      esmImport('@gltf-transform/extensions'),
      esmImport('@gltf-transform/functions'),
      esmImport('meshoptimizer'),
      esmImport('sharp'),
    ]);
    await mo.MeshoptDecoder.ready;
    await mo.MeshoptEncoder.ready;
    const io: NodeIO = new core.NodeIO()
      .registerExtensions(ext.ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': mo.MeshoptDecoder, 'meshopt.encoder': mo.MeshoptEncoder });
    return { io, encoder: mo.MeshoptEncoder, fns, sharp: sharpMod.default ?? sharpMod, core };
  })().catch(e => { libsPromise = null; throw e; });
  return libsPromise;
}

/** Degrees about Y that turn a model facing `axis` to face +Z. */
export function turnToFrontDeg(axis = process.env.MODEL3D_FORWARD_AXIS || '+x'): number {
  switch (axis.trim().toLowerCase()) {
    case '+x': return -90;
    case '-x': return 90;
    case '-z': return 180;
    default: return 0; // +z, or anything unexpected
  }
}

/** Wrap every scene's contents in a node turned `deg` about the vertical axis. */
export function rotateY(doc: Document, deg: number) {
  const a = ((deg % 360) + 360) % 360;
  if (a === 0) return;
  const half = (deg * Math.PI) / 360;
  for (const scene of doc.getRoot().listScenes()) {
    const pivot = doc.createNode('nooi-orientation').setRotation([0, Math.sin(half), 0, Math.cos(half)]);
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      pivot.addChild(child);
    }
    scene.addChild(pivot);
  }
}

export interface OptimizeResult { buffer: Buffer; optimized: boolean; before: number; after: number; }

export async function optimizeGlb(input: Buffer, opts: { rotateDeg?: number; compress?: boolean } = {}): Promise<OptimizeResult> {
  const before = input.length;
  try {
    const { io, encoder, fns, sharp, core } = await getLibs();
    const doc = await io.readBinary(new Uint8Array(input));
    doc.setLogger(new core.Logger(core.Logger.Verbosity.WARN));
    rotateY(doc, opts.rotateDeg ?? 0);
    if (opts.compress !== false) {
      const size = Math.max(256, Math.min(4096, Number(process.env.MODEL3D_TEXTURE_SIZE) || 1024));
      await doc.transform(
        fns.dedup(),
        fns.prune(),
        fns.textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size] }),
        fns.meshopt({ encoder, level: 'medium' }),
      );
    }
    const out = Buffer.from(await io.writeBinary(doc));
    return { buffer: out, optimized: true, before, after: out.length };
  } catch (e: any) {
    console.warn('[model3d] optimise failed, keeping the original:', e?.message || e);
    return { buffer: input, optimized: false, before, after: before };
  }
}
