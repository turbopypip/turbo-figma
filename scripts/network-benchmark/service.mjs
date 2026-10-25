// Isolated benchmark host: production MCP/bridge/store, no developer cache maintenance.
import { exportProbe } from './export-probe.mjs';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Bridge } from '../../dist/bridge.js';
import { NetworkStore } from '../../dist/network-store.js';
import { AssetStore } from '../../dist/assets.js';
import { createServer } from '../../dist/server.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir(config.workspace, { recursive: true });
const cache = await NetworkStore.create(config.workspace);
const assets = await AssetStore.create(config.assets);
const emit = value => { if (process.connected) process.send(value); };
const metrics = stage => ({ stage, memory: process.memoryUsage(), cpu: process.cpuUsage(),
  processPeakRssBytes: process.resourceUsage().maxRSS * 1024 });
let completedCaptures = 0, completedSnapshot;
const captureStore = { begin: async (...args) => {
  emit({ type: 'capture-boundary', stage: 'capture-begin', atMs: performance.now() });
  const writer = await cache.begin(...args);
  return { ...writer, get state() { return writer.state; }, commit: async (...values) => {
    const result = await writer.commit(...values);
    completedCaptures++; completedSnapshot = args[0];
    emit({ type: 'capture-boundary', stage: 'capture-ready', atMs: performance.now() });
    return result;
  } };
} };
const bridge = new Bridge(config.secret, config.port ?? 0, 30000, action => action === 'cache-clear' ? cache.clean() : cache.info(), captureStore);
await bridge.ready;
let currentPhase = 'startup';
const handle = serveStdio(() => createServer(bridge, assets, undefined, cache, measurement =>
  emit({ type: 'worker-measurement', phase: currentPhase, measurement })), { onerror: () => {} });
process.on('message', async msg => {
  if (msg.type === 'metrics') { currentPhase = msg.stage.replace(/-(before|after)$/, ''); emit({ id: msg.id, result: metrics(msg.stage) }); }
  if (msg.type === 'export-probe') {
    try { emit({ id: msg.id, result: await exportProbe(cache, completedSnapshot, path.join(config.workspace, 'benchmark-probe.json')) }); }
    catch { emit({ id: msg.id, result: { error: 'Benchmark adapter failed' } }); }
  }
  if (msg.type === 'cache-status') {
    emit({ id: msg.id, result: { generations: completedCaptures, incomplete: 0, snapshot: completedSnapshot } });
  }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  emit({ type: 'final-metrics', ...metrics('shutdown') });
  await bridge.close(); await handle.close();
  if (process.connected) process.disconnect();
}
process.stdin.once('end', () => void close());
process.on('SIGTERM', () => void close());
emit({ type: 'ready', port: bridge.port, pid: process.pid, metrics: metrics('ready') });
