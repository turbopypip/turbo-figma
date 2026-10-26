// Experimental stage-06 bridge. Production never imports this module.
import { spawn } from 'node:child_process';
import { defaultBinary } from './host.mjs';
const MAX = 64 * 1024 * 1024;
export function nativeSession(mode, config, { signal, timeoutMs = 60000, stage = 6, binary = defaultBinary } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED' });
  const child = spawn(binary, [`--stage${stage}`, mode, ...(config ? [config] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let failure, stderr = '', busy = false;
  const stop = error => { failure ??= error; child.kill('SIGKILL'); };
  const abort = () => stop(Object.assign(new Error('ABORTED'), { code: 'ABORTED' }));
  const timer = setTimeout(() => stop(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.on('error', stop); child.stdin.on('error', stop);
  child.stderr.on('data', b => { if (stderr.length + b.length > 65536) stop(new Error('LOG_LIMIT')); else stderr += b; });
  const closed = new Promise(resolve => child.on('close', code => {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (code !== 0) failure ??= new Error(stderr.trim() || `Native exit ${code}`);
    resolve();
  }));
  const iterator = child.stdout[Symbol.asyncIterator](); let chunk = Buffer.alloc(0), offset = 0;
  async function read(n, eof = false) {
    const out = Buffer.allocUnsafe(n); let written = 0;
    while (written < n) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) { await closed; if (failure) throw failure; if (eof && !written) return null; throw Error('Truncated native packet'); }
        chunk = next.value; offset = 0;
      }
      const count = Math.min(n - written, chunk.length - offset); chunk.copy(out, written, offset, offset + count); offset += count; written += count;
    }
    return out;
  }
  async function packet(eof = false) {
    const h = await read(4, eof); if (!h) return null;
    const n = h.readUInt32LE(); if (n > MAX) { stop(Error('OUTPUT_LIMIT')); throw Error('OUTPUT_LIMIT'); }
    return read(n);
  }
  return {
    pid: child.pid,
    get metrics() { const match = /STAGE6_METRICS (.+)/.exec(stderr); return match ? JSON.parse(match[1]) : null; },
    async inflate(bytes, limit) {
      if (busy) throw Error('BUSY');
      if (bytes.length > 24 * 1024 * 1024 + 4096 || !Number.isInteger(limit) || limit < 0 || limit > MAX) throw Error('INVALID_LIMIT');
      busy = true;
      try {
        const header = Buffer.alloc(8); header.writeUInt32LE(bytes.length); header.writeUInt32LE(limit, 4);
        child.stdin.write(header); child.stdin.write(bytes);
        return await packet(); // One outstanding request; pipe backpressure bounds native output.
      } finally { busy = false; }
    },
    async *records() {
      child.stdin.end();
      for (;;) { const bytes = await packet(true); if (bytes === null) break; yield bytes; }
    },
    async close() { child.stdin.end(); await closed; if (failure) throw failure; },
    async destroy() { child.kill('SIGKILL'); await closed; },
  };
}

// Native decoder is stricter than fzstd on some corrupt compressed blocks.
// Retry only that frame with the unchanged reference decoder to preserve the
// existing acceptance/error contract; never return a partial native result.
export async function compatibleInflater(options = {}) {
  const { inflateFrame } = await import('../../dist/network.js');
  let session = nativeSession('inflate-stream',undefined,options), fallbacks = 0;
  return {
    get pid() { return session?.pid; },
    get fallbacks() { return fallbacks; },
    get metrics() { return session?.metrics ?? null; },
    async inflate(bytes,limit) {
      session ??= nativeSession('inflate-stream',undefined,options);
      try { return await session.inflate(bytes,limit); }
      catch(error) {
        if (error.message === 'BUSY') throw error;
        await session.destroy();session = undefined;
        if (options.signal?.aborted || error.code==='TIMEOUT' || error.code==='ABORTED') throw error;
        fallbacks++;
        return Buffer.from(inflateFrame(bytes,limit));
      }
    },
    async close() { if(session)await session.close(); },
    async destroy() { if(session)await session.destroy();session=undefined; },
  };
}

// serde_json is intentionally stricter than JSON.parse (e.g. lone escaped
// surrogates and nesting). Replay the reference reader on native rejection.
// Already emitted records are verified with a rolling hash, then skipped.
// Caller must keep the NetworkStore read lease for the whole iteration.
export async function* compatibleInput(config, options = {}) {
  const { createHash } = await import('node:crypto');
  const { nodeInput } = await import('./stage6-common.mjs');
  const session = nativeSession('input-stream', config.config, options);
  options.onPid?.(session.pid);
  const digest = createHash('sha256'); let emitted = 0, error;
  const update = (h,b) => { const size=Buffer.alloc(4);size.writeUInt32LE(b.length);h.update(size);h.update(b); };
  try {
    for await (const b of session.records()) { update(digest,b);emitted++;yield b; }
  } catch(e) { error=e; } finally { options.onMetrics?.(session.metrics); await session.destroy(); }
  if (!error) return;
  if (options.signal?.aborted || error.code==='TIMEOUT' || error.code==='ABORTED') throw error;
  options.onFallback?.(error);
  const previous = digest.digest('hex'), replay = createHash('sha256');let skipped=0;
  for await (const b of nodeInput(config)) {
    if(skipped<emitted){update(replay,b);skipped++;if(skipped===emitted && replay.digest('hex')!==previous)throw Error('Snapshot changed during input replay');continue;}
    yield b;
  }
  if(skipped!==emitted)throw Error('Snapshot changed during input replay');
}
