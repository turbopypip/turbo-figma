import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createCapture, transitionSession, type InitialSnapshotEvidence, type SnapshotIdentity } from './network-session.js';

export const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const identitySchema = z.object({ fileKey: z.string().regex(/^[A-Za-z0-9]+$/).max(256),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const frameSchema = z.object({ pageId: z.string().regex(/^\d+:\d+$/).max(100), frameId: z.string().regex(/^\d+:\d+$/).max(100) }).strict();
export type FrameIdentity = z.infer<typeof frameSchema>;
const ownerSchema = z.object({ owner: z.literal('figma-kilo-mcp'), version: z.literal(1), snapshot: identitySchema, frame: frameSchema.optional() }).strict();
export const CACHE_RETENTION = { maxBytes: 1024 * 1024 * 1024, maxAgeMs: 7 * 24 * 60 * 60 * 1000 } as const;
export type CacheInfo = { bytes: number; generations: number; incomplete: number; protectedEntries: number };
type Coordinator = { busy: boolean; writerActive: boolean; readers: number };
const coordinators = new Map<string, WeakRef<Coordinator>>();
const manifestSchema = z.object({ version: z.literal(1), status: z.literal('ready'), snapshot: identitySchema, frame: frameSchema.optional(),
  parts: z.array(z.object({ bytes: z.number().int().min(1).max(MAX_PART_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(MAX_PARTS) }).strict();
export type SnapshotManifest = z.infer<typeof manifestSchema>;
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
function identity(value: SnapshotIdentity): SnapshotIdentity {
  const parsed = identitySchema.parse(value);
  return createCapture(parsed).snapshot;
}
function key(id: SnapshotIdentity, frame?: FrameIdentity) {
  return digest(JSON.stringify([id.fileKey, frame?.pageId ?? null, frame?.frameId ?? null, id.sessionId, id.generation]));
}
function frameIdentity(value?: FrameIdentity): FrameIdentity | undefined { return value === undefined ? undefined : Object.freeze(frameSchema.parse(value)); }
function partName(sequence: number) { return `part-${sequence}.bin`; }

async function directoryStamp(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Unsafe cache directory');
  return `${stat.dev}:${stat.ino}`;
}
async function readBounded(filename: string, limit: number): Promise<Buffer> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Unsafe cache file');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid cache file or size');
    // Bounded even if a file grows after stat; never use unbounded readFile here.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Cache file changed during read');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function writeExclusive(filename: string, bytes: Uint8Array) {
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** No queue: callers must await writes; concurrent operations fail with BUSY. */
export class NetworkStore {
  private constructor(readonly root: string, private readonly stamps: ReadonlyMap<string, string>, private readonly coordinator: Coordinator) {}
  private get busy() { return this.coordinator.busy; }
  private set busy(value: boolean) { this.coordinator.busy = value; }
  private get writerActive() { return this.coordinator.writerActive; }
  private set writerActive(value: boolean) { this.coordinator.writerActive = value; }
  static async create(projectDirectory: string): Promise<NetworkStore> {
    if (!path.isAbsolute(projectDirectory)) throw new Error('Project directory must be absolute');
    const project = await realpath(projectDirectory);
    const stamps = new Map<string, string>();
    for (const directory of [path.join(project, '.cache'), path.join(project, '.cache', 'figma-network')]) {
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      stamps.set(directory, await directoryStamp(directory));
    }
    const root = path.join(project, '.cache', 'figma-network');
    const coordinator = coordinators.get(root)?.deref() ?? { busy: false, writerActive: false, readers: 0 };
    coordinators.set(root, new WeakRef(coordinator));
    return new NetworkStore(root, stamps, coordinator);
  }
  private async guard() {
    for (const [directory, stamp] of this.stamps) {
      if (await directoryStamp(directory) !== stamp) throw new Error('Cache directory was replaced');
    }
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Cache BUSY: await the current operation');
    this.busy = true;
    try { await this.guard(); return await run(); }
    finally { this.busy = false; }
  }
  async begin(value: SnapshotIdentity, selection?: FrameIdentity) {
    const snapshot = identity(value), frame = frameIdentity(selection);
    return this.operation(async () => {
      this.assertIdle();
      const directory = path.join(this.root, key(snapshot, frame));
      // Check before pruning: a duplicate begin must never remove/reuse its own generation.
      try { await lstat(directory); throw new Error('EEXIST: capture generation already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.cleanUnlocked('prune');
      await mkdir(directory, { mode: 0o700 }); // Existing generations are never overwritten/reused.
      const stamp = await directoryStamp(directory);
      await writeExclusive(path.join(directory, 'capture.json'), Buffer.from(JSON.stringify({ owner: 'figma-kilo-mcp', version: 1, snapshot, ...(frame ? { frame } : {}) })));
      this.writerActive = true;
      let state = createCapture(snapshot);
      let total = 0;
      const parts: SnapshotManifest['parts'] = [];
      const guardWriter = async () => {
        if (state.status !== 'capturing') throw new Error('Capture is closed');
        if (await directoryStamp(directory) !== stamp) throw new Error('Generation directory was replaced');
      };
      const run = async <T>(work: () => Promise<T>): Promise<T> => {
        // BUSY rejection does not invalidate an operation already writing.
        if (this.busy) throw new Error('Cache BUSY: await the current operation');
        try { return await this.operation(async () => { await guardWriter(); return work(); }); }
        catch (error) {
          if (state.status === 'capturing') {
            state = transitionSession(state, { type: 'fail', snapshot, reason: error instanceof Error ? error.message : 'Cache write failed' });
            this.writerActive = false;
          }
          throw error;
        }
      };
      return {
        get state() { return state; },
        append: async (sequence: number, bytes: Uint8Array) => run(async () => {
          if (sequence !== parts.length || parts.length >= MAX_PARTS) throw new Error('Invalid part sequence or part limit');
          if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_PART_BYTES || total + bytes.byteLength > MAX_TOTAL_BYTES) throw new Error('Part or snapshot size limit exceeded');
          // Own one bounded part so caller mutation cannot change persisted bytes/hash.
          const owned = Buffer.from(bytes);
          await writeExclusive(path.join(directory, partName(sequence)), owned);
          parts.push({ bytes: owned.length, sha256: digest(owned) });
          total += owned.length;
        }),
        commit: async (evidence: Omit<InitialSnapshotEvidence, 'persistedParts' | 'metadataCommitted'>, signal?: AbortSignal) => run(async () => {
          const next = transitionSession(state, { type: 'complete', snapshot,
            evidence: { ...evidence, persistedParts: parts.length, metadataCommitted: true } });
          const manifest: SnapshotManifest = { version: 1, status: 'ready', snapshot, ...(frame ? { frame } : {}), parts };
          const encoded = Buffer.from(JSON.stringify(manifest));
          if (encoded.length > MAX_METADATA_BYTES) throw new Error('Metadata size limit exceeded');
          await writeExclusive(path.join(directory, 'manifest.tmp'), encoded);
          signal?.throwIfAborted();
          await rename(path.join(directory, 'manifest.tmp'), path.join(directory, 'ready.json'));
          if (signal?.aborted) {
            await unlink(path.join(directory, 'ready.json'));
            signal.throwIfAborted();
          }
          state = next;
          this.writerActive = false;
          return structuredClone(manifest);
        }),
        abort: async (reason = 'Capture cancelled') => run(async () => {
          state = transitionSession(state, { type: 'fail', snapshot, reason });
          this.writerActive = false;
        }),
      };
    });
  }
  private async manifest(snapshot: SnapshotIdentity, frame?: FrameIdentity): Promise<SnapshotManifest> {
    const directory = path.join(this.root, key(snapshot, frame));
    await directoryStamp(directory);
    const manifest = manifestSchema.parse(JSON.parse((await readBounded(path.join(directory, 'ready.json'), MAX_METADATA_BYTES)).toString('utf8')));
    if (key(manifest.snapshot, manifest.frame) !== key(snapshot, frame) || manifest.parts.reduce((n, p) => n + p.bytes, 0) > MAX_TOTAL_BYTES) throw new Error('Invalid manifest identity or size');
    return manifest;
  }
  async readManifest(value: SnapshotIdentity, selection?: FrameIdentity): Promise<SnapshotManifest> {
    const snapshot = identity(value), frame = frameIdentity(selection);
    return this.operation(() => this.manifest(snapshot, frame));
  }
  async readPart(value: SnapshotIdentity, sequence: number, selection?: FrameIdentity): Promise<Buffer> {
    const snapshot = identity(value), frame = frameIdentity(selection);
    return this.operation(async () => {
      const manifest = await this.manifest(snapshot, frame);
      if (!Number.isInteger(sequence) || sequence < 0 || sequence >= manifest.parts.length) throw new Error('Invalid part sequence');
      const expected = manifest.parts[sequence];
      const bytes = await readBounded(path.join(this.root, key(snapshot, frame), partName(sequence)), MAX_PART_BYTES);
      if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error('Corrupt snapshot part');
      return bytes;
    });
  }

  /** Protect a complete multi-part read, including gaps between readPart calls. */
  async withRead<T>(read: () => Promise<T>): Promise<T> {
    await this.operation(async () => {
      if (this.writerActive) throw new Error('Cache BUSY: capture is active');
      this.coordinator.readers++;
    });
    try { return await read(); }
    finally { this.coordinator.readers--; }
  }
  private assertIdle() {
    if (this.writerActive || this.coordinator.readers) throw new Error('Cache BUSY: reading or capturing; retry after completion');
  }
  private async inventory() {
    const entries: { name: string; files: string[]; bytes: number; ready: boolean; group: string; modified: number; generation: number }[] = [];
    let protectedEntries = 0, visited = 0, visitedFiles = 0;
    for await (const item of await opendir(this.root)) {
      if (++visited > 10000) throw new Error('Cache directory entry limit exceeded');
      if (!/^[a-f0-9]{64}$/.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) { protectedEntries++; continue; }
      const directory = path.join(this.root, item.name);
      try {
        await directoryStamp(directory);
        const owner = ownerSchema.parse(JSON.parse((await readBounded(path.join(directory, 'capture.json'), 4096)).toString('utf8')));
        if (key(owner.snapshot, owner.frame) !== item.name) { protectedEntries++; continue; }
        const files: string[] = [];
        let bytes = 0, safe = true, modified = 0;
        for await (const file of await opendir(directory)) {
          if (++visitedFiles > 100000) throw Object.assign(new Error('Cache file entry limit exceeded'), { code: 'CACHE_LIMIT' });
          if (files.length > MAX_PARTS + 3) { safe = false; break; }
          if (!/^(capture\.json|ready\.json|manifest\.tmp|part-(0|[1-9]\d{0,3})\.bin)$/.test(file.name)) { safe = false; break; }
          const stat = await lstat(path.join(directory, file.name));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { safe = false; break; }
          files.push(file.name); bytes += stat.size;
          if (file.name === 'ready.json') modified = stat.mtimeMs;
        }
        if (!safe) { protectedEntries++; continue; }
        let ready = false;
        if (files.includes('ready.json')) {
          try {
            const manifest = await this.manifest(owner.snapshot, owner.frame);
            const names = new Set(files);
            ready = manifest.parts.every((_, i) => names.has(partName(i)));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // Corrupt metadata is recoverable cache, never a ready generation.
          }
        }
        entries.push({ name: item.name, files, bytes, ready, modified, generation: owner.snapshot.generation,
          group: JSON.stringify([owner.snapshot.fileKey, owner.frame?.pageId ?? null, owner.frame?.frameId ?? null]) });
      } catch (error) {
        // Unowned, damaged markers are protected. Disk/access failures remain explicit.
        if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        protectedEntries++;
      }
    }
    return { entries, protectedEntries };
  }
  async info(): Promise<CacheInfo> {
    return this.operation(async () => {
      const { entries, protectedEntries } = await this.inventory();
      return { bytes: entries.reduce((n, e) => n + e.bytes, 0), generations: entries.length,
        incomplete: entries.filter(e => !e.ready).length, protectedEntries };
    });
  }
  /** One maintenance path: clear all managed data or apply bounded retention. */
  async clean(mode: 'all' | 'prune' = 'all') {
    if (mode !== 'all' && mode !== 'prune') throw new Error('Invalid cache cleanup mode');
    return this.operation(() => this.cleanUnlocked(mode));
  }
  private async cleanUnlocked(mode: 'all' | 'prune') {
    this.assertIdle();
    const { entries, protectedEntries } = await this.inventory();
    const groups = new Set<string>();
    let retainedBytes = 0, removedBytes = 0, removedGenerations = 0;
    const now = Date.now();
    entries.sort((a, b) => b.modified - a.modified || b.generation - a.generation || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const keep = mode === 'prune' && entry.ready && !groups.has(entry.group)
        && now - entry.modified <= CACHE_RETENTION.maxAgeMs && retainedBytes + entry.bytes <= CACHE_RETENTION.maxBytes;
      // Never fall back to an older generation of the same selection.
      if (entry.ready) groups.add(entry.group);
      if (keep) { retainedBytes += entry.bytes; continue; }
      const directory = path.join(this.root, entry.name);
      await directoryStamp(directory);
      // Unpublish first, so a partial deletion is never advertised as ready.
      const rank = (name: string) => name === 'ready.json' ? 0 : name === 'capture.json' ? 2 : 1;
      const files = [...entry.files].sort((a, b) => rank(a) - rank(b));
      for (const file of files) await unlink(path.join(directory, file));
      await rmdir(directory); // No recursive deletion: unknown files are never removed.
      removedBytes += entry.bytes; removedGenerations++;
    }
    return { removedBytes, removedGenerations, bytes: retainedBytes, protectedEntries };
  }
}
