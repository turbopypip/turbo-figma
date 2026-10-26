import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {defaultBinary} from '../scripts/rust-helper/host.mjs';
import {nodeJob,rustJob,rawQuery,writeModel} from '../scripts/rust-helper/stage8-host.mjs';
import {fixtures,wireCapture,guid} from '../scripts/rust-corpus/fixtures.mjs';
import {workspace} from '../scripts/rust-helper/stage6-common.mjs';
const native={skip:existsSync(defaultBinary)?false:'Release helper not built'};
if(process.env.REQUIRE_RUST_HELPER&&!existsSync(defaultBinary))throw Error('Release helper required');
async function compare(c){const a=[],b=[];let ae,be;try{await nodeJob(c,x=>a.push(x));}catch(e){ae=e;}try{await rustJob(c,x=>b.push(x));}catch(e){be=e;}assert.equal(!!be,!!ae,`${be?.message} / ${ae?.message}`);if(ae){assert.equal(be.message,ae.message);return {a,b,error:ae};}assert.deepEqual(b.filter(x=>x.kind==='reply').map(x=>x.reply),a.filter(x=>x.kind==='reply').map(x=>x.reply));for(const x of b){assert.ok(x.stats.cache.nodes<=2048);assert.ok(x.stats.cache.bytes<=4*1024*1024);}return {a,b};}
async function model(nodes,commands){await mkdir('.cache/figma-network',{recursive:true});const dir=await mkdtemp(path.resolve('.cache/figma-network/stage8-test-'));try{const file=path.join(dir,'model');await writeModel(file,nodes);return await compare({model:file,commands});}finally{await rm(dir,{recursive:true,force:true});}}
test('stage8 model corpus: child-before-parent, hidden branches, duplicates, cycles and external dependencies',native,async()=>{
 for(const f of fixtures()){const commands=[rawQuery(),rawQuery('1:1',{includeHidden:true,depth:0}),{op:'children',id:'1:1'},{op:'lookup',id:'1:100'},{op:'lookup',id:'1:102'},rawQuery('1:2'),{op:'release'}];await model(f.nodes,commands);}
});
test('stage8 full Rust managed pipeline agrees on shared wire corpus',native,async()=>{
 for(const f of fixtures().filter(f=>f.layer==='wire')){const w=await workspace(wireCapture(f.nodes).records);try{await w.store.withRead(()=>compare({...w,commands:[rawQuery(),rawQuery('1:1',{offset:5,includeHidden:true}),rawQuery('1:2'),{op:'release'}]}));}finally{await rm(w.project,{recursive:true,force:true});}}
});
test('stage8 sibling ties, UTF-16 position order and reverse paint order',native,async()=>{
 const n=(localID,position)=>({guid:guid(localID),phase:'CREATED',type:'RECTANGLE',parentIndex:{guid:guid(1),position}});
 for(const stackMode of ['VERTICAL','NONE'])await model([n(20,'a'),{...n(3,'a'),guid:{sessionID:10,localID:3}},n(2,'a'),n(10,'a'),n(4,'😀'),n(5,'\ue000'),{guid:guid(1),phase:'CREATED',type:'FRAME',stackMode}], [{op:'children',id:'1:1'},rawQuery()]);
});
test('stage8 cache beyond 2048 nodes, byte cap and 100 selection changes',native,async()=>{
 const f=fixtures().find(f=>f.id==='beyond-selection-cache');const commands=[rawQuery('1:1',{maxNodes:500,maxBytes:1000000}),...Array.from({length:100},(_,i)=>rawQuery(`1:${i%2+1}`,{maxNodes:1})),{op:'release'}];const {b}=await model(f.nodes,commands);assert.ok(b[1].stats.cache.nodes>0 && b[1].stats.cache.nodes<=2048);assert.ok(b[1].stats.cache.bytes>3000000);assert.deepEqual(b.at(-1).stats.cache,{nodes:0,bytes:0});
 const nodes=f.nodes.slice(0,100).map(n=>({...n,name:'😀'.repeat(20000)}));const r=await model(nodes,[rawQuery(),{op:'release'}]);assert.ok(r.b[1].stats.cache.nodes<100);assert.ok(r.b[1].stats.cache.bytes>3000000);
});
test('stage8 traversal limits, missing roots, broken ancestry and depth truncation',native,async()=>{
 const nodes=fixtures()[0].nodes;await model(nodes,[rawQuery('1:999'),rawQuery('1:1',{depth:51}),rawQuery('1:1',{depth:0}),rawQuery('1:1',{offset:-1}),rawQuery('1:1',{maxNodes:0}),rawQuery('1:1',{maxBytes:4096})]);
 await model([{...nodes[0],parentIndex:{guid:guid(999),position:'a'}}],[rawQuery()]);await model(fixtures().find(f=>f.id==='deep-tree').nodes,[rawQuery('1:70'),rawQuery('1:1',{depth:50})]);
});
test('stage8 malformed nodes and disk limits',native,async()=>{
 const n=fixtures()[0].nodes[0];for(const nodes of [[{...n,phase:'REMOVED'}],[{...n,guid:guid(-1)}],[{...n,parentIndex:{guid:guid(2),position:7}}],[{...n,name:'x'.repeat(1048576)}]])await model(nodes,[rawQuery()]);
 const children=Array.from({length:10001},(_,i)=>({...n,guid:guid(i+2),parentIndex:{guid:guid(1),position:'a'}}));await model([n,...children],[{op:'children',id:'1:1'}]);
 const wide=children.slice(0,2100).map(n=>({...n,parentIndex:{...n.parentIndex,position:'x'.repeat(1000)}}));await model([n,...wide],[{op:'children',id:'1:1'}]);
});
test('stage8 real capture selections and external lookup agree without fallback',native,async()=>{
 const file='.cache/figma-network/rust-corpus-real/probe.json';if(!existsSync(file))return;const p=JSON.parse(await readFile(file));const records=p.events.filter(e=>e.kind==='ws-received').map((e,eventSequence)=>({version:1,kind:'ws-received',session:'real',requestId:'real',opcode:2,eventSequence,payload:e.payload}));const w=await workspace(records);
 try{await w.store.withRead(()=>compare({...w,commands:[rawQuery('3215:21227'),rawQuery('3215:21200'),rawQuery('3215:21204'),rawQuery('0:0'),{op:'release'}]}));}finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage8 fallback is transactional; timeout, cancellation and consumer failure clean scratch and reap child',native,async()=>{
 const records=wireCapture(fixtures()[0].nodes).records;records[2].extra='\ud800';const w=await workspace(records);let scratch,pid;
 try{let fallback=0;const a=[],b=[];await nodeJob({...w,commands:[rawQuery()]},x=>a.push(x));await rustJob({...w,commands:[rawQuery()]},x=>b.push(x),{fallback:true,onFallback:()=>fallback++,onScratch:s=>scratch=s,onPid:p=>pid=p});assert.equal(fallback,1);assert.deepEqual(b[1].reply,a[1].reply);assert.equal(existsSync(scratch),false);assert.throws(()=>process.kill(pid,0));
 const opts={onScratch:s=>scratch=s,onPid:p=>pid=p};await assert.rejects(rustJob({...w,commands:[]},()=>{}, {...opts,timeoutMs:0,fallback:true}),{code:'TIMEOUT'});assert.equal(existsSync(scratch),false);assert.throws(()=>process.kill(pid,0));
 const abort=new AbortController();abort.abort();await assert.rejects(rustJob({...w,commands:[]},()=>{}, {...opts,signal:abort.signal,fallback:true}),{code:'ABORTED'});assert.equal(existsSync(scratch),false);
 const good=await workspace(wireCapture(fixtures()[0].nodes).records);try{await assert.rejects(rustJob({...good,commands:[]},()=>{throw Error('Consumer failure');},{...opts,fallback:true}),/Consumer failure/);assert.equal(existsSync(scratch),false);assert.throws(()=>process.kill(pid,0));}finally{await rm(good.project,{recursive:true,force:true});}
 }finally{await rm(w.project,{recursive:true,force:true});}
});

test('stage8 variable asset identity, version, ambiguity and out-of-selection lookup',native,async()=>{
 const base=fixtures()[0].nodes[0];const variable=(n,key,version)=>({...base,guid:guid(n),type:'VARIABLE',key,version});
 await model([base,variable(10,'key','v1'),variable(11,'key','v2'),variable(12,'unique','v1')],[...['v1','v2',undefined].map(version=>({op:'asset',type:'VARIABLE',ref:{key:'key',version}})),{op:'asset',type:'VARIABLE',ref:{key:'unique'}},{op:'lookup',id:'1:12'},{op:'asset',type:'VARIABLE',ref:{key:'x'.repeat(4097)}}]);
});
test('stage8 all raw pages preserve nodes beyond cache; exact JSON byte-boundary and nonfinite normalization',native,async()=>{
 const f=fixtures().find(f=>f.id==='beyond-selection-cache');
 await mkdir('.cache/figma-network',{recursive:true});const dir=await mkdtemp(path.resolve('.cache/figma-network/stage8-pages-'));
 try{const file=path.join(dir,'model');await writeModel(file,f.nodes);const commands=Array.from({length:9},(_,i)=>rawQuery('1:1',{maxNodes:500,maxBytes:1048576,offset:i*500}));const {a,b}=await compare({model:file,commands});const ids=b.slice(1).flatMap(x=>x.reply.result.nodes.map(n=>n.id));assert.equal(ids.length,4097);assert.equal(new Set(ids).size,4097);assert.equal(b.at(-1).reply.result.traversal.nextOffset,null);
 }finally{await rm(dir,{recursive:true,force:true});}
 const nodes=fixtures()[0].nodes.map((n,i)=>({...n,opacity:[-0,NaN,Infinity,-Infinity,1e-7,1e-6,1e20,1e21,1000000000000000100][i]}));
 await model(nodes,Array.from({length:80},(_,i)=>rawQuery('1:1',{maxBytes:4096+i})));
});
test('stage8 managed nonfinite floats follow disk JSON semantics',native,async()=>{
 const values=[NaN,Infinity,-Infinity,-0,1e-30,1e30];const nodes=fixtures()[0].nodes.map((n,i)=>({...n,opacity:values[i%values.length]}));const w=await workspace(wireCapture(nodes).records);
 try{await w.store.withRead(()=>compare({...w,commands:[rawQuery(),rawQuery('1:1',{maxBytes:4096}),{op:'release'}]}));}finally{await rm(w.project,{recursive:true,force:true});}
});
