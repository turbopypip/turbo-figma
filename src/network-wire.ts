import { keepStyleField } from './network-style.js';
import { ByteBuffer, type Definition, type Field } from 'kiwi-schema';

export const WIRE_LIMITS = { schemaBytes: 2 * 1024 * 1024, frameBytes: 64 * 1024 * 1024,
  definitions: 2000, fields: 20000, array: 200000, retainedArray: 10000, stringBytes: 1024 * 1024,
  retainedNodeBytes: 2 * 1024 * 1024, depth: 64, operations: 32000000, nodeOperations: 100000 } as const;

/** Bounded reads also apply to schema parsing, before any code generation/allocation. */
class Reader extends ByteBuffer {
  get position(): number { return (this as any)._index; }
  get data(): Uint8Array { return (this as any)._data; }
  skip(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || this.position + n > this.length) throw new Error('Truncated wire data');
    (this as any)._index += n;
  }
  override readVarUint() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const b = this.readByte();
      if (shift === 28 && b > 15) throw new Error('Invalid wire varint');
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
    }
    throw new Error('Invalid wire varint');
  }
  string(keep: boolean, limit = WIRE_LIMITS.stringBytes): string | undefined {
    const start = this.position;
    let end = start;
    while (end < this.length && this.data[end]) end++;
    if (end === this.length) throw new Error('Unterminated wire string');
    if (end - start > limit) throw new Error('Wire string size limit exceeded');
    const value = keep ? new TextDecoder('utf-8', { fatal: true }).decode(this.data.subarray(start, end)) : undefined;
    this.skip(end - start + 1);
    return value;
  }
}
const primitive = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const kinds = ['ENUM', 'STRUCT', 'MESSAGE'] as const;
const validName = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !['__proto__', 'constructor', 'prototype', 'ByteBuffer'].includes(s);

function schemaFrom(bytes: Uint8Array): Map<string, Definition> {
  if (bytes.length > WIRE_LIMITS.schemaBytes) throw new Error('Wire schema size limit exceeded');
  const r = new Reader(bytes), count = r.readVarUint(), definitions: Definition[] = [];
  if (count > WIRE_LIMITS.definitions) throw new Error('Wire definition limit exceeded');
  let total = 0;
  for (let i = 0; i < count; i++) {
    const name = r.string(true, 256)!, kind = kinds[r.readByte()], fields: Field[] = [], n = r.readVarUint();
    if (!validName(name) || !kind || definitions.some(d => d.name === name) || (total += n) > WIRE_LIMITS.fields) throw new Error('Invalid wire schema or field limit');
    const names = new Set<string>(), tags = new Set<number>();
    for (let j = 0; j < n; j++) {
      const field = r.string(true, 256)!, type = r.readVarInt(), flags = r.readByte(), value = r.readVarUint();
      if (!validName(field) || names.has(field) || tags.has(value) || flags > 1 || (kind === 'MESSAGE' && value === 0)) throw new Error('Invalid wire schema field');
      names.add(field); tags.add(value);
      fields.push({ name: field, type: kind === 'ENUM' ? null : String(type), isArray: !!flags, value, isDeprecated: false, line: 0, column: 0 });
    }
    definitions.push({ name, kind, fields, line: 0, column: 0 });
  }
  if (r.position !== r.length) throw new Error('Trailing wire schema bytes');
  for (const d of definitions) for (const f of d.fields) {
    if (f.type === null) continue;
    const id = Number(f.type), type = id < 0 ? primitive[~id] : definitions[id]?.name;
    if (!type) throw new Error('Invalid wire schema type');
    f.type = type;
  }
  return new Map(definitions.map(d => [d.name, d]));
}

/** Interpreted decoder: skipped fields allocate nothing; top-level nodes are visited individually. */
export class BoundedWireDecoder {
  private definitions: Map<string, Definition>;
  private tags = new Map<string, Map<number, Field>>();
  constructor(bytes: Uint8Array, private fields: ReadonlySet<string>) {
    this.definitions = schemaFrom(bytes);
    for (const d of this.definitions.values()) this.tags.set(d.name, new Map(d.fields.map(f => [f.value, f])));
    const message = this.definitions.get('Message'), node = this.definitions.get('NodeChange');
    const changes = message?.fields.find(f => f.name === 'nodeChanges');
    if (message?.kind !== 'MESSAGE' || node?.kind !== 'MESSAGE' || changes?.type !== 'NodeChange' || !changes.isArray) throw new Error('Required wire definitions missing');
  }
  decode(bytes: Uint8Array, visit: (node: Record<string, any>) => void): Record<string, any> {
    if (bytes.length > WIRE_LIMITS.frameBytes) throw new Error('Wire frame size limit exceeded');
    const r = new Reader(bytes);
    let operations = 0, nodeStart = 0, retainedBytes = 0, insideNode = false;
    const tick = () => {
      if (++operations > WIRE_LIMITS.operations) throw new Error('Wire message operation limit exceeded');
      if (insideNode && operations - nodeStart > WIRE_LIMITS.nodeOperations) throw new Error('Wire node operation limit exceeded');
    };
    const read = (type: string, keep: boolean, depth: number): any => {
      tick();
      if (insideNode && keep && (retainedBytes += 32) > WIRE_LIMITS.retainedNodeBytes) throw new Error('Wire node allocation limit exceeded');
      if (depth > WIRE_LIMITS.depth) throw new Error('Wire nesting limit exceeded');
      switch (type) {
        case 'bool': return !!r.readByte();
        case 'byte': return r.readByte();
        case 'uint': return r.readVarUint();
        case 'int': return r.readVarInt();
        case 'float': return r.readVarFloat();
        case 'string': {
          const start = r.position;
          const limit = insideNode && keep ? Math.min(WIRE_LIMITS.stringBytes, Math.floor((WIRE_LIMITS.retainedNodeBytes - retainedBytes) / 2)) : WIRE_LIMITS.stringBytes;
          const value = r.string(keep, limit);
          if (insideNode && keep) retainedBytes += (r.position - start) * 2;
          return value;
        }
        case 'uint64': return keep ? r.readVarUint64().toString() : void r.readVarUint64();
        case 'int64': return keep ? r.readVarInt64().toString() : void r.readVarInt64();
      }
      const d = this.definitions.get(type)!;
      if (d.kind === 'ENUM') {
        const value = this.tags.get(type)!.get(r.readVarUint())?.name;
        if (value === undefined) throw new Error('Unknown wire enum value');
        return keep ? value : undefined;
      }
      const result: Record<string, any> | undefined = keep ? {} : undefined;
      const seen = new Set<number>();
      const field = (f: Field) => {
        tick();
        const streamNodes = depth === 0 && type === 'Message' && f.name === 'nodeChanges';
        const retain = keep && (type === 'Message' ? f.name === 'type' : type === 'NodeChange' ? this.fields.has(f.name) : keepStyleField(type, f.name));
        if (!f.isArray) {
          const v = read(f.type!, retain, depth + 1);
          if (retain) result![f.name] = v;
          return;
        }
        const n = r.readVarUint();
        if (n > (f.type === 'byte' ? WIRE_LIMITS.frameBytes : WIRE_LIMITS.array) || (retain && n > WIRE_LIMITS.retainedArray)) throw new Error('Wire array limit exceeded');
        // Byte blobs can be skipped in constant memory, without walking every byte.
        if (f.type === 'byte') {
          const start = r.position; r.skip(n);
          if (retain) {
            if (insideNode && (retainedBytes += n * 8) > WIRE_LIMITS.retainedNodeBytes) throw new Error('Wire node allocation limit exceeded');
            result![f.name] = Array.from(r.data.subarray(start, start + n));
          }
          return;
        }
        const values: any[] | undefined = retain ? [] : undefined;
        for (let i = 0; i < n; i++) {
          if (streamNodes) { nodeStart = operations; retainedBytes = 0; insideNode = true; }
          const v = read(f.type!, retain || streamNodes, depth + 1);
          if (streamNodes) { insideNode = false; visit(v); }
          else if (retain) values!.push(v);
        }
        if (retain) result![f.name] = values;
      };
      if (d.kind === 'STRUCT') { for (const f of d.fields) field(f); }
      else for (;;) {
        const tag = r.readVarUint();
        if (!tag) break;
        if (seen.has(tag)) throw new Error('Duplicate wire field');
        seen.add(tag);
        const f = this.tags.get(type)!.get(tag);
        if (!f) throw new Error('Unknown wire field');
        field(f);
      }
      return result;
    };
    const message = read('Message', true, 0);
    if (r.position !== r.length) throw new Error('Trailing wire message bytes');
    return message;
  }
}
