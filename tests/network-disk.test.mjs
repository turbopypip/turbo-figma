import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { BoundedWireDecoder, WIRE_LIMITS } from '../dist/network-wire.js';
import { DiskNetworkSnapshot } from '../dist/network-disk.js';
import { nodeFields } from '../dist/network.js';
import { NetworkStore } from '../dist/network-store.js';
import { readStoredNetworkSnapshot } from '../dist/network-reader.js';
import { probeEvents } from '../dist/network-source.js';
import { zstd } from './wire-fixture.mjs';
const schema = parseSchema(`
 enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
 enum Phase { CREATED = 0; UPDATED = 1; }
 struct Guid { uint sessionID; uint localID; }
 struct Parent { Guid guid; string position; }
 message NodeChange { Guid guid = 1; Phase phase = 2; Parent parentIndex = 3; string name = 4; bool visible = 5; NodeChange[] overrides = 6; byte[] ignored = 7; string textData = 8; }
 message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
`);
const codec = compileSchema(schema), wireSchema = encodeBinarySchema(schema);
const guid = n => ({ sessionID: 1, localID: n });
const node = (n, parent, position='!', extra={}) => ({guid:guid(n),phase:'CREATED',name:`node ${n}`, ...(parent ? {parentIndex:{guid:guid(parent),position}} : {}),...extra});
const query = {url:'https://www.figma.com/design/test/File?node-id=1-1',depth:50,maxNodes:500,offset:0,includeHidden:false};
const identity={fileKey:'test',sessionId:'test',generation:1};
async function directory(t) { const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'disk-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }
function records(nodes) {
 const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 return [Buffer.concat([header,zstd(wireSchema)]),...[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:nodes},{type:'JOIN_END'}].map(m=>zstd(codec.encodeMessage(m)))].map((b,eventSequence)=>({version:1,kind:'ws-received',session:'main',requestId:'1',eventSequence,opcode:2,payload:b.toString('base64')}));
}
async function capture(store, values) {
 const writer=await store.begin(identity);let i=0;
 const data=Buffer.from(values.map(v=>JSON.stringify(v)+'\n').join(''));
 for(let offset=0;offset<data.length;offset+=97) await writer.append(i++,data.subarray(offset,offset+97));
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
