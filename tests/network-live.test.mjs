import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { WebSocket } from 'ws';
import { zstd, encodeRecord } from './wire-fixture.mjs';
import { NetworkStore } from '../dist/network-store.js';
import { DiskNetworkSnapshot, SELECTION_LIMITS } from '../dist/network-disk.js';
import { BoundedWireDecoder } from '../dist/network-wire.js';
import { liveFields, LIVE_LIMITS } from '../dist/network-live.js';
import { readStoredNetworkSnapshot, releaseNetworkSelection } from '../dist/network-reader.js';
import { Bridge } from '../dist/bridge.js';
import { createCaptureSender } from '../extension/network-transfer.js';
import { createNetworkCollector } from '../extension/network-collector.js';
const schema = parseSchema(`
 enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; SIGNAL = 3; CLIENT_RENDERED = 4; CLIENT_BROADCAST = 5; USER_CHANGES = 6; }
 enum NodePhase { CREATED = 0; REMOVED = 1; }
 struct GUID { uint sessionID; uint localID; }
 struct ParentIndex { GUID guid; string position; }
 struct Vector { float x; float y; }
 message NodeChange { GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; string type = 4; string name = 5; bool visible = 6; float opacity = 7; Vector size = 8; string stackMode = 9; string unknown = 10; uint nameTag = 11; }
 message UserChange { uint sessionID = 1; string name = 2; bool connected = 3; string unknown = 4; GUID focusedSlideId = 5; string designFullPageViewState = 6; }
 message ClientBroadcast { uint sessionID = 1; string music = 2; string unknown = 3; }
 message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; bool isRetransmission = 3; string signalName = 4; string signalPayload = 5; uint64 sentTimestamp = 6; string clientRenderedMetadata = 7; uint[] nodeChangeOrder = 8; ClientBroadcast[] broadcasts = 9; UserChange[] userChanges = 10; }
`);
const codec = compileSchema(schema), schemaBytes = encodeBinarySchema(schema);
const guid = n => ({sessionID:1,localID:n});
const node = (id,parent,type='FRAME',position=String(id)) => ({guid:guid(id),phase:'CREATED',type,name:`node-${id}`,stackMode:'VERTICAL',...(parent ? {parentIndex:{guid:guid(parent),position}} : {})});
const nodes = () => [node(1),node(2,1),node(3,2,'RECTANGLE','a'),node(4,2,'RECTANGLE','b'),node(8,1),node(9,8,'RECTANGLE')];
const query = {url:'https://www.figma.com/design/test/File?node-id=1-2',format:'debug',depth:50,maxNodes:100,offset:0,includeHidden:true};
const snapshot = {fileKey:'test',sessionId:'live',generation:1};
function record(payload,eventSequence) { return {version:1,kind:'ws-received',session:'main',requestId:'stream',eventSequence,opcode:2,payload:payload.toString('base64')}; }
function initial() {
 const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 return [Buffer.concat([header,zstd(schemaBytes)]), ...[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:nodes()},{type:'JOIN_END'}].map(m=>zstd(codec.encodeMessage(m)))].map(record);
}
const delta = (changes,sequence=4,extra={}) => record(zstd(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:changes,...extra})),sequence);
const evidence = {schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:4,droppedParts:0,sequenceComplete:true};
async function directory(t) {const path=await mkdtemp(join(tmpdir(),'network-live-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function model(t) {
 const m=new DiskNetworkSnapshot('test',await directory(t));t.after(()=>m.close());
 m.acceptMessage({type:'JOIN_START'});for(const n of nodes())m.acceptNode(n);m.acceptMessage({type:'NODE_CHANGES'});m.acceptMessage({type:'JOIN_END'});m.finish();m.query(query);return m;
}
const ids = m => m.query(query).nodes.map(n=>n.id);

test('disk live properties, creation, ordering, removal and external subtree move preserve complete traversal',async t=>{
 const m=await model(t);
 m.applyLive([{guid:guid(3),name:'changed',opacity:0,visible:false}]);
 let value=m.query(query);assert.equal(value.nodes[1].name,'changed');assert.equal(value.nodes[1].opacity,0);
 assert.deepEqual(m.query({...query,includeHidden:false}).nodes.map(n=>n.id),['1:2','1:4']);
 m.applyLive([node(5,2,'RECTANGLE','c')]);assert.deepEqual(ids(m),['1:2','1:3','1:4','1:5']);
 m.applyLive([{guid:guid(5),parentIndex:{guid:guid(2),position:'0'}}]);assert.deepEqual(ids(m),['1:2','1:5','1:3','1:4']);assert.equal(m.selectionCacheStats().nodes,4);
 m.applyLive([{guid:guid(8),parentIndex:{guid:guid(2),position:'d'}}]);assert.deepEqual(ids(m),['1:2','1:5','1:3','1:4','1:8','1:9']);
 assert.equal(m.query(query).nodes.at(-1).parentId,'1:8');
 m.applyLive([{guid:guid(8),parentIndex:{guid:guid(1),position:'z'}}]);assert.deepEqual(ids(m),['1:2','1:5','1:3','1:4']);assert.equal(m.selectionCacheStats().nodes,4);
 m.applyLive([{guid:guid(8),parentIndex:{guid:guid(2),position:'d'}}]);assert.equal(ids(m).filter(id=>id==='1:8').length,1);
 m.applyLive([{guid:guid(3),phase:'REMOVED'}]);assert.deepEqual(ids(m),['1:2','1:5','1:4','1:8','1:9']);
 const page=m.query({...query,maxNodes:2,offset:2});assert.deepEqual(page.nodes.map(n=>n.id),['1:4','1:8']);
 assert.equal(m.query(query).appliedLiveBatches,7);assert.equal(m.query(query).live,true);
 assert.ok(m.selectionCacheStats().nodes<=SELECTION_LIMITS.nodes);assert.ok(m.selectionCacheStats().bytes<=SELECTION_LIMITS.bytes);
});

for(const [name,changes] of [
 ['nonfinite vector',[{guid:guid(3),size:{x:NaN,y:1}}]],
 ['missing update',[{guid:guid(90),name:'missing'}]],
 ['duplicate create',[node(3,2)]], ['unknown field',[{guid:guid(3),unknown:'x'}]],
 ['field tag',[{guid:guid(3),nameTag:2}]], ['component creation',[node(20,2,'INSTANCE')]],
 ['type change',[{guid:guid(3),type:'TEXT'}]], ['non-leaf deletion',[{guid:guid(8),phase:'REMOVED'}]],
 ['root deletion',[{guid:guid(2),phase:'REMOVED'}]], ['missing parent',[{guid:guid(3),parentIndex:{guid:guid(99),position:'x'}}]],
 ['cycle',[{guid:guid(2),parentIndex:{guid:guid(3),position:'x'}}]],
 ['duplicate GUID',[{guid:guid(3),name:'a'},{guid:guid(3),name:'b'}]],
 ['partial invalid batch',[{guid:guid(3),name:'must not escape'},{guid:guid(90),name:'missing'}]],
])test(`unsupported ${name} poisons index and forbids partial query`,async t=>{
 const m=await model(t);assert.throws(()=>m.applyLive(changes));assert.throws(()=>m.query(query),/STALE|busy/);
});

test('strict live decoder rejects omitted unknown fields and transport metadata',()=>{
 const decoder=new BoundedWireDecoder(schemaBytes,liveFields);
 for(const message of [{type:'NODE_CHANGES',nodeChanges:[{guid:guid(3),unknown:'x'}]},
  {type:'NODE_CHANGES',isRetransmission:true,nodeChanges:[{guid:guid(3),name:'x'}]}]){
  assert.throws(()=>decoder.decode(codec.encodeMessage(message),()=>{},true),/Unsupported/);
 }
 const changes=[];decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[{guid:guid(3),name:''}]}),n=>changes.push(n),true);
 assert.equal(changes[0].phase,undefined);assert.equal(changes[0].name,'');
});

async function bridgeFixture(t) {
 const store=await NetworkStore.create(await directory(t));const secret='b'.repeat(64);
 const bridge=new Bridge(secret,0,3000,undefined,store);await bridge.ready;
 const peer=new WebSocket(`ws://127.0.0.1:${bridge.port}`);await once(peer,'open');const ready=once(peer,'message');peer.send(JSON.stringify({type:'auth',secret,fileKey:'test'}));await ready;
 t.after(async()=>{await bridge.close();for(let i=0;i<100;i++){try{await releaseNetworkSelection();break;}catch{await new Promise(r=>setTimeout(r,5));}}});
 return {store,bridge,peer};
}
async function capture(t) {
 const f=await bridgeFixture(t);const sender=createCaptureSender(f.peer,snapshot);await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 await readStoredNetworkSnapshot(f.store,snapshot,query);return {...f,sender};
}

test('bridge applies a live frame to retained worker, binds continuation to revision, and never rehydrates stale initial bytes',async t=>{
 const {store,sender}=await capture(t);
 const page=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1});assert.ok(page.traversal.continuation);
 const ack=await sender.delta(encodeRecord(delta([{guid:guid(8),parentIndex:{guid:guid(2),position:'c'}},{guid:guid(3),name:'wire update'}])));
 assert.equal(ack.revision,1);
 const updated=await readStoredNetworkSnapshot(store,snapshot,query);
 assert.equal(updated.freshness.revision,1);assert.equal(updated.metrics.selectionCacheHit,true);
 assert.deepEqual(updated.nodes.map(n=>n.id),['1:2','1:3','1:4','1:8','1:9']);assert.equal(updated.nodes[1].name,'wire update');
 // Releasing an updated index deliberately invalidates observation; old bytes are never replayed as new.
 await releaseNetworkSelection();await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
});

test('old continuation is rejected after accepted update',async t=>{
 const {store,sender}=await capture(t);const page=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1});
 await sender.delta(encodeRecord(delta([{guid:guid(3),name:'revision'}])));
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1,continuation:page.traversal.continuation}),/Continuation|continuation/);
 assert.equal((await readStoredNetworkSnapshot(store,snapshot,query)).nodes[1].name,'revision');
});

for(const [name,make] of [
 ['unknown field',()=>delta([{guid:guid(3),unknown:'x'}])],
 ['event gap',()=>delta([{guid:guid(3),name:'x'}],5)],
 ['foreign stream',()=>({...delta([{guid:guid(3),name:'x'}]),requestId:'foreign'})],
 ['batch limit',()=>delta(Array.from({length:LIVE_LIMITS.changes+1},(_,i)=>({guid:guid(i+100),name:'x'})))],
])test(`bridge unsupported ${name} invalidates observation`,async t=>{
 const {store,sender}=await capture(t);const manifest=await store.readManifest(snapshot);const signal=store.freshness(manifest);
 await assert.rejects(sender.delta(encodeRecord(make())));
 assert.equal(signal.aborted,true);
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
});

test('change before first selection read fails closed instead of being lost',async t=>{
 const {store,peer}=await bridgeFixture(t);const sender=createCaptureSender(peer,snapshot);
 await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 await assert.rejects(sender.delta(encodeRecord(delta([{guid:guid(3),name:'x'}]))),/idle selection index/);
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
});

test('collector forwards post-JOIN frame through real bridge to existing selection and acknowledges ready revision',async t=>{
 const {store,peer}=await bridgeFixture(t);let event;
 const chrome={debugger:{onEvent:{addListener:f=>{event=f;}},onDetach:{addListener(){}},attach:async()=>{},detach:async()=>{},sendCommand:async()=>{}}};
 const collector=createNetworkCollector(chrome);t.after(()=>collector.stop());await collector.start({tabId:7,fileKey:'test',socket:peer});
 event({tabId:7},'Network.webSocketCreated',{requestId:'stream',url:'wss://www.figma.com/api/multiplayer/test'});
 const wait=async predicate=>{for(let i=0;i<600;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('timeout');};
 for(const r of initial()) {
  event({tabId:7},'Network.webSocketFrameReceived',{requestId:'stream',response:{opcode:2,payloadData:r.payload}});
  await wait(()=>collector.status.events>=r.eventSequence+1);
 }
 await wait(()=>collector.status.state==='ready');
 const [dir]=(await readdir(store.root)).filter(n=>/^[a-f0-9]{64}$/.test(n));const manifest=JSON.parse(await readFile(join(store.root,dir,'ready.json'),'utf8'));
 await readStoredNetworkSnapshot(store,manifest.snapshot,query);
 event({tabId:7},'Network.webSocketFrameReceived',{requestId:'stream',response:{opcode:2,payloadData:delta([{guid:guid(3),name:'collector update'}]).payload}});
 assert.equal(collector.status.state,'updating');await wait(()=>collector.status.state!=='updating');assert.equal(collector.status.state,'ready');
 assert.equal((await readStoredNetworkSnapshot(store,manifest.snapshot,query)).nodes[1].name,'collector update');
});

test('delta racing an active read cancels observation and cannot return the old selection',async t=>{
 const {store,sender}=await capture(t);const readPart=store.readPart.bind(store);
 let entered,release;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
 store.readPart=async(...args)=>{entered();await gate;return readPart(...args);};
 const reading=readStoredNetworkSnapshot(store,snapshot,query);
 const rejected=assert.rejects(reading,/STALE|cancelled/);
 await started;
 await assert.rejects(sender.delta(encodeRecord(delta([{guid:guid(3),name:'racing'}]))),/busy|released/);
 release();await rejected;
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
});

test('disconnect during live apply never acknowledges or advances revision',async t=>{
 const {store,peer}=await bridgeFixture(t);const sender=createCaptureSender(peer,snapshot);
 await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 const manifest=await store.readManifest(snapshot);const signal=store.freshness(manifest);
 let entered,release;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
 const unregister=store.onLive(snapshot,async()=>{entered();await gate;});t.after(unregister);
 const applying=sender.delta(encodeRecord(delta([{guid:guid(3),name:'x'}])));const rejected=assert.rejects(applying,/disconnected/);
 await started;const closed=once(peer,'close');peer.close();await closed;await rejected;release();
 for(let i=0;i<100&&!signal.aborted;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(signal.aborted,true);assert.throws(()=>store.liveRevision(manifest),/STALE/);
});

test('last-child deletion does not report phantom depth truncation and live batch limit is enforced',async t=>{
 const m=await model(t);m.applyLive([{guid:guid(9),phase:'REMOVED'}]);
 const leaf=m.query({...query,url:query.url.replace('1-2','1-8'),depth:0});assert.equal(leaf.traversal.pendingDepthCount,0);
 m.query(query);
 for(let i=1;i<LIVE_LIMITS.batches;i++)m.applyLive([{guid:guid(3),name:String(i)}]);
 assert.throws(()=>m.applyLive([{guid:guid(3),name:'overflow'}]),/limit/);assert.throws(()=>m.query(query),/STALE|busy/);
});

test('trailing corrupt bytes after a valid delta never mutate a visible selection',async t=>{
 const {store,sender}=await capture(t);const m=Buffer.concat([codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[{guid:guid(3),name:'partial'}]}),Buffer.from([0])]);
 await assert.rejects(sender.delta(encodeRecord(record(zstd(m),4))),/Trailing/);
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
});

const service = (sequence=4, extra={}) => record(zstd(codec.encodeMessage({type:'SIGNAL',signalName:'reconnect-key',signalPayload:'test-key',...extra})),sequence);

test('reconnect-key before first read preserves observation, pagination and document revision', async t => {
 const {store,peer}=await bridgeFixture(t);const sender=createCaptureSender(peer,snapshot);
 await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 assert.equal((await sender.delta(encodeRecord(service()))).revision,1);
 const page=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1});
 assert.equal(page.freshness.revision,0);
 await sender.delta(encodeRecord(service(5,{signalName:'reconnect-sequence-number',signalPayload:'1'})));
 const next=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1,continuation:page.traversal.continuation});
 assert.equal(next.nodes[0].id,'1:3');assert.equal(next.freshness.revision,0);
 await sender.delta(encodeRecord(delta([{guid:guid(3),name:'after signal'}],6)));
 assert.equal((await readStoredNetworkSnapshot(store,snapshot,query)).nodes[1].name,'after signal');
});

test('reconnect-key during cold decoding does not cancel or require an idle index', async t => {
 const {store,peer}=await bridgeFixture(t);const sender=createCaptureSender(peer,snapshot);
 await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 let entered, release;const started=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
 const readManifest=store.readManifest.bind(store);
 store.readManifest=async(...args)=>{entered();await gate;return readManifest(...args);};
 const reading=readStoredNetworkSnapshot(store,snapshot,query);
 await started;await sender.delta(encodeRecord(service()));release();
 assert.equal((await reading).nodes.length,3);
});

for (const [name,extra] of [['unknown signal',{signalName:'unknown'}],['nodes in signal',{nodeChanges:[{guid:guid(3),name:'hidden update'}]}],['extra metadata',{isRetransmission:true}]])
 test(`service classifier rejects ${name} before first read`,async t=>{
 const {store,peer}=await bridgeFixture(t);const sender=createCaptureSender(peer,snapshot);
 await sender.begin();for(const r of initial())await sender.append(encodeRecord(r));await sender.finish(evidence);
 await assert.rejects(sender.delta(encodeRecord(service(4,extra))));
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
 });

 test('outgoing render telemetry is neutral; outgoing node changes never mutate the index',async t=>{
 const {store,sender}=await capture(t);
 const render={...record(zstd(codec.encodeMessage({type:'CLIENT_RENDERED',sentTimestamp:'1000',clientRenderedMetadata:'timing',nodeChangeOrder:[]})),4),kind:'ws-sent'};
 await sender.delta(encodeRecord(render));
 assert.equal((await readStoredNetworkSnapshot(store,snapshot,query)).freshness.revision,0);
 await assert.rejects(sender.delta(encodeRecord({...delta([{guid:guid(3),name:'outgoing'}],5),kind:'ws-sent'})),/outgoing/);
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
 });

 for(const [name,message,kind] of [
 ['render nodes',{type:'CLIENT_RENDERED',nodeChanges:[{guid:guid(3),name:'hidden'}]},'ws-sent'],
 ['incoming render',{type:'CLIENT_RENDERED'},'ws-received'],
 ['signal with render metadata',{type:'SIGNAL',signalName:'reconnect-key',sentTimestamp:'1000'},'ws-received'],
 ['unknown presence field',{type:'USER_CHANGES',userChanges:[{sessionID:1,unknown:'x'}]},'ws-received'],
 ['presence carrying nodes',{type:'USER_CHANGES',userChanges:[{sessionID:1}],nodeChanges:[{guid:guid(3),name:'hidden'}]},'ws-received'],
 ['unknown broadcast field',{type:'CLIENT_BROADCAST',broadcasts:[{sessionID:1,unknown:'x'}]},'ws-received'],
 ['outgoing signal',{type:'SIGNAL',signalName:'reconnect-key'},'ws-sent'],
 ])test(`service classifier rejects ${name}`,async t=>{
 const {store,sender}=await capture(t);
 await assert.rejects(sender.delta(encodeRecord({...record(zstd(codec.encodeMessage(message)),4),kind})));
 await assert.rejects(readStoredNetworkSnapshot(store,snapshot,query),/STALE|busy/);
 });

 test('client presence broadcast does not change document revision',async t=>{
 const {store,sender}=await capture(t);
 await sender.delta(encodeRecord(record(zstd(codec.encodeMessage({type:'CLIENT_BROADCAST',broadcasts:[{sessionID:1,music:'off'}]})),4)));
 assert.equal((await readStoredNetworkSnapshot(store,snapshot,query)).freshness.revision,0);
 });

 test('presence updates in either direction preserve selection pagination',async t=>{
 const {store,sender}=await capture(t);const page=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1});
 for(const [i,kind] of ['ws-received','ws-sent'].entries()) await sender.delta(encodeRecord({...record(zstd(codec.encodeMessage({type:'USER_CHANGES',userChanges:[{sessionID:1,name:'viewer',connected:true,focusedSlideId:guid(2),designFullPageViewState:'view'}],...(kind==='ws-sent'?{sentTimestamp:'1000',nodeChangeOrder:[]}: {})})),4+i),kind}));
 const next=await readStoredNetworkSnapshot(store,snapshot,{...query,maxNodes:1,continuation:page.traversal.continuation});
 assert.equal(next.freshness.revision,0);assert.equal(next.nodes[0].id,'1:3');
 });
