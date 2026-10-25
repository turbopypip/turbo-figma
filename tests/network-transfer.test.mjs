import {initialRecords,encodeRecord} from './wire-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Bridge } from '../dist/bridge.js';
import { NetworkStore } from '../dist/network-store.js';
import { createCaptureSender, TRANSFER_PART_BYTES } from '../extension/network-transfer.js';
const secret = 'a'.repeat(64);
const snapshot = { fileKey: 'file1', sessionId: 'session1', generation: 1 };
const evidence = count => ({ schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts: count, droppedParts: 0, sequenceComplete: true });
const wait = async predicate => {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw Error('Timeout'); await new Promise(r => setTimeout(r, 5)); }
};
async function fixture(t, wrap = store => store, timeout = 2000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'network-transfer-'));
  const store = await NetworkStore.create(directory);
  const bridge = new Bridge(secret, 0, timeout, action => action === 'cache-clear' ? store.clean() : store.info(), wrap(store));
  await bridge.ready;
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const connect = async (fileKey = snapshot.fileKey) => {
    const peer = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await once(peer, 'open');
    const ready = once(peer, 'message'); peer.send(JSON.stringify({ type: 'auth', secret, fileKey })); await ready;
    return peer;
  };
  const peer = await connect();
  return { store, bridge, peer, connect };
}
async function request(peer, action, fields = {}) {
  const result = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'capture', id: crypto.randomUUID(), snapshot, action, ...fields }));
  return JSON.parse((await result)[0]);
}

test('synthetic extension sender persists exact bytes and commits only after all acknowledgements', async t => {
  const { store, peer, bridge } = await fixture(t);
  const sender = createCaptureSender(peer, snapshot);
  await sender.begin();
  await assert.rejects(store.readManifest(snapshot));
  await assert.rejects(bridge.request('get_selection', {}), /busy/);
  const denied = once(peer, 'message'); peer.send(JSON.stringify({type:'cache-control', id:'clear',action:'cache-clear'}));
  assert.match(JSON.parse((await denied)[0]).error, /занят/);
  const records = initialRecords({messages:[{type:'JOIN_START'}, {type:'NODE_CHANGES',nodeChanges:[{phase:'CREATED',name:'x'.repeat(TRANSFER_PART_BYTES)}]}, {type:'JOIN_END'}]});
  const bytes = Buffer.concat(records.map(encodeRecord)); let count = 0;
  for(let offset=0;offset<bytes.length;offset+=TRANSFER_PART_BYTES){await sender.append(bytes.subarray(offset,offset+TRANSFER_PART_BYTES));count++;}
  assert.equal((await sender.finish(evidence(count))).status, 'ready');
  assert.deepEqual(await store.readPart(snapshot, 0), bytes.subarray(0,TRANSFER_PART_BYTES));
  assert.equal((await store.readManifest(snapshot)).parts.length, count);
  assert.equal(sender.status.pendingParts, 0);
  assert.equal(bridge.status.busy, false);
});

for (const [name, fields] of [
  ['foreign file', { snapshot: { ...snapshot, fileKey: 'other' } }],
  ['foreign session', { snapshot: { ...snapshot, sessionId: 'other' } }],
  ['foreign generation', { snapshot: { ...snapshot, generation: 2 } }],
  ['sequence gap', { sequence: 2 }],
  ['noncanonical base64', { data: 'AA==\n' }],
  ['oversized part', { data: Buffer.alloc(TRANSFER_PART_BYTES + 1).toString('base64') }],
]) test(`${name} invalidates capture without a ready manifest`, async t => {
  const { store, peer, bridge } = await fixture(t);
  await request(peer, 'begin');
  const closed = once(peer, 'close');
  const result = await request(peer, 'part', { sequence: 0, data: 'AQ==', ...fields });
  assert.equal(result.type, 'capture-error'); await closed;
  await wait(() => !bridge.status.connected);
  await assert.rejects(store.readManifest(snapshot));
});

test('duplicate and missing parts cannot be committed', async t => {
  const { store, peer } = await fixture(t);
  await request(peer, 'begin'); await request(peer, 'part', {sequence:0,data:'AQ=='});
  assert.equal((await request(peer, 'part', {sequence:0,data:'AQ=='})).type, 'capture-error');
  await assert.rejects(store.readManifest(snapshot));
});
for (const [name, value] of [['count mismatch', evidence(2)], ['missing join', {...evidence(1),joinEnded:false}], ['dropped parts', {...evidence(1),droppedParts:1}]]) {
  test(`finish rejects ${name}`, async t => {
    const { store, peer } = await fixture(t);
    await request(peer, 'begin'); await request(peer, 'part', {sequence:0,data:'AQ=='});
    assert.equal((await request(peer, 'finish', {evidence:value})).type, 'capture-error');
    await assert.rejects(store.readManifest(snapshot));
  });
}

test('slow disk with concurrent producer rejects overflow; no second part is queued or committed', async t => {
  let release, entered = false, writes = 0;
  const { store, peer, bridge, connect } = await fixture(t, store => ({begin: async id => {
    const writer = await store.begin(id);
    return { ...writer, get state() { return writer.state; }, append: async (...args) => {
      writes++; entered = true; await new Promise(r => { release = r; }); await writer.append(...args);
    } };
  }}));
  const sender = createCaptureSender(peer, snapshot);
  await sender.begin();
  const first = sender.append(new Uint8Array([1])); const rejected = assert.rejects(first, /overflow/);
  await wait(() => entered);
  assert.equal(sender.status.pendingParts, 1);
  await assert.rejects(sender.append(new Uint8Array([2])), /overflow/); await rejected;
  release(); await wait(() => !bridge.status.connected);
  // close() waits for the write and abort, then frees the store for another generation.
  await bridge.close();
  assert.equal(writes, 1); await assert.rejects(store.readManifest(snapshot));
  await store.clean();
});

test('server rejects pipelined parts during a slow write and frees writer after disconnect', async t => {
  let release, entered = false;
  const { store, peer, bridge } = await fixture(t, store => ({begin: async id => {
    const writer = await store.begin(id);
    return { ...writer, get state() { return writer.state; }, append: async (...args) => {
      entered = true; await new Promise(r => {release = r;}); await writer.append(...args);
    }};
  }}));
  await request(peer, 'begin');
  peer.send(JSON.stringify({type:'capture',id:'first',snapshot,action:'part',sequence:0,data:'AQ=='}));
  await wait(() => entered);
  const error = await request(peer, 'part', {sequence:1,data:'Ag=='});
  assert.match(error.error,/overflow/);
  release(); await bridge.close();
  await assert.rejects(store.readManifest(snapshot)); await store.clean();
});

test('disk error is explicit and the failed generation remains unreadable', async t => {
  const { store, peer } = await fixture(t, store => ({begin: async id => {
    const writer = await store.begin(id);
    return { ...writer, get state() {return writer.state;}, append: async () => {throw Error('ENOSPC');} };
  }}));
  const sender = createCaptureSender(peer, snapshot); await sender.begin();
  await assert.rejects(sender.append(new Uint8Array([1])), /ENOSPC/);
  await assert.rejects(store.readManifest(snapshot));
});

test('capture timeout disconnects idle producer and new connection can capture a fresh generation', async t => {
  const { store, peer, bridge, connect } = await fixture(t, undefined, 80);
  await request(peer, 'begin');
  await once(peer, 'close');
  await wait(() => !bridge.status.connected);
  const next = await connect(); const sender = createCaptureSender(next, {...snapshot,generation:2});
  await sender.begin(); for(const record of initialRecords())await sender.append(encodeRecord(record)); await sender.finish(evidence(4));
  await assert.rejects(store.readManifest(snapshot));
  assert.equal((await store.readManifest({...snapshot,generation:2})).status,'ready');
});

test('auth file binding is required for capture while legacy auth still supports the bridge', async t => {
  const { peer, bridge } = await fixture(t);
  const closed = once(peer,'close'); peer.close(); await closed;
  const legacy = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  await once(legacy,'open');
  const ready = once(legacy,'message'); legacy.send(JSON.stringify({type:'auth',secret})); await ready;
  assert.match((await request(legacy,'begin')).error,/file mismatch/);
});

test('disconnect during finish cancels publication and releases the capture slot', async t => {
  let release, entered = false;
  const { store, peer, bridge } = await fixture(t, store => ({begin: async id => {
    const writer = await store.begin(id);
    return { ...writer, get state() {return writer.state;}, commit: async (...args) => {
      entered = true; await new Promise(r => {release = r;}); return writer.commit(...args);
    }};
  }}));
  await request(peer,'begin');
  for(const [sequence,record] of initialRecords().entries())await request(peer,'part',{sequence,data:encodeRecord(record).toString('base64')});
  peer.send(JSON.stringify({type:'capture',id:'finish',snapshot,action:'finish',evidence:evidence(4)}));
  await wait(() => entered);
  const closed = once(peer,'close'); peer.close(); await closed;
  release(); await bridge.close();
  await assert.rejects(store.readManifest(snapshot)); await store.clean();
});

test('sender bounds pending state on missing or incorrect acknowledgements', async () => {
  class Socket extends EventTarget {
    readyState = 1; bufferedAmount = 0; sent = [];
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  }
  let socket = new Socket();
  let sender = createCaptureSender(socket,snapshot,{timeout:20});
  await assert.rejects(sender.begin(),/timeout/);
  assert.equal(socket.readyState,3); assert.equal(sender.status.state,'error');
  socket = new Socket(); sender = createCaptureSender(socket,snapshot);
  const pending = sender.begin(); const rejected = assert.rejects(pending,/acknowledgement/);
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'capture-result',id:socket.sent[0].id,
    snapshot:{...snapshot,sessionId:'wrong'},action:'begin',nextSequence:0,status:'capturing'})}));
  await rejected; assert.equal(socket.readyState,3);
});

test('managed stream cannot publish forged completion evidence without actual JOIN_END',async t=>{
  const {initialRecords,encodeRecord}=await import('./wire-fixture.mjs');
  const {store,peer}=await fixture(t);const sender=createCaptureSender(peer,snapshot,{format:'ndjson-v1'});
  await sender.begin();await sender.append(encodeRecord(initialRecords()[0]));
  await assert.rejects(sender.finish(evidence(1)),/incomplete/);
  await assert.rejects(store.readManifest(snapshot));
});

test('managed stream derives readiness from persisted split records and commits on explicit finish',async t=>{
  const {initialRecords,encodeRecord}=await import('./wire-fixture.mjs');
  const {store,peer}=await fixture(t);const sender=createCaptureSender(peer,snapshot,{format:'ndjson-v1'});
  await sender.begin();let parts=0,last;
  for(const record of initialRecords()) {
    const bytes=encodeRecord(record);
    for(let offset=0;offset<bytes.length;offset+=17){last=await sender.append(bytes.subarray(offset,offset+17));parts++;}
  }
  assert.equal(last.initial.initialComplete,true);await assert.rejects(store.readManifest(snapshot));
  await sender.finish(evidence(parts));assert.equal((await store.readManifest(snapshot)).parts.length,parts);
});
