import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSchema, encodeBinarySchema, compileSchema } from 'kiwi-schema';
import { NetworkSnapshot, inflateFrame } from '../dist/network.js';
import { readNetworkSnapshot } from '../dist/network-reader.js';

const guid = n => ({ sessionID: 1, localID: n });
const node = (n, parent, position = '!', extra = {}) => ({ guid: guid(n), phase: 'CREATED', type: 'FRAME', name: `node ${n}`,
  ...(parent ? { parentIndex: { guid: guid(parent), position } } : {}), ...extra });
const url = 'https://www.figma.com/design/test/File?node-id=1-1';
const query = { url, depth: 12, maxNodes: 200, offset: 0, includeHidden: false };
function makeModel(nodes) {
  const m = new NetworkSnapshot('test');
  m.apply({ type: 'JOIN_START' });
  m.apply({ type: 'NODE_CHANGES', nodeChanges: nodes });
  m.apply({ type: 'JOIN_END' }); m.finish(); return m;
}
test('ordered tree, hidden subtree filtering, depth and stable pagination', () => {
  const m = makeModel([node(1), node(2, 1, 'b'), node(3, 1, 'a'), node(4, 3), node(5, 1, 'c', { visible: false }), node(6, 5)]);
  assert.deepEqual(m.query(query).nodes.map(n => n.id), ['1:1', '1:3', '1:4', '1:2']);
  assert.deepEqual(m.query(query).traversal.skippedHidden, ['1:5']);
  const first = m.query({ ...query, maxNodes: 2 });
  assert.equal(first.traversal.nextOffset, 2);
  assert.deepEqual(m.query({ ...query, offset: 2 }).nodes.map(n => n.id), ['1:4', '1:2']);
  assert.deepEqual(m.query({ ...query, depth: 0 }).traversal.pendingDepth, ['1:1']);
  assert.equal(m.query({ ...query, includeHidden: true }).nodes.length, 6);
  assert.throws(() => m.query({ ...query, url: url.replace('/test/', '/other/') }), /does not match/);
});
test('initial multipart batches allowed; duplicates, incomplete loads and cycles rejected', () => {
  const m = new NetworkSnapshot('test');
  m.apply({ type: 'JOIN_START' }); m.apply({ type: 'NODE_CHANGES', nodeChanges: [node(1)] });
  assert.throws(() => m.finish(), /Incomplete/);
  m.apply({ type: 'NODE_CHANGES', nodeChanges: [node(2, 1)] }); m.apply({ type: 'JOIN_END' });
  m.apply({ type: 'NODE_CHANGES', nodeChanges: [node(3, 1)] }); m.finish();
  assert.equal(m.query(query).nodes.length, 2);
  assert.equal(m.query(query).initialBatches, 2);
  assert.equal(m.query(query).ignoredLiveBatches, 1);
  assert.throws(() => makeModel([node(1), node(1)]), /Duplicate/);
  assert.throws(() => makeModel([node(1, 2), node(2, 1)]).query(query), /Cycle/);
});
test('oversized node does not stall pagination or leak unbounded properties', () => {
  const m = makeModel([node(1, null, '!', { name: 'x'.repeat(160000) }), node(2, 1)]);
  const r = m.query({ ...query, maxNodes: 1 });
  assert.match(r.nodes[0].propertiesOmitted, /output limit/);
  assert.equal(r.nodes[0].name.length, 1000);
  assert.equal(r.traversal.nextOffset, 1);
  assert.equal(m.query({ ...query, offset: 1 }).nodes[0].id, '1:2');
});

// A real Zstandard frame containing raw blocks: no external compressor in tests.
function zstd(bytes) {
  const prefix = Buffer.alloc(9); prefix.writeUInt32LE(0xfd2fb528); prefix[4] = 0xa0; prefix.writeUInt32LE(bytes.length, 5);
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += 131072) {
    const chunk = bytes.subarray(offset, offset + 131072), header = Buffer.alloc(3);
    header.writeUIntLE((chunk.length << 3) | (offset + chunk.length === bytes.length ? 1 : 0), 0, 3);
    blocks.push(header, chunk);
  }
  return Buffer.concat([prefix, ...blocks]);
}
const schema = parseSchema(`
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
enum NodePhase { CREATED = 0; }
enum NodeType { FRAME = 0; INSTANCE = 1; }
struct Guid { uint sessionID; uint localID; }
struct Parent { Guid guid; string position; }
message NodeChange { Guid guid = 1; NodePhase phase = 2; Parent parentIndex = 3; NodeType type = 4; string name = 5; string editInfo = 6; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
`);
const codec = compileSchema(schema);
function capture() {
  const header = Buffer.alloc(12); header.write('fig-wire'); header.writeUInt32LE(1, 8);
  const event = b => ({ kind: 'ws-received', key: 'main:1', opcode: 2, payload: b.toString('base64') });
  return { version: 2, fileUrl: 'https://www.figma.com/design/test/File', dropped: 0, startedAt: '2026-10-25T00:00:00Z', events: [
    { kind: 'ws-open', key: 'main:1', url: 'wss://www.figma.com/api/multiplayer/test' },
    event(Buffer.concat([header, zstd(encodeBinarySchema(schema))])),
    ...[{ type: 'JOIN_START' }, { type: 'NODE_CHANGES', nodeChanges: [node(1, null, '!', { editInfo: 'private user metadata' }), node(2, 1, '!', { type: 'INSTANCE' })] }, { type: 'JOIN_END' }].map(m => event(zstd(codec.encodeMessage(m))))
  ] };
}
test('bounded decompression rejects truncation, extra frames and oversized allocation', () => {
  const frame = zstd(Buffer.from('test'));
  assert.equal(Buffer.from(inflateFrame(frame)).toString(), 'test');
  assert.throws(() => inflateFrame(frame.subarray(0, -1)), /Truncated/);
  assert.throws(() => inflateFrame(Buffer.concat([frame, frame])), /Trailing/);
  const oversized = Buffer.from(frame); oversized.writeUInt32LE(256 * 1024 * 1024, 5);
  assert.throws(() => inflateFrame(oversized), /128 MiB/);
  const understated = Buffer.from(frame); understated.writeUInt32LE(2, 5);
  assert.throws(() => inflateFrame(understated), /size mismatch/);
  const overstated = Buffer.from(frame); overstated.writeUInt32LE(8, 5);
  assert.throws(() => inflateFrame(overstated), /size mismatch/);
});
test('real worker decodes wire schema/messages, strips metadata and discloses dropped events', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'figma-wire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const captureFile = join(dir, 'capture.json'), dump = capture(); dump.dropped = 2;
  await writeFile(captureFile, JSON.stringify(dump));
  const result = await readNetworkSnapshot({ ...query, captureFile });
  assert.equal(result.nodes.length, 2); assert.equal(result.live, false);
  assert.equal(result.nodes[1].instanceUnresolved, true);
  assert.equal(JSON.stringify(result).includes('private user'), false);
  assert.match(result.captureWarnings[0], /2 capture events/);
  await assert.rejects(readNetworkSnapshot({ ...query, url: url.replace('/test/', '/other/'), captureFile }), /does not match/);
  dump.events.pop(); await writeFile(captureFile, JSON.stringify(dump));
  await assert.rejects(readNetworkSnapshot({ ...query, captureFile }), /Incomplete/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readNetworkSnapshot({ ...query, captureFile }, abort.signal), /cancelled/);
});
