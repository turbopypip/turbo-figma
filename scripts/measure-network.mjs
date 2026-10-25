// Run each mode in a separate process. Captures remain local and are never printed.
// npm run build && node scripts/measure-network.mjs /path/capture.json selection-url
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import { NetworkSnapshot, inflateFrame, parseNetworkSelection } from '../dist/network.js';
const [captureFile, url, mode] = process.argv.slice(2);
if (!captureFile || !url) throw new Error('Usage: node scripts/measure-network.mjs capture.json selection-url');
if (!mode) {
  for (const variant of ['full', 'compact']) {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), captureFile, url, variant], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr);
    process.stdout.write(child.stdout);
  }
} else {
  const started = performance.now(), selection = parseNetworkSelection(url);
  let dump = JSON.parse(readFileSync(captureFile, 'utf8'));
  let retained, records = 0;
  if (mode === 'compact') {
    retained = new NetworkSnapshot(selection.fileKey);
    for (const e of dump.events) retained.consume(e);
    retained.finish();
    records = retained.query({ url, depth: 50, maxNodes: 500, offset: 0, includeHidden: true }).documentRecords;
  } else {
    let codec, socket;
    for (const e of dump.events) {
      if (e.kind === 'ws-open' && new URL(e.url).pathname === `/api/multiplayer/${selection.fileKey}`) socket = e.key;
      if (!socket || e.key !== socket || e.kind !== 'ws-received' || e.opcode !== 2) continue;
      const b = Buffer.from(e.payload, 'base64');
      if (b.subarray(0, 8).toString() === 'fig-wire') codec = compileSchema(decodeBinarySchema(inflateFrame(b.subarray(12))));
      else {
        const m = codec.decodeMessage(inflateFrame(b));
        if (m.nodeChanges?.length) { retained = m; records = m.nodeChanges.length; }
      }
    }
  }
  const elapsedMs = Math.round(performance.now() - started);
  dump = null;
  global.gc();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ mode, documentRecords: records, elapsedMs,
    heapAfterGcMiB: Math.round(memory.heapUsed / 1048576), externalAfterGcMiB: Math.round(memory.external / 1048576),
    processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
  // Keep model reachable through the measurement; compact has an index, full has raw blobs.
  if (!retained) throw new Error('No document decoded');
}
