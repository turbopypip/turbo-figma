import { Worker } from 'node:worker_threads';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import type { NetworkQuery } from './network.js';
import { NetworkStore } from './network-store.js';
import type { SnapshotIdentity } from './network-session.js';

export type NetworkMeasurement = { stage: string; elapsedMs: number; memory: NodeJS.MemoryUsage; processPeakRssBytes: number };
let busy = false;
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));

/** Process-wide gate, including worker shutdown and scratch cleanup. No unbounded wait queue. */
async function decode(params: Record<string, unknown>, cache: NetworkStore, signal?: AbortSignal, observe?: (sample: NetworkMeasurement) => void): Promise<unknown> {
  if (signal?.aborted) throw new Error('Request cancelled');
  if (busy) throw new Error('Network snapshot reader is busy');
  busy = true;
  let scratch: string | undefined;
  try {
    return await cache.withRead(async () => {
      scratch = await mkdtemp(join(cache.root, 'decode-'));
      if (signal?.aborted) throw new Error('Request cancelled');
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./network-worker.js', import.meta.url), { workerData: { ...params, scratch, measure: !!observe },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
        let settled = false;
        const finish = (error?: Error, result?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          void worker.terminate().then(() => { if (error) reject(error); else resolve(result); }, reject);
        };
        const abort = () => finish(new Error('Request cancelled'));
        const timer = setTimeout(() => finish(new Error('Network snapshot decoding timed out')), 120000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        worker.on('message', msg => {
          if (msg.measurement) {
            try { observe?.(msg.measurement); } catch { /* Diagnostics cannot change request success. */ }
            return;
          }
          finish(msg.error ? new Error(msg.error) : undefined, msg.result);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', () => { if (!settled) finish(new Error('Network decoder exited without a result')); });
      });
    });
  } finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { busy = false; }
  }
}

/** Legacy research capture adapter; streams events instead of parsing the entire JSON file. */
export async function readNetworkSnapshot(params: NetworkQuery & { captureFile: string }, signal?: AbortSignal, observe?: (sample: NetworkMeasurement) => void): Promise<unknown> {
  if (!isAbsolute(params.captureFile)) throw new Error('captureFile must be an absolute local path');
  if (signal?.aborted) throw new Error('Request cancelled');
  const cache = await NetworkStore.create(projectDirectory);
  return decode(params, cache, signal, observe);
}

/** Main-process read lease protects all parts while the worker reads and verifies them. */
export async function readStoredNetworkSnapshot(cache: NetworkStore, snapshot: SnapshotIdentity, params: NetworkQuery,
  signal?: AbortSignal, observe?: (sample: NetworkMeasurement) => void): Promise<unknown> {
  return decode({ ...params, snapshot, projectDirectory: dirname(dirname(cache.root)) }, cache, signal, observe);
}
