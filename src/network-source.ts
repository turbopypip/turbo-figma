import { open } from 'node:fs/promises';
import { NetworkStore } from './network-store.js';
import type { SnapshotIdentity } from './network-session.js';
export const MAX_CAPTURE_RECORD = 24 * 1024 * 1024 + 4096;

/** Small buffered cursor; only one JSON value (one event) is ever materialized. */
class JsonCursor {
  private chunk = Buffer.alloc(0);
  private index = 0;
  private total = 0;
  constructor(private handle: Awaited<ReturnType<typeof open>>) {}
  async peek(): Promise<number> {
    if (this.index === this.chunk.length) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, null);
      this.total += bytesRead;
      if (this.total > 1024 * 1024 * 1024) throw new Error('Capture size limit exceeded');
      this.chunk = buffer.subarray(0, bytesRead); this.index = 0;
    }
    return this.chunk[this.index] ?? -1;
  }
  async whitespace() { while ([9, 10, 13, 32].includes(await this.peek())) this.index++; }
  async expect(byte: number) { await this.whitespace(); if (await this.peek() !== byte) throw new Error('Invalid capture JSON'); this.index++; }
  async value(limit: number): Promise<any> {
    await this.whitespace();
    const parts: Buffer[] = [];
    let size = 0, depth = 0, quoted = false, escaped = false, started = false;
    for (;;) {
      const first = await this.peek();
      if (first === -1) throw new Error('Truncated capture JSON');
      const start = this.index;
      let complete = false;
      while (this.index < this.chunk.length) {
        const b = this.chunk[this.index];
        if (!quoted && depth === 0 && started && [9, 10, 13, 32, 44, 93, 125, 58].includes(b)) { complete = true; break; }
        this.index++; started = true;
        if (quoted) {
          if (escaped) escaped = false;
          else if (b === 92) escaped = true;
          else if (b === 34) { quoted = false; if (depth === 0) { complete = true; break; } }
        } else if (b === 34) quoted = true;
        else if (b === 123 || b === 91) depth++;
        else if (b === 125 || b === 93) { if (--depth <= 0) { complete = true; break; } }
      }
      const part = this.chunk.subarray(start, this.index);
      size += part.length;
      if (size > limit) throw new Error('Capture record size limit exceeded');
      parts.push(part);
      if (complete) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size)));
    }
  }
}
export async function* probeEvents(filename: string): AsyncGenerator<{ event?: any; metadata?: Record<string, any> }> {
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error('Capture file size limit exceeded');
    const cursor = new JsonCursor(handle), metadata: Record<string, any> = {}, keys = new Set<string>();
    await cursor.expect(123);
    for (;;) {
      await cursor.whitespace();
      if (await cursor.peek() === 125) break;
      const key = await cursor.value(1024);
      if (typeof key !== 'string' || keys.has(key) || keys.size >= 32 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid capture metadata');
      keys.add(key); await cursor.expect(58);
      if (key === 'events') {
        await cursor.expect(91); let count = 0;
        await cursor.whitespace();
        if (await cursor.peek() !== 93) for (;;) {
          if (++count > 10000) throw new Error('Capture event limit exceeded');
          const event = await cursor.value(MAX_CAPTURE_RECORD);
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid capture event');
          yield { event };
          await cursor.whitespace();
          if (await cursor.peek() === 93) break;
          await cursor.expect(44);
        }
        await cursor.expect(93);
      } else metadata[key] = await cursor.value(64 * 1024);
      await cursor.whitespace();
      if (await cursor.peek() === 125) break;
      await cursor.expect(44);
      await cursor.whitespace();
      if (await cursor.peek() === 125) throw new Error('Trailing capture comma');
    }
    await cursor.expect(125); await cursor.whitespace();
    if (await cursor.peek() !== -1 || !keys.has('events') || ![1, 2].includes(metadata.version) || typeof metadata.fileUrl !== 'string') throw new Error('Invalid probe capture');
    yield { metadata };
  } finally { await handle.close(); }
}

export async function* storedEvents(projectDirectory: string, snapshot: SnapshotIdentity): AsyncGenerator<any> {
  const store = await NetworkStore.create(projectDirectory);
  const manifest = await store.readManifest(snapshot);
  let pending = Buffer.alloc(0), sequence = 0, socket: string | undefined;
  for (let i = 0; i < manifest.parts.length; i++) {
    const part = await store.readPart(snapshot, i);
    let offset = 0;
    while (offset < part.length) {
      const newline = part.indexOf(10, offset), end = newline < 0 ? part.length : newline;
      if (pending.length + end - offset > MAX_CAPTURE_RECORD) throw new Error('Capture record size limit exceeded');
      const fragment = part.subarray(offset, end);
      pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
      offset = end + 1;
      if (newline < 0) break;
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)); pending = Buffer.alloc(0);
      if (record.version !== 1 || record.kind !== 'ws-received' || record.opcode !== 2 || record.eventSequence !== sequence++
        || typeof record.session !== 'string' || record.session.length > 256 || typeof record.requestId !== 'string' || record.requestId.length > 256) throw new Error('Invalid stored capture event');
      const key = JSON.stringify([record.session, record.requestId]);
      if (socket && socket !== key) throw new Error('Multiple multiplayer streams');
      if (!socket) { socket = key; yield { kind: 'ws-open', key, url: `wss://www.figma.com/api/multiplayer/${snapshot.fileKey}` }; }
      yield { kind: 'ws-received', key, opcode: 2, payload: record.payload };
    }
  }
  if (pending.length || !sequence) throw new Error('Incomplete stored capture record');
}
