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

test('invalid transport sequence remains diagnosable after disconnect', async t => {
  const {peer, bridge, connect} = await fixture(t);
  await request(peer, 'begin');
  const closed = once(peer, 'close');
  const result = await request(peer, 'delta', {sequence: Number.MAX_SAFE_INTEGER, data: 'AQ=='});
  assert.match(result.error, /^Invalid capture command: sequence:/);
  assert.doesNotMatch(result.error, /queue overflow/);
  await closed;
  await wait(() => !bridge.status.connected && bridge.status.lastDisconnect);
  assert.equal(bridge.status.captureError, result.error);
  assert.ok([1008, 4008].includes(bridge.status.lastDisconnect.code));
  const next = await connect();
  assert.equal(bridge.status.captureError, undefined);
  assert.equal(bridge.status.lastDisconnect, undefined);
  next.close();
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
  const { store, peer, bridge, connect } = await fixture(t, store => ({setSelection: (...args) => store.setSelection(...args), observe: id => store.observe(id), renewObservation: controller => store.renewObservation(controller), applyLive: (...args) => store.applyLive(...args), begin: async (...args) => {
    const writer = await store.begin(...args);
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
  const { store, peer, bridge } = await fixture(t, store => ({setSelection: (...args) => store.setSelection(...args), observe: id => store.observe(id), renewObservation: controller => store.renewObservation(controller), applyLive: (...args) => store.applyLive(...args), begin: async (...args) => {
    const writer = await store.begin(...args);
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
  const { store, peer } = await fixture(t, store => ({setSelection: (...args) => store.setSelection(...args), observe: id => store.observe(id), renewObservation: controller => store.renewObservation(controller), applyLive: (...args) => store.applyLive(...args), begin: async (...args) => {
    const writer = await store.begin(...args);
    return { ...writer, get state() {return writer.state;}, append: async () => {throw Error('ENOSPC');} };
  }}));
  const sender = createCaptureSender(peer, snapshot); await sender.begin();
  await assert.rejects(sender.append(new Uint8Array([1])), /ENOSPC/);
  await assert.rejects(store.readManifest(snapshot));
});

test('capture timeout disconnects idle producer and new connection can capture a fresh generation', async t => {
  // The same deadline also covers disk I/O in the replacement capture. Use
  // the normal fixture budget: 80 ms can expire under the full suite's load.
  const { store, peer, bridge, connect } = await fixture(t);
  const closed = once(peer, 'close');
  assert.equal((await request(peer, 'begin')).type, 'capture-result');
  const [raw] = await once(peer, 'message');
  const error = JSON.parse(raw);
  assert.equal(error.type, 'capture-error');
  assert.match(error.error, /Capture observation timeout/);
  const [code] = await closed;
  assert.equal(code, 1008);
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
  const { store, peer, bridge } = await fixture(t, store => ({setSelection: (...args) => store.setSelection(...args), observe: id => store.observe(id), renewObservation: controller => store.renewObservation(controller), applyLive: (...args) => store.applyLive(...args), begin: async (...args) => {
    const writer = await store.begin(...args);
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

test('committed observation survives heartbeats, ends on disconnect, and reconnect never revives old generation',async t=>{
 const {store,peer,connect}=await fixture(t);
 await request(peer,'begin');
 for(const [sequence,record] of initialRecords().entries())await request(peer,'part',{sequence,data:encodeRecord(record).toString('base64')});
 await request(peer,'finish',{evidence:evidence(4)});
 const manifest=await store.readManifest(snapshot);assert.equal(manifest.monitored,true);
 const signal=store.freshness(manifest);assert.equal(signal.aborted,false);
 for(let i=0;i<2;i++)assert.equal((await request(peer,'heartbeat')).status,'ready');
 const closed=once(peer,'close');peer.close();await closed;await wait(()=>signal.aborted);
 assert.throws(()=>store.freshness(manifest),/STALE/);
 const next=await connect();const sender=createCaptureSender(next,{...snapshot,generation:2});
 await sender.begin();for(const record of initialRecords())await sender.append(encodeRecord(record));await sender.finish(evidence(4));
 assert.throws(()=>store.freshness(manifest),/STALE/);
 assert.equal(store.freshness(await store.readManifest({...snapshot,generation:2})).aborted,false);
});

test('expired observation cannot be renewed even before its timeout callback executes',async t=>{
 const {store}=await fixture(t);
 const owner=store.observe(snapshot,0);
 assert.throws(()=>store.renewObservation(owner),/STALE/);
 assert.equal(owner.signal.aborted,true);
});

test('sender keeps bounded heartbeat traffic after finish and removes its timer on cancellation',async()=>{
 class Socket extends EventTarget {
  readyState=1;bufferedAmount=0;sent=[];
  send(value){const msg=JSON.parse(value);this.sent.push(msg);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({
   type:'capture-result',id:msg.id,snapshot:msg.snapshot,action:msg.action,nextSequence:0,status:msg.action==='begin'?'capturing':'ready'
  })})));}
  close(){this.readyState=3;}
 }
 const tasks=new Map();let sequence=0;
 const timers={setTimeout(fn,ms){const id=++sequence;tasks.set(id,{fn,ms});return id;},clearTimeout(id){tasks.delete(id);}};
 const socket=new Socket();const sender=createCaptureSender(socket,snapshot,{timers});
 await sender.begin();await sender.finish(evidence(1));
 assert.equal(tasks.size,1);const [id,task]=[...tasks][0];assert.equal(task.ms,5000);
 tasks.delete(id);task.fn();for(let i=0;i<5;i++)await Promise.resolve();
 assert.equal(socket.sent.at(-1).action,'heartbeat');assert.equal(sender.status.state,'ready');assert.equal(tasks.size,1);
 sender.cancel();assert.equal(tasks.size,0);assert.equal(socket.readyState,3);
});

test('repeated close shares cleanup and retains the transfer slot until abort finishes',async()=>{
 const {NetworkTransfer}=await import('../dist/network-transfer.js');
 let release,entered,aborts=0,state={status:'capturing'};
 const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
 const store={begin:async()=>({get state(){return state;},abort:async()=>{aborts++;entered();await gate;state={status:'error'};}})};
 let acknowledge;const ready=new Promise(r=>{acknowledge=r;});
 const transfer=new NetworkTransfer(store,'file1',()=>acknowledge(),()=>{});
 transfer.receive({type:'capture',id:'begin',snapshot,action:'begin'},false);await ready;await Promise.resolve();
 const first=transfer.close(),second=transfer.close();assert.equal(first,second);await started;
 assert.equal(transfer.busy,true);assert.equal(aborts,1);release();await first;assert.equal(transfer.busy,false);
});

test('reconnection waits for the previous writer cleanup before advertising ready', async t => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const { peer, connect } = await fixture(t, store => ({
    setSelection: (...args) => store.setSelection(...args), observe: id => store.observe(id), renewObservation: owner => store.renewObservation(owner),
    applyLive: (...args) => store.applyLive(...args), begin: async (...args) => {
      const writer = await store.begin(...args);
      return {...writer, get state() { return writer.state; }, abort: async (...values) => {
        entered(); await gate; return writer.abort(...values);
      }};
    },
  }));
  await request(peer, 'begin');
  const closed=once(peer,'close');peer.close();await closed;await started;
  let ready=false;
  const connecting=connect().then(socket=>{ready=true;return socket;});
  await new Promise(r=>setTimeout(r,30));assert.equal(ready,false);
  release();const next=await connecting;
  const sender=createCaptureSender(next,{...snapshot,generation:2});
  await sender.begin();for(const record of initialRecords())await sender.append(encodeRecord(record));await sender.finish(evidence(4));
});

test('live frame arriving during heartbeat waits for its ACK without losing either request',async()=>{
 class Socket extends EventTarget {
  readyState=1;bufferedAmount=0;sent=[];
  ack(msg){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'capture-result',id:msg.id,snapshot:msg.snapshot,action:msg.action,nextSequence:0,revision:msg.action==='delta'?1:0,status:msg.action==='begin'?'capturing':'ready'})}));}
  send(value){const msg=JSON.parse(value);this.sent.push(msg);if(msg.action!=='heartbeat')queueMicrotask(()=>this.ack(msg));}
  close(){this.readyState=3;}
 }
 const tasks=new Map();let id=0;
 const timers={setTimeout(fn,ms){tasks.set(++id,{fn,ms});return id;},clearTimeout(id){tasks.delete(id);}};
 const socket=new Socket(), sender=createCaptureSender(socket,snapshot,{timers});
 await sender.begin();await sender.finish(evidence(1));
 const [key,task]=[...tasks][0];tasks.delete(key);task.fn();
 const updating=sender.delta(new Uint8Array([1]));
 assert.equal(socket.sent.at(-1).action,'heartbeat');assert.equal(socket.readyState,1);
 socket.ack(socket.sent.at(-1));assert.equal((await updating).revision,1);
 assert.equal(socket.sent.at(-1).action,'delta');assert.equal(tasks.size,1);sender.cancel();
});

test('capture cancellation uses a close code allowed by browser WebSocket',()=>{
 class BrowserSocket extends EventTarget {
  readyState=1;bufferedAmount=0;
  close(code){
   if(code!==1000&&(code<3000||code>4999))throw new DOMException('Invalid close code','InvalidAccessError');
   this.code=code;this.readyState=3;
  }
 }
 const socket=new BrowserSocket(), sender=createCaptureSender(socket,snapshot);
 assert.doesNotThrow(()=>sender.cancel());assert.equal(socket.readyState,3);assert.equal(socket.code,4008);
});
