// Verify actual Kilo tool events, not the model's prose. Never accepts a partial
// run as success. Usage: node scripts/check-kilo-pages.mjs EVENTS.jsonl OUTPUT_PREFIX
import fs from 'node:fs';
import assert from 'node:assert/strict';

const [input, prefix] = process.argv.slice(2);
if (!input || !prefix) throw Error('Usage: check-kilo-pages.mjs EVENTS.jsonl OUTPUT_PREFIX');
const events = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
// Kilo re-emits past tool parts when compacting history. These are not new MCP
// calls. Deduplicate only stable call identities; a real repeat has a new ID.
const seenCalls = new Map();
const calls = [];
let replayedEvents = 0;
for (const event of events) {
  if (event.type !== 'tool_use' || !['turbo-figma_get_design_context','denis-figma-mcp_get_design_context'].includes(event.part?.tool)) continue;
  const part = event.part;
  const key = part.callID ? JSON.stringify([event.sessionID ?? part.sessionID, part.callID]) : undefined;
  if (key && seenCalls.has(key)) {
    const previous = seenCalls.get(key);
    // Pruning metadata can change during compaction; actual input/result cannot.
    assert.deepEqual(part.state.input, previous.state.input, 'Replayed call changed input');
    assert.equal(part.state.output, previous.state.output, 'Replayed call changed output');
    assert.equal(part.state.status, previous.state.status, 'Replayed call changed status');
    replayedEvents++;
    continue;
  }
  if (key) seenCalls.set(key, part);
  calls.push(part);
}
const pages = [], repeats = [];
const errors = [];
let query, chain = true, repeatAtEnd = true;
for (const call of calls) {
  const state = call.state;
  if (state.status !== 'completed' || state.metadata?.truncated) {
    errors.push({status: state.status, clientTruncated: !!state.metadata?.truncated});
    continue;
  }
  let page;
  try { page = JSON.parse(state.output); } catch { errors.push({error: 'Non-JSON tool result'}); continue; }
  if (page.adapter !== 'figma-network-snapshot' || !Array.isArray(page.nodes)) {
    errors.push({error: 'Not a network page'}); continue;
  }
  const {continuation, ...options} = state.input;
  query ??= options;
  try { assert.deepEqual(options, query); } catch { chain = false; }
  if (pages.length && !continuation) {
    if (pages.at(-1).traversal.continuation !== null) repeatAtEnd = false;
    repeats.push(page);
  } else {
    if (repeats.length) repeatAtEnd = false;
    if (pages.length ? continuation !== pages.at(-1).traversal.continuation : !!continuation) chain = false;
    pages.push(page);
  }
}
const nodes = pages.flatMap(p => p.nodes);
const references = nodes.flatMap(n => n.style?.nativeBindings?.references ?? []);
const snapshotKeys = new Set(pages.concat(repeats).map(p => JSON.stringify(p.snapshot)));
const validIdentity = pages.concat(repeats).every(p => {
  if (!p.snapshot?.fileKey || !p.snapshot?.sessionId || !Number.isSafeInteger(p.snapshot.generation) ||
      !Number.isSafeInteger(p.freshness?.revision)) return false;
  try { assert.deepEqual(p.snapshot, p.freshness.snapshot); return true; } catch { return false; }
});
const summary = {
  pages: pages.length, replayedEvents, nodes: nodes.length, unique: new Set(nodes.map(n => n.id)).size,
  eligible: pages[0]?.traversal.eligibleRecords, chain,
  complete: pages.at(-1)?.traversal.continuation === null && pages.at(-1)?.traversal.complete === true,
  allObserved: pages.concat(repeats).every(p => p.freshness?.status === 'observed'),
  revisions: [...new Set(pages.concat(repeats).map(p => p.freshness?.revision))],
  snapshots: snapshotKeys.size, validIdentity, omitted: nodes.filter(n => n.propertiesOmitted).length,
  pendingDepth: Math.max(0, ...pages.map(p => p.traversal.pendingDepthCount)),
  unresolvedInstances: Math.max(0, ...pages.map(p => p.traversal.unresolvedInstanceCount)),
  references: references.length, unresolvedBindings: references.filter(r => r.status !== 'resolved').length,
  repeats: repeats.length, repeatAtEnd,
  repeatEqual: repeats.length > 0 && repeats.every(p => {
    try { assert.deepEqual(p.nodes, pages[0]?.nodes); return true; } catch { return false; }
  }),
  clientTruncated: calls.filter(c => c.state.metadata?.truncated).length,
  maxBytes: Math.max(0, ...calls.map(c => Buffer.byteLength(c.state.output ?? ''))),
  otherTools: events.filter(e => e.type === 'tool_use' && !['turbo-figma_','denis-figma-mcp_'].some(prefix=>e.part?.tool?.startsWith(prefix))).map(e => e.part.tool),
  agentErrors: events.filter(e => e.type === 'error').map(e => ({name: e.error?.name,
    statusCode: e.error?.data?.statusCode, message: e.error?.data?.message})),
  errors,
};
summary.passed = !!(summary.pages && summary.chain && summary.complete && summary.allObserved &&
  summary.snapshots === 1 && summary.validIdentity && summary.revisions.length === 1 &&
  summary.unique === summary.eligible && summary.nodes === summary.unique &&
  !summary.omitted && !summary.pendingDepth && !summary.unresolvedInstances && !summary.unresolvedBindings &&
  summary.repeatAtEnd && summary.repeatEqual && !summary.clientTruncated && !summary.otherTools.length && !summary.agentErrors.length && !errors.length);
fs.writeFileSync(prefix + '-pages.json', JSON.stringify(pages));
fs.writeFileSync(prefix + '-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (!summary.passed) process.exitCode = 1;
