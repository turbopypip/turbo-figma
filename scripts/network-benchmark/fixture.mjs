import { parseSchema, encodeBinarySchema, compileSchema } from 'kiwi-schema';
// Public synthetic design for harness smoke tests, not a performance acceptance fixture.
export function syntheticCapture() {
  const schema = parseSchema(`
    enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
    enum Phase { CREATED = 0; }
    struct Guid { uint sessionID; uint localID; }
    message NodeChange { Guid guid = 1; Phase phase = 2; string name = 3; }
    message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
  `);
  const codec = compileSchema(schema);
  function zstd(data) {
    const prefix = Buffer.alloc(9); prefix.writeUInt32LE(0xfd2fb528); prefix[4] = 0xa0; prefix.writeUInt32LE(data.length, 5);
    const header = Buffer.alloc(3); header.writeUIntLE((data.length << 3) | 1, 0, 3);
    return Buffer.concat([prefix, header, data]);
  }
  const header = Buffer.alloc(12); header.write('fig-wire'); header.writeUInt32LE(1, 8);
  const payloads = [Buffer.concat([header, zstd(encodeBinarySchema(schema))]),
    ...[{ type: 'JOIN_START' }, { type: 'NODE_CHANGES', nodeChanges: [{ guid: { sessionID: 1, localID: 1 }, phase: 'CREATED', name: 'Synthetic' }] },
      { type: 'JOIN_END' }].map(m => zstd(codec.encodeMessage(m)))];
  return { version: 2, fileUrl: 'https://www.figma.com/design/benchmark/File', dropped: 0,
    events: [{ kind: 'ws-open', key: 'main:1', url: 'wss://www.figma.com/api/multiplayer/benchmark' },
      ...payloads.map(p => ({ kind: 'ws-received', key: 'main:1', opcode: 2, payload: p.toString('base64') }))] };
}
