/**
 * Tripo check — npm run tripo:check [-- --image <photo url>]
 * ============================================================================
 * Without arguments: confirms TRIPO_API_KEY works and prints the balance.
 * Costs nothing.
 *
 * With --image: makes ONE model from that photo (about 30 credits), shows
 * progress, then shrinks it the way the app does and saves
 *   tripo-test-raw.glb   what Tripo returned
 *   tripo-test.glb       what Nooi stores (turned to face +Z, compressed)
 * Open them in https://gltf-viewer.donmccurdy.com to check orientation.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { tripo } from '../src/services/model3d/tripo';
import { optimizeGlb, turnToFrontDeg } from '../src/services/model3d/optimize';
import { downloadGlb } from '../src/services/model3d';

async function main() {
  if (!process.env.TRIPO_API_KEY) {
    console.error('TRIPO_API_KEY is not set (put it in .env or the shell).');
    process.exit(1);
  }
  const b = await tripo.balance!();
  console.log(`✓ Key works. Balance: ${b.balance} credits (${b.frozen} held for running jobs).`);

  const i = process.argv.indexOf('--image');
  const image = i > -1 ? process.argv[i + 1] : null;
  if (!image) return;

  console.log('Starting one model (≈30 credits)…');
  const taskId = await tripo.submit({ mode: 'single', images: [{ view: 'front', url: image }] });
  console.log('Task', taskId);
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await tripo.poll(taskId);
    if (r.state === 'running') { process.stdout.write(`\r  ${r.progress}%   `); continue; }
    console.log('');
    if (r.state === 'failed') { console.error('✗ Failed:', r.error); process.exit(1); }
    const raw = await downloadGlb(r.glbUrl);
    writeFileSync('tripo-test-raw.glb', raw);
    const out = await optimizeGlb(raw, { rotateDeg: turnToFrontDeg(tripo.forwardAxis?.()) });
    writeFileSync('tripo-test.glb', out.buffer);
    console.log(`✓ Done${r.credits ? ` — ${r.credits} credits` : ''}. ${(out.before / 1048576).toFixed(1)} MB → ${(out.after / 1048576).toFixed(1)} MB`);
    console.log('  Saved tripo-test-raw.glb and tripo-test.glb');
    return;
  }
}

main().catch(e => { console.error('✗', e?.message || e); process.exit(1); });
