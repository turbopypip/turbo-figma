import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, transitionSession, checkSelectionRead } from '../dist/network-session.js';

const snapshot = { fileKey: 'file1', sessionId: 'capture-1', generation: 1 };
const evidence = { schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts: 3,
  persistedParts: 3, droppedParts: 0, sequenceComplete: true, metadataCommitted: true };
const query = { fileKey: 'file1', nodeId: '1:2', depth: 12, maxNodes: 100, maxBytes: 150000, includeHidden: false };
const capturing = createCapture(snapshot);
const ready = transitionSession(capturing, { type: 'complete', snapshot, evidence });
const token = { version: 1, snapshot, selection: query, nextOffset: 100 };
const states = { capturing, ready,
  stale: transitionSession(ready, { type: 'invalidate', snapshot, reason: 'Document changed' }),
  error: transitionSession(capturing, { type: 'fail', snapshot, reason: 'Disk full' }) };

test('session transition table rejects terminal transitions and repeated completion', () => {
  for (const [status, state] of Object.entries(states)) {
    for (const type of ['complete', 'invalidate', 'fail']) {
      const event = { type, snapshot, evidence, reason: 'Disconnected' };
      const allowed = status === 'capturing' || (status === 'ready' && type !== 'complete');
      if (allowed) assert.equal(transitionSession(state, event).status,
        type === 'complete' ? 'ready' : type === 'fail' ? 'error' : 'stale');
      else assert.throws(() => transitionSession(state, event));
      assert.equal(state.status, status);
    }
  }
});
test('ready requires complete, lossless, persisted initial snapshot', () => {
  for (const change of [
    { schemaReceived: false }, { joinStarted: false }, { joinEnded: false }, { sequenceComplete: false },
    { metadataCommitted: false }, { receivedParts: 0, persistedParts: 0 }, { receivedParts: 1.5 },
    { receivedParts: NaN }, { receivedParts: Infinity }, { persistedParts: 2 }, { droppedParts: 1 },
  ]) assert.throws(() => transitionSession(capturing, { type: 'complete', snapshot, evidence: { ...evidence, ...change } }), /Incomplete/);
  assert.equal(capturing.status, 'capturing');
});
test('identities are validated and isolated from caller mutation', () => {
  for (const change of [{ fileKey: '../file' }, { sessionId: '' }, { sessionId: '../session' }, { generation: 0 }, { generation: 1.5 }]) {
    assert.throws(() => createCapture({ ...snapshot, ...change }), /identity/);
  }
  const input = { ...snapshot };
  const state = createCapture(input);
  input.generation = 2;
  assert.equal(state.snapshot.generation, 1);
  assert.throws(() => { state.snapshot.generation = 3; }, TypeError);
  for (const change of [{ fileKey: 'other' }, { sessionId: 'other' }, { generation: 2 }]) {
    for (const type of ['complete', 'invalidate', 'fail']) {
      assert.throws(() => transitionSession(state, { type, snapshot: { ...snapshot, ...change }, evidence, reason: 'Lost' }), /another snapshot/);
    }
  }
  assert.throws(() => transitionSession(ready, { type: 'invalidate', snapshot, reason: ' ' }), /reason/);
});
test('unavailable data never becomes an empty successful read', () => {
  for (const [status, code] of [['capturing', 'CAPTURING'], ['stale', 'STALE'], ['error', 'CAPTURE_ERROR']]) {
    const result = checkSelectionRead(states[status], query);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal('nodes' in result, false);
  }
  assert.equal(checkSelectionRead(ready, { ...query, fileKey: 'other' }).code, 'FILE_MISMATCH');
  assert.deepEqual(checkSelectionRead(ready, query), { ok: true, snapshot, offset: 0 });
  assert.equal(checkSelectionRead(ready, query, token).offset, 100);
  // The same read checked after an in-flight invalidation must fail.
  assert.equal(checkSelectionRead(states.stale, query, token).code, 'STALE');
});
test('continuations bind every identity and query field', () => {
  for (const change of [{ fileKey: 'other' }, { sessionId: 'other' }, { generation: 2 }]) {
    assert.equal(checkSelectionRead(ready, query, { ...token, snapshot: { ...snapshot, ...change } }).code, 'INVALID_CONTINUATION');
  }
  for (const change of [{ fileKey: 'other' }, { nodeId: '1:3' }, { depth: 1 }, { maxNodes: 50 }, { maxBytes: 100 }, { includeHidden: true }]) {
    assert.equal(checkSelectionRead(ready, query, { ...token, selection: { ...query, ...change } }).code, 'INVALID_CONTINUATION');
  }
  for (const change of [{ version: 2 }, { nextOffset: 0 }, { nextOffset: -1 }, { nextOffset: 1.5 }, { nextOffset: Infinity }]) {
    assert.equal(checkSelectionRead(ready, query, { ...token, ...change }).code, 'INVALID_CONTINUATION');
  }
  const newer = transitionSession(createCapture({ ...snapshot, generation: 2 }), {
    type: 'complete', snapshot: { ...snapshot, generation: 2 }, evidence,
  });
  assert.equal(checkSelectionRead(newer, query, token).code, 'INVALID_CONTINUATION');
  assert.equal(checkSelectionRead(newer, query, undefined, snapshot).code, 'STALE');
});
test('invalid requests are rejected before selection access', () => {
  for (const change of [{ nodeId: 'bad' }, { depth: -1 }, { depth: 51 }, { maxNodes: 0 }, { maxNodes: 501 },
    { maxBytes: 0 }, { maxBytes: 150001 }, { includeHidden: 'false' }]) {
    assert.equal(checkSelectionRead(ready, { ...query, ...change }).code, 'INVALID_REQUEST');
  }
});
