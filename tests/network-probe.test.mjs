import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('probe captures only incoming multiplayer for chosen file, persists stop and clears', async () => {
  let onEvent, onMessage, stored = {}, reloaded = false;
  const calls = [];
  const chrome = {
    runtime: { id: 'probe', getURL: p => `chrome-extension://probe/${p}`, onMessage: { addListener: f => { onMessage = f; } } },
    debugger: { onEvent: { addListener: f => { onEvent = f; } }, onDetach: { addListener() {} },
      async attach() {}, async detach() {}, async sendCommand(source, method) { calls.push(method); } },
    tabs: { async query() { return [{ id: 7, url: 'https://www.figma.com/design/test/File?node-id=1-1&token=private' }]; }, async reload() { reloaded = true; } },
    storage: { local: { async get() { return stored; }, async set(value) { stored = structuredClone(value); }, async remove(key) { delete stored[key]; } } }
  };
  vm.runInNewContext(await readFile(new URL('../experiments/figma-network-probe/background.js', import.meta.url), 'utf8'), { chrome, URL, TextEncoder, Date, Promise, Map, Set });
  const call = action => new Promise(resolve => onMessage({ action }, { id: 'probe', url: 'chrome-extension://probe/popup.html' }, resolve));
  assert.equal(onMessage({ action: 'start' }, { id: 'other' }, () => {}), false);
  assert.equal((await call('start')).ok, true); assert.equal(reloaded, true);
  const emit = (method, p, tabId = 7) => onEvent({ tabId }, method, p);
  emit('Network.webSocketCreated', { requestId: 'noise', url: 'wss://www.figma.com/api/livegraph' });
  emit('Network.webSocketCreated', { requestId: 'other', url: 'wss://www.figma.com/api/multiplayer/other' });
  emit('Network.webSocketCreated', { requestId: 'target', url: 'wss://www.figma.com/api/multiplayer/test?token=private' });
  for (const requestId of ['noise', 'other', 'target']) emit('Network.webSocketFrameReceived', { requestId, response: { opcode: 2, payloadData: 'YWJj' } });
  emit('Network.webSocketFrameSent', { requestId: 'target', response: { opcode: 2, payloadData: 'outgoing' } });
  emit('Network.webSocketFrameReceived', { requestId: 'target', response: { opcode: 2, payloadData: 'wrong-tab' } }, 8);
  emit('Network.responseReceived', { requestId: 'http', type: 'Fetch', response: { url: 'https://static.figma.com/font/test' } });
  assert.equal((await call('export')).ok, false);
  assert.equal((await call('stop')).ok, true);
  const dump = (await call('export')).data;
  assert.deepEqual(Array.from(dump.events, e => e.kind), ['ws-open', 'ws-received']);
  assert.equal(JSON.stringify(dump).includes('private'), false);
  assert.equal(dump.version, 2); assert.equal(stored.capture.events.length, 2);
  assert.equal(calls.includes('Network.getResponseBody'), false);
  assert.equal((await call('clear')).ok, true); assert.equal(stored.capture, undefined);
  assert.equal((await call('export')).ok, false);
});
