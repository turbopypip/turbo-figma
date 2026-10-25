import { fork } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parseNetworkSelection } from '../dist/network.js';
import { readRss, pidList, summarizeSamples } from './network-benchmark/rss.mjs';
import { syntheticCapture } from './network-benchmark/fixture.mjs';
const { values: args } = parseArgs({ options: {
  'reuse-pairing': { type: 'string' }, capture: { type: 'string' }, 'node-id': { type: 'string' }, synthetic: { type: 'boolean' }, live: { type: 'boolean' },
  'extension-pids': { type: 'string' }, 'interval-ms': { type: 'string', default: '20' },
  'idle-ms': { type: 'string', default: '1000' }, 'release-ms': { type: 'string', default: '10000' },
} });
const numeric = (name, min, max) => { const n = Number(args[name]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`); return n; };
const intervalMs = numeric('interval-ms', 10, 1000), idleMs = numeric('idle-ms', 20, 60000), releaseMs = numeric('release-ms', 20, 60000);
if (!!args.capture === !!args.synthetic) throw new Error('Choose --capture /path/probe.json --node-id ID or --synthetic');
if (args.live && !args['extension-pids']) throw new Error('Live mode requires explicit --extension-pids from Chrome Task Manager');
if (!args.live && args['extension-pids']) throw new Error('Browser PIDs are only meaningful with --live capture');
const extensionPids = args['extension-pids'] ? pidList(args['extension-pids'].split(',')) : [];
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = path.join(root, '.cache', 'figma-network', 'benchmarks');
await mkdir(parent, { recursive: true, mode: 0o700 });
const runDirectory = await mkdtemp(path.join(parent, 'pipeline-'));
const save = (name, value) => writeFile(path.join(runDirectory, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
let captureFile = args.capture ? path.resolve(args.capture) : path.join(runDirectory, 'synthetic.json');
if (args.synthetic) await save('synthetic.json', syntheticCapture());
if ((await stat(captureFile)).size > 64 * 1024 * 1024) throw new Error('Fixture exceeds 64 MiB');
let fixtureBytes = await readFile(captureFile), dump = JSON.parse(fixtureBytes.toString());
const fixtureHash = createHash('sha256').update(fixtureBytes).digest('hex'); fixtureBytes = null;
if (dump.version !== 2 || dump.dropped !== 0 || !Array.isArray(dump.events) || dump.events.length > 10000) throw new Error('Use a complete v2 probe with zero dropped events');
const url = new URL(dump.fileUrl); url.search = ''; url.searchParams.set('node-id', args['node-id'] || '1:1');
const query = { url: url.href, depth: 50, maxNodes: 500, offset: 0, includeHidden: true };
const selection = parseNetworkSelection(query.url);
const keys = dump.events.filter(e => e.kind === 'ws-open' && e.url === `wss://www.figma.com/api/multiplayer/${selection.fileKey}`).map(e => e.key);
if (keys.length !== 1) throw new Error('Fixture must contain one selected-file multiplayer connection');
const incoming = dump.events.filter(e => e.kind === 'ws-received' && e.key === keys[0]);
if (!incoming.length || incoming.some(e => typeof e.payload !== 'string' || e.payload.length > 8 * 1024 * 1024)) throw new Error('Invalid fixture messages');
await save('events.ndjson', incoming.map(e => JSON.stringify({ opcode: e.opcode, payload: e.payload })).join('\n') + '\n');
dump = null; // fixture preparation is outside observed processes and all measured stages.
let secret = randomBytes(32).toString('hex'), port = 0;
if (args['reuse-pairing']) {
  if (!args.live) throw new Error('Pairing reuse requires --live');
  const pairing = await readFile(args['reuse-pairing'], 'utf8');
  const match = /^Endpoint: ws:\/\/127\.0\.0\.1:(\d+)\nSecret: ([a-f0-9]{64})\n$/.exec(pairing);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Invalid pairing file');
  port = Number(match[1]); secret = match[2];
}
await save('config.json', { secret, port, workspace: path.join(runDirectory, 'workspace'), assets: path.join(runDirectory, 'assets') });
const trace = createWriteStream(path.join(runDirectory, 'samples.ndjson'), { mode: 0o600 });
const traceLine = value => trace.write(JSON.stringify(value) + '\n');
const started = performance.now(); let phase = 'startup', running = true, replay, observerErrors = 0;
const samples = [], stages = [], workerMeasurements = [], mainMeasurements = [], replayMeasurements = [];
const phases = [], captureBoundaries = [];
const elapsed = () => performance.now() - started;
const mark = name => { phase = name; const item = { phase: name, atMs: elapsed() }; phases.push(item); traceLine({ type: 'phase', ...item }); };
const service = fork(path.join(root, 'scripts/network-benchmark/service.mjs'), [path.join(runDirectory, 'config.json')], { silent: true });
const roles = [{ name: 'mcp', pid: service.pid }, ...extensionPids.map((pid, i) => ({ name: `extension-${i + 1}`, pid }))];
let nextId = 0, stdout = '';
const requests = new Map();
function accept(message) {
  if (message.type === 'capture-boundary') { captureBoundaries.push(message); traceLine(message); if (args.live && message.stage === 'capture-begin') mark('capture'); }
  if (message.type === 'worker-measurement') { const item = { atMs: elapsed(), phase: message.phase, ...message.measurement }; workerMeasurements.push(item); traceLine({ type: 'worker', ...item }); }
  if (message.type === 'final-metrics') mainMeasurements.push({ atMs: elapsed(), phase, ...message });
  const pending = requests.get(message.id); if (pending) { requests.delete(message.id); pending.resolve(message.result ?? message); }
}
service.on('message', accept);
service.stdout.on('data', chunk => {
  stdout += chunk;
  if (stdout.length > 2 * 1024 * 1024) { service.kill(); return; }
  let newline; while ((newline = stdout.indexOf('\n')) !== -1) { const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1); if (line) accept(JSON.parse(line)); }
});
service.stderr.resume(); // Do not copy private errors or paths into the public report.
service.once('exit', () => { for (const pending of requests.values()) pending.reject(new Error('Measurement service exited')); requests.clear(); });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Service startup timed out')), 15000);
  const onExit = () => { clearTimeout(timer); reject(new Error('Service exited before readiness')); };
  service.once('exit', onExit);
  service.on('message', function listen(msg) { if (msg.type === 'ready') { clearTimeout(timer); service.removeListener('exit', onExit); service.removeListener('message', listen); resolve(msg); } });
});
async function request(method, params = {}, ipc = false) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    if (ipc) service.send({ type: method, id, ...params });
    else service.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const metrics = async stage => { const m = await request('metrics', { stage }, true); mainMeasurements.push({ atMs: elapsed(), phase, ...m }); traceLine({ type: 'main', atMs: elapsed(), phase, ...m }); return m; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const observer = (async () => {
  while (running) {
    const atMs = elapsed(); const samplePhase = phase;
    try { const rss = Object.fromEntries(await readRss(roles.map(r => r.pid))); const sample = { atMs, windowMs: elapsed() - atMs, phase: samplePhase, rss };
      samples.push(sample); traceLine({ type: 'rss', ...sample });
    } catch { observerErrors++; traceLine({ type: 'rss-error', atMs, phase: samplePhase }); }
    await delay(intervalMs);
  }
})();
const stage = async (name, action) => {
  mark(name); const before = await metrics(`${name}-before`), at = elapsed();
  const result = await action(); const durationMs = elapsed() - at; const after = await metrics(`${name}-after`);
  const value = { name, durationMs, before, after }; stages.push(value); return result;
};
let success = false, failure, captureResult, decodeResults = [];
try {
  const host = await ready; stages.push({ name: 'startup', durationMs: elapsed(), after: host.metrics });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'network-resource-probe', version: '1' } });
  service.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await stage('idle-before', () => delay(idleMs));
  await stage(args.live ? 'live-setup-and-capture' : 'capture', async () => {
    if (args.live) {
      await save('pairing.txt', `Endpoint: ws://127.0.0.1:${host.port}\nSecret: ${secret}\n`);
      console.error(`Live capture: use ${path.join(runDirectory, 'pairing.txt')} to connect the extension, then click Reload and capture. Waiting up to 180 seconds.`);
      const until = elapsed() + 180000;
      while (elapsed() < until) { const info = await request('cache-status', {}, true); if (info.generations > info.incomplete) return; await delay(500); }
      throw new Error('Live capture timed out');
    }
    await save('replay.json', { secret, port: host.port, fileKey: selection.fileKey, events: path.join(runDirectory, 'events.ndjson') });
    replay = fork(path.join(root, 'scripts/network-benchmark/replay.mjs'), [path.join(runDirectory, 'replay.json')], { silent: true });
    roles.push({ name: 'node-collector-simulator', pid: replay.pid }); replay.stdout.resume(); replay.stderr.resume();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replay.kill(); reject(new Error('Replay timed out')); }, 150000);
      replay.on('message', message => {
        if (message.type === 'replay-metrics') { replayMeasurements.push({ atMs: elapsed(), ...message }); traceLine({ atMs: elapsed(), ...message }); }
        if (message.type === 'done') captureResult = { events: message.events, bytes: message.bytes };
      });
      replay.once('exit', code => { clearTimeout(timer); if (code === 0 && captureResult) resolve(); else reject(new Error('Replay capture failed')); });
    });
  });
  const info = await request('cache-status', {}, true);
  if (!(info.generations > info.incomplete)) throw new Error('Managed snapshot was not published');
  query.url = `https://www.figma.com/design/${info.snapshot.fileKey}/File?node-id=${args['node-id'] || '1:1'}`;
  for (const name of ['cold-decode-request', 'repeat-decode-request']) {
    const result = await stage(name, async () => {
      const response = await request('tools/call', { name: 'get_network_tree', arguments: { ...query, snapshot: info.snapshot } });
      if (response.isError || !response.content?.[0]?.text) throw new Error('MCP network decode failed');
      const parsed = JSON.parse(response.content[0].text);
      return { documentRecords: parsed.documentRecords, returnedNodes: parsed.nodes.length, metrics: parsed.metrics };
    });
    decodeResults.push({ name, ...result });
  }
  await stage('release-1s', () => delay(1000));
  await stage('idle-after-release', () => delay(releaseMs));
  success = true;
} catch (error) { failure = error.message; }
finally {
  replay?.kill();
  mark('shutdown'); service.stdin.end();
  const kill = setTimeout(() => service.kill('SIGKILL'), 3000);
  if (service.exitCode === null) await once(service, 'exit'); clearTimeout(kill);
  running = false; await observer;
  trace.end(); await once(trace, 'finish');
}
const gaps = samples.slice(1).map((s, i) => s.atMs - samples[i].atMs);
const report = { version: 1, success, failure, date: new Date().toISOString(), runId: path.basename(runDirectory),
  mode: args.live ? 'live-capture-managed-disk-decode' : 'recorded-event-replay-managed-disk-decode',
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model, ramBytes: os.totalmem() },
  fixture: { synthetic: !!args.synthetic, sha256: fixtureHash },
  observerErrors, intervalRequestedMs: intervalMs, samples: samples.length, maximumSampleGapMs: gaps.length ? Math.max(...gaps) : null,
  maximumReadWindowMs: samples.length ? Math.max(...samples.map(s => s.windowMs)) : null,
  captureBoundaries, captureDurationMs: captureBoundaries.length === 2 ? captureBoundaries[1].atMs - captureBoundaries[0].atMs : null,
  phases, stages, decodeResults, captureResult, mainMeasurements, workerMeasurements, replayMeasurements,
  accounting: summarizeSamples(samples, roles),
  phasePeaks: Object.fromEntries(phases.map(p => [p.phase, summarizeSamples(samples.filter(s => s.phase === p.phase), roles)])),
  limitations: ['Production decoder reads verified managed parts directly and builds temporary disk indices; no compatibility adapter is used.',
    'Replay runs production collector under Node with fake Chrome API and acknowledgement pacing; its RSS is not extension RAM or real network timing.',
    'Worker rss/maxRSS are process-wide and are never added to MCP RSS. arrayBuffers is a subset of external; neither is added to RSS.',
    'External sampling can miss peaks between samples; maxRSS is cumulative since process start, not per-phase.',
    'No forced GC. Fresh process is not cold OS file cache. Repeated query still launches a fresh worker.',
    'Browser/PID attribution and CDP/browser-side overhead need a controlled live run; missing coverage is null, never zero. Budget is not accepted.'] };
await save('report.json', report);
console.log(JSON.stringify({ success, report: path.join(runDirectory, 'report.json'), budgetAccepted: false }));
if (!success) process.exitCode = 1;
