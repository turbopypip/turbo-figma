import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { callHelper, defaultBinary } from './host.mjs';
const samples = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  await callHelper();
  samples.push(performance.now() - start);
}
const sorted = [...samples].sort((a, b) => a - b);
console.log(JSON.stringify({
  runId: `rust-helper-05-${new Date().toISOString()}`,
  platform: process.platform, arch: process.arch, os: os.release(), cpuModel: os.cpus()[0]?.model ?? null,
  node: process.version, binarySha256: createHash('sha256').update(readFileSync(defaultBinary)).digest('hex'),
  metric: 'spawn + IPC ping + process close (ms)', samples,
  medianMs: (sorted[14] + sorted[15]) / 2, p95Ms: sorted[28],
  cpu: null, rss: null, note: 'OS filesystem caches uncontrolled; no decode, no warm retained process, no production speedup claim',
}, null, 2));
