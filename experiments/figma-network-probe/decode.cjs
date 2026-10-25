// Local proof of concept for the observed fig-wire v1 + Zstandard format.
// Usage: node decode.cjs capture.json 1:22975 output-directory
// Requires zstd on PATH and kiwi-schema (NODE_PATH can point at a local install).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kiwi = require('kiwi-schema');
const [input, rootId, output] = process.argv.slice(2);
if (!input || !rootId || !output) throw new Error('Usage: node decode.cjs capture.json 1:22975 output-directory');
const dump = JSON.parse(fs.readFileSync(input, 'utf8'));
const codecs = new Map();
const snapshots = [];
const messages = [];
const decompress = bytes => {
  if (bytes.subarray(0, 4).toString('hex') !== '28b52ffd') throw new Error('Unsupported compression');
  const r = spawnSync('zstd', ['-d', '-q', '--stdout'], { input: bytes, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr.toString());
  return r.stdout;
};
for (const e of dump.events) {
  if (e.kind !== 'ws-received' || e.opcode !== 2) continue;
  const bytes = Buffer.from(e.payload, 'base64');
  if (bytes.subarray(0, 8).toString() === 'fig-wire') {
    if (bytes.readUInt32LE(8) !== 1) throw new Error('Unsupported fig-wire version');
    const schema = kiwi.decodeBinarySchema(decompress(bytes.subarray(12)));
    codecs.set(e.key, kiwi.compileSchema(schema));
    messages.push({ kind: 'schema', definitions: schema.definitions.length });
    continue;
  }
  const codec = codecs.get(e.key);
  if (!codec) throw new Error('Binary message without captured schema');
  const message = codec.decodeMessage(decompress(bytes));
  messages.push({ kind: message.type, nodes: message.nodeChanges?.length || 0 });
  if (message.type === 'NODE_CHANGES' && message.nodeChanges?.length) snapshots.push(message.nodeChanges);
}
// This experiment does NOT merge live deltas or resolve component instances.
if (snapshots.length !== 1) throw new Error(`Expected one initial node batch; got ${snapshots.length}. Multipart/delta handling is not implemented.`);
const nodes = snapshots[0];
if (nodes.some(n => n.phase !== 'CREATED')) throw new Error('Expected initial CREATED records');
const id = guid => guid ? `${guid.sessionID}:${guid.localID}` : null;
const byId = new Map(nodes.map(n => [id(n.guid), n]));
if (byId.size !== nodes.length) throw new Error('Duplicate IDs');
if (!byId.has(rootId)) throw new Error('Selection not found');
const children = new Map();
for (const node of nodes) {
  const parent = id(node.parentIndex?.guid);
  if (!children.has(parent)) children.set(parent, []);
  children.get(parent).push(node);
}
const seen = new Set();
const selected = [];
function walk(node) {
  const nodeId = id(node.guid);
  if (seen.has(nodeId)) throw new Error('Cycle in parent links');
  seen.add(nodeId);
  const { editInfo, ...design } = node;
  selected.push({ id: nodeId, ...design });
  const ordered = (children.get(nodeId) || []).sort((a, b) => a.parentIndex.position < b.parentIndex.position ? -1 : a.parentIndex.position > b.parentIndex.position ? 1 : 0);
  return { id: nodeId, name: node.name, type: node.type, visible: node.visible, size: node.size, children: ordered.map(walk) };
}
const tree = walk(byId.get(rootId));
const report = { rootId, documentRecords: nodes.length, selectionRecords: seen.size, droppedEvents: dump.dropped, messages, limitations: ['Initial captured parent-link tree only; completeness against Figma is not proven.', 'Component instances, overrides, blob geometry and variable resolution are not expanded.', 'Sibling order uses lexical parentIndex.position; not fully verified against UI.', 'Live deltas and multipart node batches are not implemented.'] };
fs.mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries({ tree, nodes: selected, report })) fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(value, null, 2));
console.log(JSON.stringify({ rootId, documentRecords: nodes.length, selectionRecords: seen.size, droppedEvents: dump.dropped, output }, null, 2));
