import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nodeFields } from './network.js';
import type { SnapshotIdentity } from './network-session.js';

export const RUST_PACKET_BYTES = 4 * 1024 * 1024;
export const rustBinary = fileURLToPath(new URL(`../rust/helper/target/release/figma-rust-helper${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
export function rustMode() {
  const mode = process.env.FIGMA_NETWORK_BACKEND ?? (['darwin', 'win32'].includes(process.platform) ? 'rust' : 'node');
  if (!['rust', 'node'].includes(mode)) throw new Error('FIGMA_NETWORK_BACKEND must be rust or node');
  return mode;
}

/** Owned by the MCP main process, so terminating a projection worker cannot orphan Rust. */
export class RustSnapshot {
  private child: ChildProcessWithoutNullStreams;
  private closed: Promise<void>;
  private failure?: Error;
  private iterator: AsyncIterator<Buffer>;
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  private stderr = '';
  private busy = false;
  private stopped = false;
  private exit = () => { this.child.kill('SIGKILL'); };
  readonly pid: number | undefined;
  loaded: any;
  private constructor(config: string) {
    this.child = spawn(process.env.FIGMA_RUST_BINARY ?? rustBinary, ['--stage8', 'runtime', config], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pid = this.child.pid;
    this.iterator = this.child.stdout[Symbol.asyncIterator]();
    const fail = (e: Error) => { this.failure ??= new Error(`Rust transport failed: ${e.message}`); this.child.kill('SIGKILL'); };
    this.child.on('error', fail); this.child.stdin.on('error', fail);
    this.child.stderr.on('data', (b: Buffer) => {
      if (this.stderr.length + b.length > 65536) fail(new Error('Rust diagnostic limit exceeded'));
      else this.stderr += b.toString();
    });
    this.closed = new Promise(resolve => this.child.once('close', code => {
      this.stopped = true;
      this.failure ??= new Error(this.stderr.trim() || `Rust index exited (${code})`);
      process.off('exit', this.exit); resolve();
    }));
    process.once('exit', this.exit);
  }
  static async open(root: string, snapshot: SnapshotIdentity, scratch: string, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Request cancelled');
    const key = createHash('sha256').update(JSON.stringify([snapshot.fileKey, null, null, snapshot.sessionId, snapshot.generation])).digest('hex');
    const config = join(scratch, 'rust-config.json');
    await writeFile(config, JSON.stringify({ directory: join(root, key), snapshot, scratch, fields: [...nodeFields] }), { mode: 0o600 });
    const session = new RustSnapshot(config);
    const abort = () => { session.failure = new Error('Request cancelled'); session.child.kill('SIGKILL'); };
    const timer = setTimeout(() => { session.failure = new Error('Rust load timed out'); session.child.kill('SIGKILL'); }, 120000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      session.loaded = await session.packet();
      if (session.loaded.kind !== 'loaded' || session.loaded.version !== 1) throw new Error('Unsupported Rust runtime protocol');
      return session;
    } catch (e) { await session.destroy(); throw e; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  private async read(n: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(n); let written = 0;
    while (written < n) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) { await this.closed; throw this.failure ?? new Error('Truncated Rust response'); }
        this.chunk = next.value; this.offset = 0;
      }
      const count = Math.min(n - written, this.chunk.length - this.offset);
      this.chunk.copy(result, written, this.offset, this.offset + count); written += count; this.offset += count;
    }
    return result;
  }
  private async packet(raw = false) {
    const size = (await this.read(4)).readUInt32LE();
    if (size > RUST_PACKET_BYTES) throw new Error('Rust response limit exceeded');
    const bytes = await this.read(size);
    return raw ? bytes : JSON.parse(bytes.toString('utf8'));
  }
  async request(command: unknown, raw = false, signal?: AbortSignal, timeoutMs = 10000): Promise<any> {
    if (signal?.aborted) throw new Error('Request cancelled');
    if (this.busy) throw new Error('Rust index is busy');
    if (this.stopped || this.failure) throw this.failure ?? new Error('Rust index is closed');
    const bytes = Buffer.from(JSON.stringify(command));
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Rust request limit exceeded');
    this.busy = true;
    const abort = () => { this.failure = new Error('Request cancelled'); this.child.kill('SIGKILL'); };
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { this.failure = new Error('Rust request timed out'); this.child.kill('SIGKILL'); }, timeoutMs);
    try {
      const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
      this.child.stdin.write(header); this.child.stdin.write(bytes);
      return await this.packet(raw);
    } catch (e) { await this.destroy(); throw e; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); this.busy = false; }
  }
  async destroy() { this.child.kill('SIGKILL'); await this.closed; }
}
