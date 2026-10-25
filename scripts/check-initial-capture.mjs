// Offline regression replay of an existing manual probe JSON; not the managed streaming path.
import { readFile } from 'node:fs/promises';
import { InitialSnapshotInspector } from '../dist/network-initial.js';
const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/check-initial-capture.mjs /absolute/path/to/existing-probe.json');
const dump = JSON.parse(await readFile(filename, 'utf8'));
if (dump.version !== 2 || dump.dropped !== 0) throw new Error('Requires a version-2 probe with zero dropped events');
const inspector = new InitialSnapshotInspector();
let events = 0, parts = 0;
for (const event of dump.events) {
  if (event.kind !== 'ws-received') continue;
  const bytes = Buffer.from(JSON.stringify({ version: 1, kind: event.kind, session: event.key,
    requestId: 'replay', eventSequence: events++, opcode: event.opcode, payload: event.payload }) + '\n');
  for (let offset = 0; offset < bytes.length; offset += 262144) { inspector.push(bytes.subarray(offset, offset + 262144)); parts++; }
  if (inspector.progress.initialComplete) break;
}
inspector.evidence(parts);
console.log(JSON.stringify({ initialComplete: true, events, parts, dropped: dump.dropped }));
