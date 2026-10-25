import { Worker } from 'node:worker_threads';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { parseNetworkSelection, type NetworkQuery } from './network.js';
import { NetworkStore } from './network-store.js';
import type { SnapshotIdentity } from './network-session.js';

export type NetworkMeasurement = { stage: string; elapsedMs: number; memory: NodeJS.MemoryUsage; processPeakRssBytes: number };
let busy = false;
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));

type Retained = { key: string; worker: Worker; scratch: string; dead?: boolean; unregister?: () => void; idle?: NodeJS.Timeout };
let retained: Retained | undefined;
async function dispose() {
  const old = retained; retained = undefined;
  if (!old) return;
  clearTimeout(old.idle); old.unregister?.();
  await old.worker.terminate();
  await rm(old.scratch, { recursive: true, force: true });
}
/** Explicit shutdown hook; callers cannot interrupt an active read. */
export async function releaseNetworkSelection() {
  if (busy) throw new Error('Network snapshot reader is busy');
  busy = true;
  try { await dispose(); } finally { busy = false; }
}

/** One retained selection and one active request, including termination and cleanup. */
async function decode(params: Record<string, unknown>, cache: NetworkStore, signal?: AbortSignal, observe?: (sample: NetworkMeasurement) => void): Promise<unknown> {
  if (signal?.aborted) throw new Error('Request cancelled');
  if (busy) throw new Error('Network snapshot reader is busy');
  busy = true;
  try {
    clearTimeout(retained?.idle);
    return await cache.withRead(async () => {
      const selection = parseNetworkSelection(params.url as string);
      const snapshot = params.snapshot as SnapshotIdentity | undefined;
      const manifest = snapshot ? await cache.readManifest(snapshot) : undefined;
      const key = snapshot ? JSON.stringify([cache.root, manifest, selection.nodeId]) : undefined;
      if (retained?.dead || !key || key !== retained?.key || selection.fileKey !== snapshot?.fileKey) await dispose();
      // Recheck immutable source bytes on a hit: clearing or corruption cannot revive old data.
      if (retained && snapshot) {
        for (let i = 0; i < manifest!.parts.length; i++) {
          if (signal?.aborted) throw new Error('Request cancelled');
          await cache.readPart(snapshot, i);
        }
      }
      if (signal?.aborted) throw new Error('Request cancelled');
      const reused = !!retained;
      if (!retained) {
        const scratch = await mkdtemp(join(cache.root, 'decode-'));
        try {
          const worker = new Worker(new URL('./network-worker.js', import.meta.url), { workerData: { ...params, scratch, retain: !!key, measure: !!observe },
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
          retained = { key: key ?? '', worker, scratch, unregister: cache.onInvalidate(releaseNetworkSelection) };
          // Idle failures invalidate the reader; active requests also have their own handlers.
          const entry = retained;
          worker.on('error', () => { entry.dead = true; });
          worker.on('exit', () => { entry.dead = true; });
        } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
      }
      const { worker } = retained;
      worker.ref();
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, result?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          worker.off('message', message); worker.off('error', fail); worker.off('exit', exited);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(new Error('Request cancelled'));
        const fail = (error: Error) => finish(error);
        const exited = () => finish(new Error('Network decoder exited without a result'));
        const message = (msg: any) => {
          if (msg.measurement) {
            try { observe?.(msg.measurement); } catch { /* Diagnostics cannot change request success. */ }
          } else finish(msg.error ? new Error(msg.error) : undefined, msg.result);
        };
        const timer = setTimeout(() => finish(new Error('Network snapshot decoding timed out')), 120000);
        worker.on('message', message); worker.once('error', fail); worker.once('exit', exited);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else if (reused) worker.postMessage(params);
      });
      if (!key) await dispose();
      else {
        worker.unref();
        retained!.idle = setTimeout(() => { void releaseNetworkSelection().catch(() => {}); }, 60000);
        retained!.idle.unref();
      }
      return result;
    });
  } catch (error) { await dispose(); throw error; }
  finally { busy = false; }
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
