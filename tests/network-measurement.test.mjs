import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pidList, readRss, summarizeSamples } from '../scripts/network-benchmark/rss.mjs';
import { syntheticCapture } from '../scripts/network-benchmark/fixture.mjs';
import { readNetworkSnapshot } from '../dist/network-reader.js';
const exec = promisify(execFile);
test('RSS accounting sums simultaneous distinct processes, never thread RSS or separate peaks', () => {
  const roles = [{ name: 'mcp', pid: 1 }, { name: 'extension-1', pid: 2 }, { name: 'node-collector-simulator', pid: 3 }];
  const result = summarizeSamples([{ rss: { 1: 100, 2: 40, 3: 10000 } }, { rss: { 1: 50, 2: 60 } }], roles);
  assert.equal(result.sampledMcpPlusSelectedExtensionProcessesBytes, 140);
  assert.equal(result.byRole['node-collector-simulator'].sampledPeakRssBytes, 10000);
  assert.equal(result.fullImplementationPeakBytes, null); assert.equal(result.budgetAccepted, false);
  assert.throws(() => summarizeSamples([], [{ name: 'mcp', pid: 1 }, { name: 'worker', pid: 1 }]), /only one role/);
});
test('missing extension samples stay unknown and PID arguments cannot inject shell syntax', () => {
  const result = summarizeSamples([{ rss: { 1: 100 } }], [{ name: 'mcp', pid: 1 }, { name: 'extension-1', pid: 2 }]);
  assert.equal(result.sampledMcpPlusSelectedExtensionProcessesBytes, null);
  assert.equal(result.byRole['extension-1'].sampledPeakRssBytes, null);
  assert.throws(() => pidList(['1;echo bad'])); assert.throws(() => pidList([0]));
});
test('external observer measures live process RSS in bytes', async () => {
  const values = await readRss([process.pid]); assert.ok(values.get(process.pid) > 1024 * 1024);
});
test('optional worker metrics expose phases and byte fields without changing output or propagating observer errors', async t => {
  const parent = path.resolve('.cache/figma-network/benchmarks'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'metric-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const captureFile = path.join(directory, 'fixture.json'); await writeFile(captureFile, JSON.stringify(syntheticCapture()));
  const params = { format:'debug', captureFile, url: 'https://www.figma.com/design/benchmark/File?node-id=1-1', depth: 1, maxNodes: 5, offset: 0, includeHidden: true };
  const measurements = [];
  const result = await readNetworkSnapshot(params, undefined, m => { measurements.push(m); throw Error('observer failed'); });
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(measurements.map(m => m.stage), ['worker-start', 'decoded', 'indexed', 'queried']);
  assert.ok(measurements.every(m => m.memory.rss > 0 && m.memory.external >= m.memory.arrayBuffers && m.processPeakRssBytes > 0));
  assert.equal(JSON.stringify(measurements).includes('Synthetic'), false);
});
test('pipeline harness writes isolated bounded report and marks browser coverage and full path incomplete', { timeout: 30000 }, async t => {
  const { stdout } = await exec(process.execPath, ['scripts/measure-network-pipeline.mjs', '--synthetic', '--idle-ms', '30', '--release-ms', '30'], { timeout: 25000 });
  const output = JSON.parse(stdout.trim()); assert.equal(output.success, true);
  const directory = path.dirname(output.report); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(directory.startsWith(path.resolve('.cache/figma-network/benchmarks') + path.sep));
  const report = JSON.parse(await readFile(output.report, 'utf8'));
  assert.equal(report.captureResult.events, 4); assert.equal(report.decodeResults.length, 2);
  assert.equal(report.decodeResults[0].documentRecords, 1);
  assert.equal(report.workerMeasurements.length, 4);
  assert.equal(report.decodeResults[0].metrics.selectionCacheHit, false);
  assert.equal(report.decodeResults[1].metrics.selectionCacheHit, true);
  assert.equal(report.decodeResults[1].metrics.loadDecodeIndexMs, 0); assert.ok(report.samples > 0);
  assert.equal(report.accounting.fullImplementationPeakBytes, null); assert.equal(report.accounting.budgetAccepted, false);
  assert.equal(report.accounting.sampledMcpPlusSelectedExtensionProcessesBytes, null);
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  assert.equal(JSON.stringify(report).includes(config.secret), false);
  assert.equal(JSON.stringify(report).includes('Synthetic'), false);
});

test('benchmark adapter preserves split records and rejects mixed/truncated streams', async t => {
  const { exportProbe } = await import('../scripts/network-benchmark/export-probe.mjs');
  const parent = path.resolve('.cache/figma-network/benchmarks'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'adapter-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const record = { kind: 'ws-received', session: 'worker', requestId: '1', opcode: 2, payload: 'YWJj' };
  const raw = Buffer.from(JSON.stringify(record) + '\n');
  const cache = parts => ({ withRead: fn => fn(), readManifest: async () => ({ parts }), readPart: async (_, i) => parts[i] });
  const output = path.join(directory, 'valid.json');
  const result = await exportProbe(cache([raw.subarray(0, 12), raw.subarray(12)]), { fileKey: 'benchmark' }, output);
  const probe = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(result.events, 1); assert.equal(probe.events[1].payload, record.payload);
  assert.equal(probe.events[0].key, probe.events[1].key);
  await assert.rejects(exportProbe(cache([raw.subarray(0, -1)]), { fileKey: 'benchmark' }, path.join(directory, 'truncated.json')), /Incomplete/);
  const other = Buffer.from(JSON.stringify({ ...record, requestId: '2' }) + '\n');
  await assert.rejects(exportProbe(cache([raw, other]), { fileKey: 'benchmark' }, path.join(directory, 'mixed.json')), /one complete stream/);
});
