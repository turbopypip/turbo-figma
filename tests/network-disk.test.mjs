import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { BoundedWireDecoder, WIRE_LIMITS } from '../dist/network-wire.js';
import { DiskNetworkSnapshot, SELECTION_LIMITS } from '../dist/network-disk.js';
import { nodeFields } from '../dist/network.js';
import { NetworkStore } from '../dist/network-store.js';
import { readStoredNetworkSnapshot, releaseNetworkSelection, stopNetworkSelection } from '../dist/network-reader.js';
import { probeEvents } from '../dist/network-source.js';
import { zstd } from './wire-fixture.mjs';
const schema = parseSchema(`
 enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
 enum Phase { CREATED = 0; UPDATED = 1; }
 struct Guid { uint sessionID; uint localID; }
 struct Parent { Guid guid; string position; }
 message NodeChange { Guid guid = 1; Phase phase = 2; Parent parentIndex = 3; string name = 4; bool visible = 5; NodeChange[] overrides = 6; byte[] ignored = 7; string textData = 8; string stackMode = 9; string stackChildAlignSelf = 10; string stackPrimarySizing = 11; string stackCounterSizing = 12; float stackChildPrimaryGrow = 13; }
 message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
`);
const codec = compileSchema(schema), wireSchema = encodeBinarySchema(schema);
const guid = n => ({ sessionID: 1, localID: n });
const node = (n, parent, position='!', extra={}) => ({guid:guid(n),phase:'CREATED',name:`node ${n}`, ...(parent ? {parentIndex:{guid:guid(parent),position}} : {}),...extra});
const query = {format:'debug',url:'https://www.figma.com/design/test/File?node-id=1-1',depth:50,maxNodes:500,offset:0,includeHidden:false};
const identity={fileKey:'test',sessionId:'test',generation:1};
async function directory(t) { const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'disk-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }
function records(nodes) {
 const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 return [Buffer.concat([header,zstd(wireSchema)]),...[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:nodes},{type:'JOIN_END'}].map(m=>zstd(codec.encodeMessage(m)))].map((b,eventSequence)=>({version:1,kind:'ws-received',session:'main',requestId:'1',eventSequence,opcode:2,payload:b.toString('base64')}));
}
async function capture(store, values, chunkSize = 97) {
 const writer=await store.begin(identity);let i=0;
 const data=Buffer.from(values.map(v=>JSON.stringify(v)+'\n').join(''));
 for(let offset=0;offset<data.length;offset+=chunkSize) await writer.append(i++,data.subarray(offset,offset+chunkSize));
 await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:i});
}
test('bounded decoder visits only top-level nodes, skips blobs, and agrees with Kiwi values',()=>{
 const decoder=new BoundedWireDecoder(wireSchema,nodeFields), nodes=[];
 const input=[node(1,undefined,'!',{name:'Кириллица 😀',overrides:[{phase:'UPDATED'}],ignored:new Uint8Array(250000)})];
 const result=decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:input}),n=>nodes.push(n));
 assert.deepEqual(result,{type:'NODE_CHANGES'});assert.equal(nodes.length,1);
 assert.deepEqual(nodes[0],{guid:guid(1),phase:'CREATED',name:'Кириллица 😀'});
});
test('schema and wire reject lengths, recursion, duplicate fields, trailing data and truncated varints',()=>{
 const decoder=new BoundedWireDecoder(wireSchema,nodeFields);
 assert.throws(()=>new BoundedWireDecoder(Buffer.from([255,255,255,255,127]),nodeFields),/varint/);
 assert.throws(()=>new BoundedWireDecoder(Buffer.concat([wireSchema,Buffer.from([0])]),nodeFields),/Trailing/);
 assert.throws(()=>decoder.decode(Buffer.from([2,255,255,255,255,15]),()=>{}),/array limit/);
 assert.throws(()=>decoder.decode(Buffer.from([1,1,1,1,0]),()=>{}),/Duplicate/);
 assert.throws(()=>decoder.decode(Buffer.from([0,0]),()=>{}),/Trailing/);
 let deep={phase:'CREATED'};for(let i=0;i<70;i++)deep={overrides:[deep]};
 assert.throws(()=>decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[deep]}),()=>{}),/nesting/);
 assert.throws(()=>decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[node(1,null,'!',{name:'x'.repeat(WIRE_LIMITS.stringBytes+1)})]}),()=>{}),/string size/);
 assert.throws(()=>decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[node(1,null,'!',{name:'x'.repeat(600000),textData:'y'.repeat(600000)})]}),()=>{}),/string size/);
});
test('disk index handles child-before-parent order, hidden subtrees, pagination, cycles and duplicates',async t=>{
 const model=new DiskNetworkSnapshot('test',await directory(t));t.after(()=>model.close());
 model.acceptMessage({type:'JOIN_START'});
 for(const n of [node(4,3),node(2,1,'b'),node(3,1,'a'),node(1),node(5,1,'c',{visible:false}),node(6,5)])model.acceptNode(n);
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 assert.deepEqual(model.query(query).nodes.map(n=>n.id),['1:1','1:3','1:4','1:2']);
 assert.deepEqual(model.query({...query,offset:2,maxNodes:1}).nodes.map(n=>n.id),['1:4']);
 assert.deepEqual(model.query({...query,depth:0}).traversal.pendingDepth,['1:1']);
 assert.equal(model.query({...query,includeHidden:true}).nodes.length,6);
 const cycle=new DiskNetworkSnapshot('test',await directory(t));t.after(()=>cycle.close());
 cycle.acceptMessage({type:'JOIN_START'});cycle.acceptNode(node(1,2));cycle.acceptNode(node(2,1));cycle.acceptMessage({type:'NODE_CHANGES'});cycle.acceptMessage({type:'JOIN_END'});cycle.finish();
 assert.throws(()=>cycle.query(query),/Cycle/);
 const duplicate=new DiskNetworkSnapshot('test',await directory(t));t.after(()=>duplicate.close());duplicate.acceptMessage({type:'JOIN_START'});duplicate.acceptNode(node(1));assert.throws(()=>duplicate.acceptNode(node(1)),/Duplicate/);
});
test('managed reader verifies split parts, serializes callers, guards cleanup, and removes scratch on cancellation/error',async t=>{
 const store=await NetworkStore.create(await directory(t));await capture(store,records([node(1),node(2,1)]));
 const before=await readdir(store.root), abort=new AbortController();
 let started;const ready=new Promise(r=>started=r);
 const pending=readStoredNetworkSnapshot(store,identity,query,abort.signal,m=>{if(m.stage==='worker-start')started();});
 const cancelled=assert.rejects(pending,/cancelled/);
 await ready;
 await assert.rejects(readStoredNetworkSnapshot(store,identity,query),/busy/);
 await assert.rejects(store.clean(),/BUSY/);
 abort.abort();await cancelled;
 assert.deepEqual(await readdir(store.root),before);
 const result=await readStoredNetworkSnapshot(store,identity,query);assert.equal(result.nodes.length,2);assert.deepEqual(result.snapshot,identity);
 await assert.rejects(readStoredNetworkSnapshot(store,identity,{...query,url:query.url.replace('/test/','/other/')}),/does not match/);
 const generation=path.join(store.root,before[0]);await writeFile(path.join(generation,'part-0.bin'),'corrupt');
 await assert.rejects(readStoredNetworkSnapshot(store,identity,query),/Corrupt/);
 assert.deepEqual(await readdir(store.root),before);
});
test('legacy capture streams long escaped values and rejects malformed JSON or duplicate metadata',async t=>{
 const filename=path.join(await directory(t),'probe.json');
 const event={kind:'ignored',name:'a\\"😀'.repeat(20000)};
 await writeFile(filename,JSON.stringify({version:2,events:[event],fileUrl:'https://www.figma.com/design/test/File'}));
 const items=[];for await(const item of probeEvents(filename))items.push(item);assert.deepEqual(items[0].event,event);assert.equal(items.length,2);
 for(const content of ['{"events":[],"version":2,"version":2}', '{"events":[{},]}','{"events":[],}','{"events":[{}]','{"events":[]} false']) {
  await writeFile(filename,content);await assert.rejects(async()=>{for await(const _ of probeEvents(filename)){};});
 }
});

test('selection reader reuses decoding across query options and evicts on node, generation, cleanup and shutdown', async t => {
 const store = await NetworkStore.create(await directory(t));
 t.after(releaseNetworkSelection);
 await capture(store, records([node(3,1,'a',{visible:false}),node(4,3),node(2,1,'b'),node(1)]));
 const first = await readStoredNetworkSnapshot(store,identity,query);
 assert.equal(first.metrics.selectionCacheHit,false);
 assert.deepEqual(first.nodes.map(n=>n.id),['1:1','1:2']);
 const stages=[];
 const second = await readStoredNetworkSnapshot(store,identity,{...query,includeHidden:true,offset:1,maxNodes:2},undefined,m=>stages.push(m.stage));
 assert.equal(second.metrics.selectionCacheHit,true); assert.equal(second.metrics.loadDecodeIndexMs,0);
 assert.deepEqual(stages,[]); assert.deepEqual(second.nodes.map(n=>n.id),['1:3','1:4']);
 assert.equal(second.nodes[1].parentId,'1:3');
 const changed = await readStoredNetworkSnapshot(store,identity,{...query,url:query.url.replace('1-1','1-2')});
 assert.equal(changed.metrics.selectionCacheHit,false); assert.equal(changed.metrics.selectionCache.nodes,1);
 const newer={...identity,generation:2}; const writer=await store.begin(newer);
 const bytes=Buffer.from(records([node(1,null,'!',{name:'new generation'})]).map(v=>JSON.stringify(v)+'\n').join(''));
 await writer.append(0,bytes);await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:1});
 const fresh=await readStoredNetworkSnapshot(store,newer,query);
 assert.equal(fresh.metrics.selectionCacheHit,false);assert.equal(fresh.nodes[0].name,'new generation');
 await store.clean(); assert.equal((await readdir(store.root)).filter(n=>n.startsWith('decode-')).length,0); await assert.rejects(readStoredNetworkSnapshot(store,newer,query),/ENOENT/);
 assert.equal((await readdir(store.root)).filter(n=>n.startsWith('decode-')).length,0);
});
test('selection RAM cache is bounded, spills reads to disk and replaces previous branch',async t=>{
 const model=new DiskNetworkSnapshot('test',await directory(t));t.after(()=>model.close());
 model.acceptMessage({type:'JOIN_START'});model.acceptNode(node(1));
 for(let i=2;i<SELECTION_LIMITS.nodes+20;i++)model.acceptNode(node(i,1,String(i).padStart(6,'0'),{name:'x'.repeat(2000)}));
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const result=model.query(query);const stats=model.selectionCacheStats();
 assert.equal(result.traversal.eligibleRecords,SELECTION_LIMITS.nodes+19);
 assert.ok(stats.nodes<result.traversal.eligibleRecords);assert.ok(stats.bytes<=SELECTION_LIMITS.bytes);
 assert.deepEqual(model.query({...query,offset:2048,maxNodes:1}).nodes.map(n=>n.id),['1:2049']);
 model.query({...query,url:query.url.replace('1-1','1-2')});assert.equal(model.selectionCacheStats().nodes,1);
});

test('signed pages bind snapshot and query, fit UTF-8 budget, and never lose oversized or hidden nodes', async t => {
 const store = await NetworkStore.create(await directory(t));t.after(releaseNetworkSelection);
 await capture(store,records([node(1),...Array.from({length:24},(_,i)=>node(i+2,1,String(i).padStart(3,'0'),{textData:'😀'.repeat(i===5?40000:200),visible:i!==8}))]),65536);
 const options={...query,maxNodes:3,maxBytes:4096};
 let page=await readStoredNetworkSnapshot(store,identity,options), ids=[];
 const firstToken=page.traversal.continuation;let omitted=false;
 for(let i=0;;i++) {
  assert.ok(i<30);assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);
  ids.push(...page.nodes.map(n=>n.id));omitted ||= page.nodes.some(n=>n.propertiesOmitted);
  if(!page.traversal.continuation)break;
  page=await readStoredNetworkSnapshot(store,identity,{...options,continuation:page.traversal.continuation});
 }
 assert.deepEqual(ids,['1:1',...Array.from({length:24},(_,i)=>`1:${i+2}`).filter(id=>id!=='1:10')]);
 assert.equal(new Set(ids).size,ids.length);assert.ok(omitted);
 for(const change of [{depth:0},{includeHidden:true},{maxNodes:4},{maxBytes:5000},{url:query.url.replace('1-1','1-2')},{offset:1},{continuation:firstToken+'x'}]) {
  await assert.rejects(readStoredNetworkSnapshot(store,identity,{...options,continuation:firstToken,...change}),/continuation/);
 }
 // Evicting the worker does not expire a valid continuation for an immutable source.
 await releaseNetworkSelection();
 assert.notEqual((await readStoredNetworkSnapshot(store,identity,{...options,continuation:firstToken})).nodes[0].id,'1:1');
 const newer={...identity,generation:2};const writer=await store.begin(newer);
 await writer.append(0,Buffer.from(records([node(1),node(2,1)]).map(v=>JSON.stringify(v)+'\n').join('')));
 await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:1});
 await assert.rejects(readStoredNetworkSnapshot(store,newer,{...options,continuation:firstToken}),/stale continuation/);
 const shallow=await readStoredNetworkSnapshot(store,identity,{...options,depth:0});
 assert.equal(shallow.traversal.continuation,null);assert.equal(shallow.traversal.pendingDepthCount,1);
});

test('managed layout uses parent axis outside selection without retaining that parent in the RAM cache', async t => {
 const store = await NetworkStore.create(await directory(t));t.after(releaseNetworkSelection);
 await capture(store,records([node(1,null,'!',{stackMode:'HORIZONTAL'}),node(2,1,'!',{stackMode:'VERTICAL',stackChildAlignSelf:'STRETCH',stackCounterSizing:'FIXED',stackPrimarySizing:'RESIZE_TO_FIT'})]));
 const result=await readStoredNetworkSnapshot(store,identity,{...query,url:query.url.replace('1-1','1-2')});
 assert.equal(result.nodes[0].layout.sizing.height.mode,'fill');assert.equal(result.nodes[0].layout.sizing.width.mode,'fixed');
 assert.equal(result.nodes[0].layout.parentDirection,'row');assert.equal(result.metrics.selectionCache.nodes,1);
 assert.equal(result.nodes[0].layout.geometry.size,null);assert.equal(result.nodes[0].layout.css.width,undefined);
});

test('default context preserves useful layout, hides wire diagnostics and shares the selection cache with debug', async t => {
 const store=await NetworkStore.create(await directory(t));t.after(releaseNetworkSelection);
 await capture(store,records([node(1,null,'!',{stackMode:'HORIZONTAL',stackPrimarySizing:'FIXED',stackCounterSizing:'RESIZE_TO_FIT'}),node(2,1,'!',{textData:'Hello',stackChildPrimaryGrow:1})]));
 const options={...query,format:undefined,maxNodes:1};
 const first=await readStoredNetworkSnapshot(store,identity,options);
 assert.equal(first.live,false);assert.deepEqual(first.snapshot,identity);
 for(const key of ['metrics','documentRecords','initialBatches']) assert.equal(first[key],undefined);
 assert.equal(first.nodeCount,1);assert.equal(first.childrenTruncated,true);
 assert.equal(first.nodes[0].stackMode,undefined);assert.equal(first.nodes[0].layout.source.stackMode,undefined);
 assert.equal(first.nodes[0].layout.source.Flow,'Horizontal');
 assert.equal(first.nodes[0].layout.css.display,'flex');
 assert.equal(first.nodes[0].layout.sizing.height.mode,'hug');
 assert.equal(first.nodes[0].properties[0].section,'properties-inspection-panel');
 assert.equal(first.nodes[0].layout.copyText,undefined);
 assert.ok(first.nodes[0].layout.unresolved.length);
 const second=await readStoredNetworkSnapshot(store,identity,{...options,continuation:first.traversal.continuation});
 assert.equal(second.nodes[0].id,'1:2');assert.equal(second.nodes[0].parentId,'1:1');
 assert.equal(second.nodes[0].text,'Hello');assert.equal(second.nodes[0].textData,undefined);
 assert.equal(second.nodes[0].layout.sizing.width.mode,'fill');assert.equal(second.nodes[0].layout.css.width,undefined);
 assert.equal(second.traversal.complete,true);assert.equal(second.truncated,false);
 await assert.rejects(readStoredNetworkSnapshot(store,identity,{...options,format:'debug',continuation:first.traversal.continuation}),/continuation/);
 const debug=await readStoredNetworkSnapshot(store,identity,query);
 const context=await readStoredNetworkSnapshot(store,identity,{...query,format:'context'});
 assert.equal(context.metrics,undefined);
 const again=await readStoredNetworkSnapshot(store,identity,query);
 assert.equal(again.metrics.selectionCacheHit,true);
 assert.equal(debug.nodes[0].stackMode,'HORIZONTAL');assert.equal(debug.nodes[0].layout.copyText,undefined);
});

test('monitored reads reject stale continuation, cancel in-flight decoding, and recover only with a new generation', async t => {
 const store=await NetworkStore.create(await directory(t));
 t.after(releaseNetworkSelection);
 async function save(id) {
  const writer=await store.begin(id,undefined,true);
  await writer.append(0,Buffer.from(records([node(1),node(2,1),node(3,1)]).map(v=>JSON.stringify(v)+'\n').join('')));
  await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:1});
 }
 await save(identity);
 await assert.rejects(readStoredNetworkSnapshot(store,identity,query),/STALE/);
 const owner=store.observe(identity);
 const page=await readStoredNetworkSnapshot(store,identity,{...query,maxNodes:1});
 assert.equal(page.freshness.status,'observed');assert.ok(page.traversal.continuation);
 owner.abort(new Error('STALE: multiplayer changed'));
 await assert.rejects(readStoredNetworkSnapshot(store,identity,{...query,maxNodes:1,continuation:page.traversal.continuation}),/STALE|busy/);
 // Idle invalidation disposes asynchronously; await the worker cleanup before recovery.
 for(let i=0;i<100;i++) { try { await releaseNetworkSelection(); break; } catch { await new Promise(r=>setTimeout(r,5)); } }
 const next={...identity,generation:2};await save(next);const nextOwner=store.observe(next);
 await assert.rejects(readStoredNetworkSnapshot(store,identity,query),/STALE/);
 const recovered=await readStoredNetworkSnapshot(store,next,query);
 assert.equal(recovered.nodes.length,3);assert.equal(recovered.freshness.snapshot.generation,2);
 await releaseNetworkSelection();
 let invalidated=false;
 await assert.rejects(readStoredNetworkSnapshot(store,next,query,undefined,()=>{
  if(!invalidated){invalidated=true;nextOwner.abort(new Error('STALE: disconnected during read'));}
 }),/STALE/);
 assert.equal(invalidated,true);
});

test('historical stored captures explicitly disclaim current freshness',async t=>{
 const store=await NetworkStore.create(await directory(t));t.after(releaseNetworkSelection);
 await capture(store,records([node(1)]));
 assert.equal((await readStoredNetworkSnapshot(store,identity,query)).freshness.status,'historical');
});

test('shutdown cancels cold reads, awaits scratch cleanup, and permits repeated lifecycle cycles', async t => {
 const store = await NetworkStore.create(await directory(t));
 await capture(store, records([node(1), node(2, 1)]));
 const before = await readdir(store.root);
 for (let i = 0; i < 3; i++) {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const pending = readStoredNetworkSnapshot(store, identity, query, undefined, m => { if (m.stage === 'worker-start') started(); });
  const rejected = assert.rejects(pending, /cancelled/);
  await ready;
  await Promise.all([stopNetworkSelection(), stopNetworkSelection(), rejected]);
  assert.deepEqual(await readdir(store.root), before);
 }
 await readStoredNetworkSnapshot(store, identity, query);
 await stopNetworkSelection();
 assert.deepEqual(await readdir(store.root), before);
 await store.clean();
});
