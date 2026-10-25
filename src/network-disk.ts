import { LIVE_LIMITS, validateLiveChange, assertLiveType } from './network-live.js';
import { effectiveVariableNode, nativeVariableBindings } from './network-variables.js';
import { VariableAssetIndex } from './network-variable-index.js';
import { inheritVariableModes, resolveNativeVariable, type ModeContext } from './network-variable-resolver.js';
import { networkStyle } from './network-style.js';
import { designContextNode } from './network-context.js';
import { geometryContext, type GeometryContext } from './network-geometry.js';
import { instanceNode, enterInstance, type InstanceContext } from './network-instances.js';
import { networkLayout } from './network-layout.js';
import { responseBudget } from './network-pagination.js';
import { openSync, closeSync, readSync, writeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { nodeFields, parseNetworkSelection, safeId, type NetworkQuery } from './network.js';
const SLOTS = 524288, SLOT_BYTES = 48, EDGE_BYTES = 24;
export const SELECTION_LIMITS = { nodes: 2048, bytes: 4 * 1024 * 1024 } as const;
export const COMPONENT_LIMITS = { reads:20000, bytes:64*1024*1024 } as const;
export const DISK_LIMITS = { nodes: 200000, nodeBytes: 1024 * 1024, totalBytes: 512 * 1024 * 1024,
  siblings: 10000, siblingBytes: 2 * 1024 * 1024 } as const;
function write(fd: number, data: Buffer, position: number) {
  let offset = 0;
  while (offset < data.length) {
    const n = writeSync(fd, data, offset, data.length - offset, position + offset);
    if (!n) throw new Error('Incomplete disk index write');
    offset += n;
  }
}
function read(fd: number, size: number, position: number) {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const n = readSync(fd, data, offset, size - offset, position + offset);
    if (!n) throw new Error('Truncated disk index');
    offset += n;
  }
  return data;
}
/** An on-disk hash table + node log + linked child edges; no document map in RAM. */
export class DiskNetworkSnapshot {
  private variableAssets: VariableAssetIndex;
  private layoutSchemaHash?: string;
  setLayoutSchemaHash(hash: string) { this.layoutSchemaHash = hash; }
  private fds: number[] = [];
  private selected = new Map<string, string>();
  private selectedBytes = 0;
  private selectionId?: string;
  selectionCacheStats() { return { nodes: this.selected.size, bytes: this.selectedBytes }; }
  private log = 0;
  private table = 0;
  private edges = 0;
  private bytes = 0;
  private edgeCount = 0;
  private slots = 0;
  private count = 0;
  private started = false;
  private ended = false;
  private batchNodes = 0;
  private batches = 0;
  private live = 0;
  private applied = 0;
  private poisoned = false;
  constructor(readonly fileKey: string, directory: string) {
    try {
      for (const name of ['nodes.bin', 'index.bin', 'edges.bin','variable-assets.bin']) this.fds.push(openSync(join(directory, name), 'wx+', 0o600));
      [this.log, this.table, this.edges] = this.fds;
      ftruncateSync(this.table, SLOTS * SLOT_BYTES);
      this.variableAssets=new VariableAssetIndex(this.fds[3]);
    } catch (error) { this.close(); throw error; }
  }
  close() { for (const fd of this.fds.splice(0)) closeSync(fd); }
  private slot(id: string, create = false): { buffer: Buffer; offset: number } | undefined {
    const [session, local] = id.split(':').map(Number);
    let hash = 2166136261;
    for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    for (let i = 0; i < 4096; i++) {
      const offset = ((hash + i) % SLOTS) * SLOT_BYTES, buffer = read(this.table, SLOT_BYTES, offset);
      if (!buffer[0]) {
        if (!create) return;
        if (++this.slots > DISK_LIMITS.nodes * 2) throw new Error('Disk index identity limit exceeded');
        buffer[0] = 1; buffer.writeDoubleLE(session, 8); buffer.writeDoubleLE(local, 16);
        write(this.table, buffer, offset); return { buffer, offset };
      }
      if (buffer.readDoubleLE(8) === session && buffer.readDoubleLE(16) === local) return { buffer, offset };
    }
    throw new Error('Disk index capacity exceeded');
  }
  acceptNode(n: Record<string, any>) {
    if (!this.started) throw new Error('Node batch before JOIN_START');
    this.batchNodes++;
    if (this.ended) return;
    if (n.phase !== 'CREATED') throw new Error('Initial batch contains non-CREATED change');
    if (++this.count > DISK_LIMITS.nodes) throw new Error('Node limit exceeded');
    const id = safeId(n.guid), slot = this.slot(id, true)!;
    if (slot.buffer.readUInt32LE(32)) throw new Error('Duplicate node');
    const kept: Record<string, any> = {};
    for (const field of nodeFields) if (n[field] !== undefined) kept[field] = n[field];
    if (n.type === 'INSTANCE') kept.instanceUnresolved = true;
    const data = Buffer.from(JSON.stringify(kept));
    if (data.length > DISK_LIMITS.nodeBytes || this.bytes + data.length > DISK_LIMITS.totalBytes) throw new Error('Decoded node/disk size limit exceeded');
    slot.buffer.writeDoubleLE(this.bytes, 24); slot.buffer.writeUInt32LE(data.length, 32);
    write(this.log, data, this.bytes); write(this.table, slot.buffer, slot.offset); this.bytes += data.length;
    this.variableAssets.add(kept);
    if (n.parentIndex) {
      const parent = safeId(n.parentIndex.guid);
      if (typeof n.parentIndex.position !== 'string') throw new Error('Invalid sibling position');
      const p = this.slot(parent, true)!, edge = Buffer.alloc(EDGE_BYTES);
      edge.writeDoubleLE(n.guid.sessionID); edge.writeDoubleLE(n.guid.localID, 8); edge.writeUInt32LE(p.buffer.readUInt32LE(36), 16);
      write(this.edges, edge, this.edgeCount++ * EDGE_BYTES);
      p.buffer.writeUInt32LE(this.edgeCount, 36); p.buffer.writeUInt32LE(p.buffer.readUInt32LE(40) + 1, 40);
      write(this.table, p.buffer, p.offset);
    }
  }
  /** Mutations are private until worker acknowledgement. A failure poisons this disposable index. */
  applyLive(changes: Record<string, any>[]) {
    if (this.poisoned || !this.ended || !this.selectionId) throw new Error('Live index is unavailable');
    try {
      if (!changes.length || changes.length > LIVE_LIMITS.changes || this.applied >= LIVE_LIMITS.batches) throw new Error('Live batch limit exceeded');
      this.selected.clear(); this.selectedBytes = 0;
      const ids = new Set<string>();
      for (const change of changes) {
        validateLiveChange(change);
        const id = safeId(change.guid);
        if (ids.has(id)) throw new Error('Repeated GUID in live batch');
        ids.add(id);
        const slot = this.slot(id);
        const old = slot?.buffer.readUInt32LE(32) ? this.node(id, false) : undefined;
        if (change.phase === 'CREATED' ? !!old || !!slot : !old) throw new Error('Ambiguous live creation/update/removal');
        if (old) assertLiveType(old);
        if (change.phase === 'CREATED') {
          if (!change.type || !change.parentIndex) throw new Error('Incomplete live creation');
          assertLiveType(change);
        } else if (change.type !== undefined && change.type !== old.type) throw new Error('Live type change unsupported');
        if (change.phase === 'REMOVED') {
          if (id === this.selectionId || this.children(id, false).length) throw new Error('Removing selection root or non-leaf requires recapture');
          slot!.buffer.writeUInt32LE(0, 32); write(this.table, slot!.buffer, slot!.offset);
          this.count--; continue;
        }
        const merged = { ...old, ...change, phase: 'CREATED' };
        // Every changed node must have a complete, acyclic ancestry in the disk index.
        let parent = merged.parentIndex?.guid;
        const ancestors = new Set<string>([id]);
        while (parent) {
          const parentId = safeId(parent);
          if (ancestors.has(parentId) || ancestors.size > 64) throw new Error('Live parent cycle/depth limit');
          ancestors.add(parentId);
          const p = this.node(parentId, false);
          if (!['FRAME', 'GROUP', 'CANVAS', 'DOCUMENT'].includes(p.type)) throw new Error('Unsupported live parent dependency');
          parent = p.parentIndex?.guid;
        }
        if (change.phase === 'CREATED' && ++this.count > DISK_LIMITS.nodes) throw new Error('Live node limit exceeded');
        const target = slot ?? this.slot(id, true)!;
        const data = Buffer.from(JSON.stringify(merged));
        if (data.length > DISK_LIMITS.nodeBytes || this.bytes + data.length > DISK_LIMITS.totalBytes) throw new Error('Live disk size limit exceeded');
        write(this.log, data, this.bytes);
        target.buffer.writeDoubleLE(this.bytes, 24); target.buffer.writeUInt32LE(data.length, 32);
        write(this.table, target.buffer, target.offset); this.bytes += data.length;
        const previousParent = old?.parentIndex ? safeId(old.parentIndex.guid) : undefined;
        const newParent = merged.parentIndex ? safeId(merged.parentIndex.guid) : undefined;
        if (newParent && previousParent !== newParent) {
          const p = this.slot(newParent)!;
          if (p.buffer.readUInt32LE(40) >= DISK_LIMITS.siblings) throw new Error('Live sibling edge limit exceeded');
          const edge = Buffer.alloc(EDGE_BYTES);
          edge.writeDoubleLE(change.guid.sessionID); edge.writeDoubleLE(change.guid.localID, 8); edge.writeUInt32LE(p.buffer.readUInt32LE(36), 16);
          write(this.edges, edge, this.edgeCount++ * EDGE_BYTES);
          p.buffer.writeUInt32LE(this.edgeCount, 36); p.buffer.writeUInt32LE(p.buffer.readUInt32LE(40) + 1, 40);
          write(this.table, p.buffer, p.offset);
        }
      }
      this.applied++;
    } catch (error) { this.poisoned = true; throw error; }
  }
  acceptMessage(message: Record<string, any>) {
    if (message.type !== 'NODE_CHANGES' && this.batchNodes) throw new Error('Nodes outside initial node batch');
    if (message.type === 'JOIN_START') {
      if (this.started) throw new Error('Repeated JOIN_START');
      this.started = true;
    } else if (message.type === 'JOIN_END') {
      if (!this.started || this.ended) throw new Error('Invalid JOIN_END');
      this.ended = true;
    } else if (message.type === 'NODE_CHANGES') {
      if (!this.started || !this.batchNodes) throw new Error('Missing node changes');
      if (this.ended) this.live++; else this.batches++;
    } else if (!message.type) throw new Error('Invalid message type');
    this.batchNodes = 0;
  }
  finish() { if (!this.ended || !this.count) throw new Error('Incomplete initial load: JOIN_END or nodes missing. Recapture after loading finishes.'); }
  private node(id: string, cache = true) {
    const cached = this.selected.get(id);
    if (cached !== undefined) return JSON.parse(cached);
    const slot = this.slot(id), length = slot?.buffer.readUInt32LE(32);
    if (!slot || !length) throw new Error('Selected node not present in capture');
    const value = read(this.log, length, slot.buffer.readDoubleLE(24)).toString('utf8');
    const charge = 2 * (value.length + id.length) + 128;
    if (cache && this.selectionId && this.selected.size < SELECTION_LIMITS.nodes && this.selectedBytes + charge <= SELECTION_LIMITS.bytes) {
      this.selected.set(id, value); this.selectedBytes += charge;
    }
    return JSON.parse(value);
  }
  private children(id: string, cache = true, dependency?: (id:string)=>Record<string,any> | undefined): string[] {
    const slot = this.slot(id);
    if (!slot) return [];
    if (slot.buffer.readUInt32LE(40) > DISK_LIMITS.siblings) throw new Error('Sibling count limit exceeded; select a smaller branch');
    const list: { id: string; position: string }[] = [];
    const unique = new Set<string>();
    let next = slot.buffer.readUInt32LE(36), bytes = 0;
    while (next) {
      const edge = read(this.edges, EDGE_BYTES, (next - 1) * EDGE_BYTES);
      const child = `${edge.readDoubleLE(0)}:${edge.readDoubleLE(8)}`;
      next = edge.readUInt32LE(16);
      if (!this.slot(child)?.buffer.readUInt32LE(32) || unique.has(child)) continue;
      const node = dependency ? dependency(child)! : this.node(child, false);
      if (!node.parentIndex || safeId(node.parentIndex.guid) !== id) continue;
      const position = node.parentIndex.position;
      bytes += Buffer.byteLength(position) + child.length;
      if (bytes > DISK_LIMITS.siblingBytes) throw new Error('Sibling ordering size limit exceeded');
      unique.add(child); list.push({ id: child, position });
    }
    list.sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : a.id.localeCompare(b.id));
    return list.map(n => n.id);
  }
  query(params: NetworkQuery) {
    if (this.poisoned) throw new Error('STALE: live index failed; recapture');
    const { fileKey, nodeId } = parseNetworkSelection(params.url);
    if (fileKey !== this.fileKey) throw new Error('Selection file does not match capture');
    if (!Number.isInteger(params.depth) || params.depth < 0 || params.depth > 50 || !Number.isInteger(params.maxNodes) || params.maxNodes < 1 || params.maxNodes > 500 || !Number.isSafeInteger(params.offset) || params.offset < 0) throw new Error('Invalid traversal limits');
    if (this.selectionId !== nodeId) { this.selected.clear(); this.selectedBytes = 0; this.selectionId = nodeId; }
    const nodeBudget = responseBudget(params) - 3072;
    let dependencyReads=0,dependencyBytes=0,unresolvedCount=0;
    const dependency = (id:string) => {
      const length=this.slot(id)?.buffer.readUInt32LE(32);
      if (++dependencyReads>COMPONENT_LIMITS.reads || (dependencyBytes+=length ?? 0)>COMPONENT_LIMITS.bytes)
        throw new Error('Component dependency read budget exceeded');
      return length ? this.node(id,false) : undefined;
    };
    let variableReads=0,variableBytes=0;
    const variableReader={defaultModeAllowed:true,asset:(type:string,ref:Record<string,any>)=>this.variableAssets.get(type,ref),node:(id:string)=>{
      const length=this.slot(id)?.buffer.readUInt32LE(32);
      if(++variableReads>20000||(variableBytes+=length??0)>64*1024*1024)throw new Error('Variable dependency read budget exceeded');
      return length?this.node(id,false):undefined;
    }};
    this.node(nodeId);
    const ancestors: {id:string;node:Record<string,any>}[] = [];
    let ancestor = this.node(nodeId).parentIndex?.guid;
    const ancestorIds = new Set<string>([nodeId]);
    while (ancestor) {
      const id = safeId(ancestor);
      if (ancestorIds.has(id) || ancestors.length >= 64) throw new Error('Cycle in ancestors or depth limit exceeded');
      ancestorIds.add(id);
      if (!this.slot(id)?.buffer.readUInt32LE(32)) { variableReader.defaultModeAllowed=false; break; }
      const node = this.node(id,false); ancestors.push({id,node:{type:node.type,resizeToFit:node.resizeToFit,transform:node.transform,variableModeBySetMap:node.variableModeBySetMap}});
      if (node.type === 'CANVAS') break;
      ancestor = node.parentIndex?.guid;
    }
    let rootGeometry: GeometryContext | undefined;
    let rootModes:ModeContext=new Map();
    for (const a of ancestors.reverse()) { rootGeometry = geometryContext(a.node,a.id,rootGeometry); rootModes=inheritVariableModes(rootModes,a.node,a.id); }
    const stack: {modes:ModeContext;geometry?:GeometryContext;id:string; sourceId:string; depth:number; parent?:Record<string,any>; parentId?:string; context?:InstanceContext}[] = [{ id: nodeId, sourceId:nodeId, depth: 0, geometry:rootGeometry,modes:rootModes }];
    const seen = new Set<string>(), pending: string[] = [], skipped: string[] = [], nodes: any[] = [];
    let eligible = 0, bytes = 0, pendingCount = 0, skippedCount = 0, outputFull = false;
    while (stack.length) {
      const item = stack.pop()!;
      if (seen.has(item.id)) throw new Error('Cycle in selected tree');
      seen.add(item.id);
      let n = instanceNode(item.context ? dependency(item.sourceId)! : this.node(item.sourceId), item.context);
      if (seen.size > DISK_LIMITS.nodes) throw new Error('Rendered selection node limit exceeded');
      let childSource = item.sourceId, childContext = item.context, skipChildren = false;
      if (n.type === 'INSTANCE') {
        const resolved = enterInstance(n, item.id, dependency, item.context);
        if ('error' in resolved) { n = {...n,instanceUnresolved:true,instanceError:resolved.error,component:{status:'unresolved',reason:resolved.error,complete:false}}; skipChildren=true; }
        else { n=resolved.effective; childSource=resolved.masterId; childContext=resolved.context; }
      }
      const modes=inheritVariableModes(item.modes,n,item.id);
      const bindings=nativeVariableBindings(n,data=>resolveNativeVariable(data,modes,variableReader));
      n=effectiveVariableNode(n,bindings);
      const geometry = geometryContext(n,item.id,item.geometry);
      if (!params.includeHidden && n.visible === false) { skippedCount++; if (skipped.length < 10) skipped.push(item.id); continue; }
      if(n.instanceUnresolved) unresolvedCount++;
      if (eligible++ >= params.offset && nodes.length < params.maxNodes && !outputFull) {
        const { guid, parentIndex, phase, symbolData, derivedSymbolData, componentPropAssignments, componentPropRefs, componentPropDefs, overrideKey, guidPath, ...properties } = n;
        const parentId = item.parentId ?? (parentIndex ? safeId(parentIndex.guid) : null);
        const parentSlot = !item.parent && parentId ? this.slot(parentId) : undefined;
        const parent = item.parent ?? (parentSlot?.buffer.readUInt32LE(32) ? this.node(parentId!, false) : undefined);
        let entry: Record<string, any> = { style: networkStyle(n,undefined,bindings), layout: networkLayout(n, parent, this.layoutSchemaHash, geometry), id: item.id, parentId, ...(item.context ? {sourceNodeId:item.sourceId} : {}), depth: item.depth, ...properties };
        if (params.format !== 'debug') entry = designContextNode(entry);
        if (Buffer.byteLength(JSON.stringify(entry)) > Math.min(120000, nodeBudget - 1)) entry = { id: item.id, parentId: entry.parentId, depth: item.depth,
          name: typeof n.name === 'string' ? n.name.slice(0, 100) : undefined, type: typeof n.type === 'string' ? n.type.slice(0, 100) : undefined, propertiesOmitted: 'Node exceeds output limit' };
        if (Buffer.byteLength(JSON.stringify(entry)) + 1 > nodeBudget) entry = { id: item.id, parentId: entry.parentId, depth: item.depth, propertiesOmitted: 'Node exceeds output limit' };
        const length = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + length + 1 > nodeBudget) outputFull = true;
        else { nodes.push(entry); bytes += length + 1; }
      }
      if (skipChildren) continue;
      if (item.depth >= params.depth) {
        if (this.applied ? this.children(childSource, !childContext, childContext ? dependency : undefined).length : this.slot(childSource)?.buffer.readUInt32LE(40)) { pendingCount++; if (pending.length < 10) pending.push(item.id); }
      } else {
        const children = this.children(childSource, !childContext, childContext ? dependency : undefined);
        if (!['HORIZONTAL','VERTICAL','GRID'].includes(n.stackMode) && ['GROUP','BOOLEAN_OPERATION','VECTOR','FRAME','SYMBOL','INSTANCE'].includes(n.type)) children.reverse();
        for (let i = children.length - 1; i >= 0; i--) stack.push({ id: childContext ? `${childContext.prefix};${children[i]}` : children[i], sourceId:children[i],
          depth: item.depth + 1, parent:n, parentId:item.id, context:childContext, geometry,modes });
      }
    }
    const next = params.offset + nodes.length;
    return { adapter: 'figma-network-snapshot', live: this.applied > 0, appliedLiveBatches: this.applied, fileKey, rootId: nodeId, documentRecords: this.count,
      initialBatches: this.batches, ignoredLiveBatches: this.live, nodes,
      traversal: { eligibleRecords: eligible, returned: nodes.length, pendingDepth: pending, skippedHidden: skipped,
        pendingDepthCount: pendingCount, skippedHiddenCount: skippedCount, diagnosticListsTruncated: pendingCount > pending.length || skippedCount > skipped.length,
        nextOffset: next < eligible ? next : null, unresolvedInstanceCount:unresolvedCount }, incomplete: true,
      nativeVariables:{source:'captured-definitions',dependencyReads:variableReads,dependencyBytes:variableBytes,complete:false},
      components:{representation:'expanded-supported-subset',complete:false,dependencyReads,dependencyBytes,limits:COMPONENT_LIMITS},
      limitations: [this.applied ? 'Bounded supported live changes applied to the retained disk index; unsupported changes require recapture.' : 'Captured initial state; freshness is checked by the managed reader.', 'Instance children use canonical instance/source paths, not browser-session generated IDs; native variable resolution reports missing definitions and unknown modes; geometry blobs and image assets are not resolved.',
        'Layers order uses wire position for Auto Layout and reverse paint order for other containers; layout parity is verified on the documented control selection.'] };
  }
}
