import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { inflateFrame, nodeFields, parseNetworkSelection } from './network.js';
import { BoundedWireDecoder, WIRE_LIMITS } from './network-wire.js';
import { DiskNetworkSnapshot } from './network-disk.js';
import { probeEvents, storedEvents } from './network-source.js';

const started = performance.now();
const measure = (stage: string) => {
  if (workerData.measure) parentPort!.postMessage({ measurement: { stage, elapsedMs: performance.now() - started,
    memory: process.memoryUsage(), processPeakRssBytes: process.resourceUsage().maxRSS * 1024 } });
};
let model: DiskNetworkSnapshot | undefined;
try {
  measure('worker-start');
  const selection = parseNetworkSelection(workerData.url);
  model = new DiskNetworkSnapshot(selection.fileKey, workerData.scratch);
  let codec: BoundedWireDecoder | undefined, socket: string | undefined;
  let metadata: Record<string, any> = {};
  const consume = (event: any) => {
    if (event.kind === 'ws-open') {
      const u = new URL(event.url);
      if (u.origin !== 'wss://www.figma.com' || u.pathname !== `/api/multiplayer/${selection.fileKey}`) return;
      if (socket !== undefined || typeof event.key !== 'string' || !event.key) throw new Error('Multiple or invalid multiplayer connections');
      socket = event.key;
    }
    if (socket === undefined || event.key !== socket || event.kind !== 'ws-received') return;
    if (event.opcode !== 2 || typeof event.payload !== 'string' || event.payload.length > 24 * 1024 * 1024) throw new Error('Invalid binary payload');
    const b = Buffer.from(event.payload, 'base64');
    if (!b.length || b.toString('base64') !== event.payload) throw new Error('Invalid binary payload');
    if (b.subarray(0, 8).toString() === 'fig-wire') {
      if (codec || b.length < 12 || b.readUInt32LE(8) !== 1) throw new Error('Unsupported or repeated fig-wire schema');
      codec = new BoundedWireDecoder(inflateFrame(b.subarray(12), WIRE_LIMITS.schemaBytes), new Set([...nodeFields].filter(f => f !== 'symbolData')));
      return;
    }
    if (!codec) throw new Error('Missing wire schema');
    model!.acceptMessage(codec.decode(inflateFrame(b, WIRE_LIMITS.frameBytes), node => model!.acceptNode(node)));
  };
  if (workerData.snapshot) {
    if (workerData.snapshot.fileKey !== selection.fileKey) throw new Error('Selection file does not match capture');
    for await (const event of storedEvents(workerData.projectDirectory, workerData.snapshot)) consume(event);
  } else {
    for await (const item of probeEvents(workerData.captureFile)) {
      if (item.event) consume(item.event);
      else if (item.metadata) metadata = item.metadata;
    }
    const capturedFile = new URL(metadata.fileUrl);
    if (capturedFile.origin !== 'https://www.figma.com' || capturedFile.pathname.split('/')[2] !== selection.fileKey) throw new Error('Selection file does not match capture');
  }
  measure('decoded');
  model.finish(); codec = undefined;
  measure('indexed');
  const decodedAt = performance.now(), result = model.query(workerData);
  measure('queried');
  const warnings = [];
  if (metadata.dropped) warnings.push(`${metadata.dropped} capture events were dropped; completeness is not guaranteed.`);
  parentPort!.postMessage({ result: { ...result, ...(workerData.snapshot ? { snapshot: workerData.snapshot } : {}),
    capturedAt: metadata.startedAt, stoppedAt: metadata.stoppedAt, captureWarnings: warnings,
    metrics: { loadDecodeIndexMs: Math.round(decodedAt - started), queryMs: Math.round(performance.now() - decodedAt),
      workerHeapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576) } } });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Network snapshot failed' });
} finally { model?.close(); }
