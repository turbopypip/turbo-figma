import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import { Decompress } from 'fzstd';
import { styleFields, keepStyleField } from './network-style.js';

type RecordValue = Record<string, any>;
const LIMIT = 128 * 1024 * 1024;
export const nodeFields = new Set([...styleFields, 'guid', 'phase', 'parentIndex', 'type', 'name', 'visible', 'opacity', 'size', 'transform',
  'fillPaints', 'strokePaints', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'rectangleCornerRadii',
  'stackMode', 'stackSpacing', 'stackHorizontalPadding', 'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom',
  'resizeToFit', 'minSize', 'maxSize', 'horizontalConstraint', 'verticalConstraint', 'textAutoResize', 'stackCounterSpacing', 'stackCounterAlignContent',
  'stackChildPrimaryGrow', 'stackPositioning', 'stackWrap', 'stackChildAlignSelf', 'stackPrimaryAlignItems', 'stackCounterAlignItems', 'stackPrimarySizing', 'stackCounterSizing',
  'fontSize', 'fontName', 'textData', 'textAlignHorizontal', 'textAlignVertical', 'lineHeight', 'letterSpacing',
  'componentPropAssignments', 'componentPropRefs', 'componentPropDefs', 'symbolData', 'derivedSymbolData', 'overrideKey', 'overriddenSymbolID', 'guidPath', 'componentKey']);
export const safeId = (g: any): string => {
  if (!g || !Number.isSafeInteger(g.sessionID) || !Number.isSafeInteger(g.localID) || g.sessionID < 0 || g.localID < 0) throw new Error('Invalid node GUID');
  return `${g.sessionID}:${g.localID}`;
};

// Accept one bounded frame. No concatenated frames, dictionaries or unknown sizes.
// This intentionally fails closed on formats not seen in our capture.
export function inflateFrame(data: Uint8Array, limit = LIMIT): Uint8Array {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 6 || b.readUInt32LE(0) !== 0xfd2fb528) throw new Error('Expected Zstandard frame');
  const flags = b[4], single = (flags >> 5) & 1, sizeFlag = flags >> 6;
  if (flags & 0x18 || flags & 3) throw new Error('Unsupported Zstandard flags/dictionary');
  const sizeBytes = sizeFlag ? 1 << sizeFlag : single;
  let offset = 6 - single;
  if (!sizeBytes || b.length < offset + sizeBytes) throw new Error('Zstandard content size missing');
  const size = sizeBytes === 8 ? Number(b.readBigUInt64LE(offset)) : b.readUIntLE(offset, sizeBytes) + (sizeFlag === 1 ? 256 : 0);
  const baseWindow = single ? size : 2 ** (10 + (b[5] >> 3));
  const window = single ? size : baseWindow + baseWindow / 8 * (b[5] & 7);
  if (!Number.isSafeInteger(size) || size > limit || window > limit) throw new Error(`Decompressed message exceeds ${limit / 1048576} MiB`);
  offset += sizeBytes;
  let last = false;
  while (!last) {
    if (offset + 3 > b.length) throw new Error('Truncated Zstandard block');
    const header = b.readUIntLE(offset, 3); offset += 3;
    last = !!(header & 1);
    const type = (header >> 1) & 3, length = header >> 3;
    if (type === 3 || length > 131072) throw new Error('Invalid Zstandard block');
    offset += type === 1 ? 1 : length;
    if (offset > b.length) throw new Error('Truncated Zstandard payload');
  }
  if (flags & 4) offset += 4;
  if (offset !== b.length) throw new Error('Trailing or truncated Zstandard frame');
  const result = new Uint8Array(size);
  let written = 0;
  const decoder = new Decompress(chunk => {
    if (written + chunk.length > size) throw new Error('Zstandard size mismatch');
    result.set(chunk, written); written += chunk.length;
  });
  decoder.push(b, true);
  if (written !== size) throw new Error('Zstandard size mismatch');
  return result;
}

export function compileWireSchema(bytes: Uint8Array, markersOnly = false) {
  const schema = decodeBinarySchema(bytes);
  if (schema.definitions.length > 2000) throw new Error('Schema too large');
  // Decoder code generation quotes names, but also uses plain-object lookups.
  const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'ByteBuffer']);
  for (const d of schema.definitions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name) || forbidden.has(d.name) || d.fields.length > 4000) throw new Error('Invalid schema definition');
    for (const f of d.fields) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name) || forbidden.has(f.name)) throw new Error('Invalid schema field');
      // Read through omitted fields without retaining arrays/blobs in the model.
      if (d.name === 'Message') f.isDeprecated = !(markersOnly ? ['type'] : ['type', 'nodeChanges']).includes(f.name);
      if (!keepStyleField(d.name, f.name)) f.isDeprecated = true;
      if (d.name === 'NodeChange') f.isDeprecated = !(markersOnly ? new Set(['phase']) : nodeFields).has(f.name);
    }
  }
  return compileSchema(schema);
}

export type NetworkQuery = { variablesFile?: string; format?: 'context' | 'debug'; url: string; depth: number; maxNodes: number; offset: number; includeHidden: boolean; maxBytes?: number; continuation?: string };
export function parseNetworkSelection(raw: string) {
  const u = new URL(raw);
  const match = /^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/.exec(u.pathname);
  const nodeId = (u.searchParams.get('node-id') || '').replaceAll('-', ':');
  if (u.origin !== 'https://www.figma.com' || !match || !/^\d+:\d+$/.test(nodeId)) throw new Error('Expected a Figma design/file selection URL with node-id');
  return { fileKey: match[1], nodeId };
}

export class NetworkSnapshot {
  private nodes = new Map<string, RecordValue>();
  private children = new Map<string, string[]>();
  private codec: any;
  private socketKey?: string;
  private joined = false;
  private ended = false;
  private batches = 0;
  private liveChanges = 0;
  constructor(readonly fileKey: string) {}
  consume(event: RecordValue) {
    if (event.kind === 'ws-open') {
      const u = new URL(event.url);
      if (u.origin !== 'wss://www.figma.com' || u.pathname !== `/api/multiplayer/${this.fileKey}`) return;
      if (this.socketKey) throw new Error('Multiple multiplayer connections: recapture one clean load');
      this.socketKey = event.key;
    }
    if (event.key !== this.socketKey || event.kind !== 'ws-received') return;
    if (event.opcode !== 2) throw new Error('Unsupported text multiplayer message');
    if (typeof event.payload !== 'string' || event.payload.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.payload)) throw new Error('Invalid binary payload');
    const b = Buffer.from(event.payload, 'base64');
    if (b.subarray(0, 8).toString() === 'fig-wire') {
      if (this.codec || b.length < 12 || b.readUInt32LE(8) !== 1) throw new Error('Unsupported or repeated fig-wire schema');
      this.codec = compileWireSchema(inflateFrame(b.subarray(12))); return;
    }
    if (!this.codec) throw new Error('Missing wire schema');
    const message = this.codec.decodeMessage(inflateFrame(b));
    this.apply(message);
  }
  apply(message: RecordValue) {
    if (message.type === 'JOIN_START') {
      if (this.joined) throw new Error('Repeated JOIN_START');
      this.joined = true;
    } else if (message.type === 'JOIN_END') {
      if (!this.joined) throw new Error('JOIN_END without JOIN_START');
      this.ended = true;
    } else if (message.type === 'NODE_CHANGES') {
      if (!this.joined) throw new Error('Node batch before JOIN_START');
      // Later mutations deliberately do not contaminate a consistent initial snapshot.
      if (this.ended) { this.liveChanges++; return; }
      if (!Array.isArray(message.nodeChanges)) throw new Error('Missing node changes');
      this.batches++;
      for (const n of message.nodeChanges) {
        if (n.phase !== 'CREATED') throw new Error('Initial batch contains non-CREATED change');
        const id = safeId(n.guid);
        if (this.nodes.has(id) || this.nodes.size >= 200000) throw new Error('Duplicate node or node limit exceeded');
        const kept: RecordValue = {};
        for (const field of nodeFields) if (n[field] !== undefined && field !== 'symbolData') kept[field] = n[field];
        // Instances remain references, not expanded rendered trees.
        if (n.type === 'INSTANCE') kept.instanceUnresolved = true;
        this.nodes.set(id, kept);
      }
    }
  }
  finish() {
    if (!this.ended || !this.nodes.size) throw new Error('Incomplete initial load: JOIN_END or nodes missing. Recapture after loading finishes.');
    for (const [id, n] of this.nodes) {
      if (!n.parentIndex) continue;
      const parent = safeId(n.parentIndex.guid);
      if (typeof n.parentIndex.position !== 'string') throw new Error('Invalid sibling position');
      const list = this.children.get(parent) || [];
      list.push(id); this.children.set(parent, list);
    }
    for (const list of this.children.values()) list.sort((a, b) => {
      const x = this.nodes.get(a)!.parentIndex.position, y = this.nodes.get(b)!.parentIndex.position;
      return x < y ? -1 : x > y ? 1 : a.localeCompare(b);
    });
    this.codec = undefined;
  }
  query(params: NetworkQuery) {
    const selection = parseNetworkSelection(params.url);
    if (selection.fileKey !== this.fileKey) throw new Error('Selection file does not match capture');
    if (!this.nodes.has(selection.nodeId)) throw new Error('Selected node not present in capture');
    if (!Number.isInteger(params.depth) || params.depth < 0 || params.depth > 50 || !Number.isInteger(params.maxNodes) || params.maxNodes < 1 || params.maxNodes > 500 || !Number.isInteger(params.offset) || params.offset < 0) throw new Error('Invalid traversal limits');
    const stack = [{ id: selection.nodeId, depth: 0 }], seen = new Set<string>();
    const eligible: { id: string; depth: number }[] = [], pending: string[] = [], skipped: string[] = [];
    while (stack.length) {
      const item = stack.pop()!, n = this.nodes.get(item.id)!;
      if (seen.has(item.id)) throw new Error('Cycle in selected tree');
      seen.add(item.id);
      if (!params.includeHidden && n.visible === false) { skipped.push(item.id); continue; }
      eligible.push(item);
      const children = this.children.get(item.id) || [];
      if (item.depth >= params.depth) { if (children.length) pending.push(item.id); continue; }
      for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i], depth: item.depth + 1 });
    }
    const result: RecordValue[] = [];
    let bytes = 0;
    for (const item of eligible.slice(params.offset, params.offset + params.maxNodes)) {
      const n = this.nodes.get(item.id)!;
      const { guid, parentIndex, phase, ...properties } = n;
      let entry: RecordValue = { id: item.id, parentId: parentIndex ? safeId(parentIndex.guid) : null, depth: item.depth, ...properties };
      if (JSON.stringify(entry).length > 120000) entry = { id: item.id, parentId: entry.parentId, depth: item.depth,
        name: typeof n.name === 'string' ? n.name.slice(0, 1000) : undefined, type: n.type, propertiesOmitted: 'Node exceeds output limit' };
      const length = JSON.stringify(entry).length;
      if (bytes + length > 150000) break;
      bytes += length; result.push(entry);
    }
    const nextOffset = params.offset + result.length;
    return { adapter: 'figma-network-snapshot', live: false, fileKey: this.fileKey, rootId: selection.nodeId,
      documentRecords: this.nodes.size, initialBatches: this.batches, ignoredLiveBatches: this.liveChanges,
      nodes: result, traversal: { eligibleRecords: eligible.length, returned: result.length, pendingDepth: pending, skippedHidden: skipped,
        nextOffset: nextOffset < eligible.length ? nextOffset : null },
      incomplete: true,
      limitations: ['Captured initial state, not current live state.', 'Instances/overrides are not expanded; variables, geometry blobs and image assets are not resolved.',
        'Sibling order uses wire position; full equivalence with rendered Layers is not verified.'] };
  }
}
