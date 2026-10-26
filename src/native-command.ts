import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { rustBinary, rustMode } from './network-rust.js';

/** Select once, before any mutation. A native failure never replays a write in Node. */
export async function nativeAvailable() {
  if (rustMode() !== 'rust' || process.platform === 'win32') return false;
  try { await access(process.env.FIGMA_RUST_BINARY ?? rustBinary); return true; }
  catch { return false; }
}
export function nativeCommand(mode: string, command: unknown, binary = process.env.FIGMA_RUST_BINARY ?? rustBinary, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
  const bytes = Buffer.from(JSON.stringify(command));
  if (bytes.length > 12 * 1024 * 1024) return Promise.reject(new Error('Native request limit exceeded'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = []; let size = 0, diagnostic = '', failure: Error | undefined;
    const kill = () => { child.kill('SIGKILL'); };
    const fail = (error: Error) => { failure ??= error; kill(); };
    const abort = () => fail(new Error('Request cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    process.once('exit', kill);
    const timer = setTimeout(() => fail(new Error('Native operation timed out')), 120000);
    child.on('error', fail); child.stdin.on('error', fail);
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > 12 * 1024 * 1024) fail(new Error('Native response limit exceeded')); else chunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { if (diagnostic.length + b.length > 65536) fail(new Error('Native diagnostic limit exceeded')); else diagnostic += b.toString(); });
    child.once('close', code => {
      clearTimeout(timer); process.off('exit', kill); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(diagnostic.trim() || `Native operation exited (${code})`));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (reply.error) throw Object.assign(new Error(`${reply.code ? reply.code + ': ' : ''}${reply.error}`), reply.code ? { code: reply.code } : {});
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(bytes);
  });
}
