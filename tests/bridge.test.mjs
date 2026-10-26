import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Bridge } from '../dist/bridge.js';
import { pair, mockBrowser } from './helpers.mjs';
const secret = 'a'.repeat(64);
async function bridge(t, timeout = 1000) {
  const b = new Bridge(secret, 0, timeout); await b.ready; t.after(() => b.close()); return b;
}
test('unauthenticated peer rejected; reconnect works; duplicate cannot displace browser extension', async t => {
  const b = await bridge(t);
  await assert.rejects(b.request('get_selection', {}), /not connected/);
  const bad = new WebSocket(`ws://127.0.0.1:${b.port}`); await once(bad, 'open');
  const rejected = once(bad, 'close'); bad.send(JSON.stringify({ type: 'auth', secret: 'wrong' }));
  assert.equal((await rejected)[0], 1008);
  const peer = await pair(b.port, secret, mockBrowser);
  const duplicate = new WebSocket(`ws://127.0.0.1:${b.port}`); await once(duplicate, 'open');
  const dupClosed = once(duplicate, 'close'); duplicate.send(JSON.stringify({ type: 'auth', secret }));
  assert.equal((await dupClosed)[0], 1008);
  assert.equal((await b.request('get_selection', {})).nodes[0].id, '1:1');
  const closed = once(peer, 'close'); peer.close(); await closed;
  await pair(b.port, secret, mockBrowser);
  assert.equal((await b.request('get_selection', {})).total, 1);
});
test('busy, abort, timeout and disconnect release pending state', async t => {
  const b = await bridge(t, 100);
  let peer = await pair(b.port, secret);
  const request = b.request('get_selection', {});
  await assert.rejects(b.request('get_selection', {}), /busy/);
  await assert.rejects(request, /timed out/);
  await once(peer, 'close');
  peer = await pair(b.port, secret);
  const controller = new AbortController();
  const aborted = b.request('get_selection', {}, controller.signal); controller.abort();
  await assert.rejects(aborted, /cancelled/); await once(peer, 'close');
  peer = await pair(b.port, secret);
  const disconnected = b.request('get_selection', {}); peer.close();
  await assert.rejects(disconnected, /disconnected/);
});
test('port collision is reported', async t => {
  const b = await bridge(t); const collision = new Bridge(secret, b.port);
  await assert.rejects(collision.ready, /EADDRINUSE/); await collision.close();
});
test('malformed and oversized messages disconnect safely', async t => {
  const b = await bridge(t);
  let peer = await pair(b.port, secret);
  let closed = once(peer, 'close'); peer.send('{invalid'); assert.equal((await closed)[0], 1008);
  // Repeated oversize/reconnect catches TCP RST racing the WebSocket close frame.
  for (let i = 0; i < 3; i++) {
    peer = await pair(b.port, secret);
    closed = once(peer, 'close'); peer.send('x'.repeat(6 * 1024 * 1024 + 1)); assert.equal((await closed)[0], 1009);
  }
  await pair(b.port, secret, mockBrowser);
  assert.equal((await b.request('get_selection', {})).total, 1);
});

test('status reflects authentication, busy work, disconnect and reconnect without browser requests', async t => {
  const b = await bridge(t);
  assert.equal(b.status.state, 'disconnected');
  const unauthenticated = new WebSocket(`ws://127.0.0.1:${b.port}`);
  await once(unauthenticated, 'open');
  assert.equal(b.status.connected, false);
  unauthenticated.close();
  let messages = 0;
  const peer = await pair(b.port, secret);
  peer.on('message', () => messages++);
  assert.equal(b.status.state, 'connected');
  assert.ok(b.status.connectedAt);
  assert.equal(messages, 0);
  const pending = b.request('get_selection', {});
  const rejected = assert.rejects(pending, /disconnected/);
  assert.equal(b.status.state, 'busy');
  assert.equal(b.status.connected, true);
  peer.close(); await rejected;
  assert.equal(b.status.state, 'disconnected');
  assert.equal(b.status.busy, false);
  assert.ok(b.status.disconnectedAt);
  await pair(b.port, secret, mockBrowser);
  assert.equal(b.status.state, 'connected');
  assert.equal(JSON.stringify(b.status).includes(secret), false);
});
test('keepalive pong does not complete or replace a pending request', async t => {
  const b = await bridge(t);
  const peer = await pair(b.port, secret);
  const incoming = once(peer, 'message');
  const pending = b.request('get_selection', {});
  const request = JSON.parse((await incoming)[0].toString());
  const pong = once(peer, 'message');
  peer.send(JSON.stringify({type:'ping'}));
  assert.deepEqual(JSON.parse((await pong)[0].toString()), {type:'pong'});
  assert.equal(b.status.busy,true);
  peer.send(JSON.stringify({type:'response',id:request.id,result:{ok:true}}));
  assert.deepEqual(await pending,{ok:true});
});
test('cache controls require authentication, are bounded to known actions and serialize against MCP reads', async t => {
  let calls = [], release;
  const b = new Bridge(secret, 0, 1000, async action => {
    calls.push(action);
    if (action === 'cache-clear') return new Promise(resolve => { release = () => resolve({ removedGenerations: 2 }); });
    return { bytes: 123 };
  });
  await b.ready; t.after(() => b.close());
  const bad = new WebSocket(`ws://127.0.0.1:${b.port}`); await once(bad, 'open');
  const closed = once(bad, 'close'); bad.send(JSON.stringify({ type: 'cache-control', id: 'x', action: 'cache-clear' }));
  assert.equal((await closed)[0], 1008); assert.deepEqual(calls, []);
  const peer = await pair(b.port, secret);
  const receive = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'cache-control', id: 'info', action: 'cache-info' }));
  assert.deepEqual(JSON.parse((await receive)[0]), { type: 'cache-result', id: 'info', result: { bytes: 123 } });
  peer.send(JSON.stringify({ type: 'cache-control', id: 'clear', action: 'cache-clear' }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(b.request('get_selection', {}), /busy/);
  const denied = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'cache-control', id: 'again', action: 'cache-clear' }));
  assert.match(JSON.parse((await denied)[0]).error, /занят/);
  const cleared = once(peer, 'message'); release();
  assert.equal(JSON.parse((await cleared)[0]).result.removedGenerations, 2);
  const requestMessage = once(peer, 'message'); const pending = b.request('get_selection', {});
  const request = JSON.parse((await requestMessage)[0]);
  const busy = once(peer, 'message'); peer.send(JSON.stringify({ type: 'cache-control', id: 'during-read', action: 'cache-clear' }));
  assert.match(JSON.parse((await busy)[0]).error, /занят/);
  peer.send(JSON.stringify({ type: 'response', id: request.id, result: {} })); await pending;
  assert.deepEqual(calls, ['cache-info', 'cache-clear']);
  const invalid = once(peer, 'close'); peer.send(JSON.stringify({ type: 'cache-control', id: 'x', action: 'delete-path', path: '/' }));
  assert.equal((await invalid)[0], 1008);
});
