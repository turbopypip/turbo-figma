import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {rm,readFile,mkdtemp,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fixtures,wireCapture,query,guid} from '../scripts/rust-corpus/fixtures.mjs';
import {workspace} from '../scripts/rust-helper/stage6-common.mjs';
import {rustBinary,RustSnapshot} from '../dist/network-rust.js';
import {readStoredNetworkSnapshot,releaseNetworkSelection,stopNetworkSelection} from '../dist/network-reader.js';
const native={skip:existsSync(rustBinary)?false:'Release helper not built'};
if(process.env.REQUIRE_RUST_HELPER&&!existsSync(rustBinary))throw Error('Release helper required');
const normalize=x=>JSON.parse(JSON.stringify(x,(k,v)=>k==='metrics'||k==='continuation'?undefined:v));
async function read(w,mode,q={}) {
 process.env.FIGMA_NETWORK_BACKEND=mode;
 return readStoredNetworkSnapshot(w.store,w.snapshot,{...query,...q});
}
async function cleanup(w) {await stopNetworkSelection();delete process.env.FIGMA_NETWORK_BACKEND;delete process.env.FIGMA_RUST_BINARY;await rm(w.project,{recursive:true,force:true});}

test('runtime public context and debug parity, retained cache, pagination and native process cleanup',native,async()=>{
 for(const f of fixtures().filter(f=>f.layer==='wire')) {
  const w=await workspace(wireCapture(f.nodes).records);let pid;
  try {
   for(const format of ['context','debug']) {
    const q={format,maxNodes:7,maxBytes:6000};
    const expected=await read(w,'node',q);await releaseNetworkSelection();
    const actual=await read(w,'rust',q);assert.deepEqual(normalize(actual),normalize(expected),f.id);
    const debug=await read(w,'rust',{format:'debug',maxNodes:1});
    assert.equal(debug.metrics.backend,'rust');assert.equal(debug.metrics.rustFallback,undefined);pid=debug.metrics.rustPid;assert.ok(pid);
    assert.equal(debug.metrics.selectionCacheHit,true);
    const next=actual.traversal.continuation;
    if(next){const page=await read(w,'rust',{...q,continuation:next});await releaseNetworkSelection();const reference=await read(w,'node',{...q,offset:actual.nodes.length});assert.deepEqual(normalize(page),normalize(reference),f.id+' next');}
    await releaseNetworkSelection();assert.throws(()=>process.kill(pid,0));
   }
  }finally{await cleanup(w);}
 }
});

test('runtime real capture full design-context pagination matches Node including instances and variables',native,async t=>{
 const file='.cache/figma-network/rust-corpus-real/probe.json';if(!existsSync(file)){t.skip('Private real corpus unavailable');return;}
 const p=JSON.parse(await readFile(file));const w=await workspace(p.events.filter(e=>e.kind==='ws-received').map((e,eventSequence)=>({version:1,kind:'ws-received',session:'real',requestId:'real',opcode:2,eventSequence,payload:e.payload})));
 try {
  for(const root of ['3215:21227','3215:21204']) {
   const q={url:`https://www.figma.com/design/corpus/File?node-id=${root.replace(':','-')}`,maxNodes:7,maxBytes:24000};
   const pages=async mode=>{const all=[];let continuation;do{const r=await read(w,mode,{...q,continuation});all.push(normalize(r));continuation=r.traversal.continuation;assert.ok(all.length<100);}while(continuation);return all;};
   const expected=await pages('node');await releaseNetworkSelection();
   const actual=await pages('rust');assert.deepEqual(actual,expected);
   const debug=await read(w,'rust',{...q,format:'debug'});assert.equal(debug.metrics.backend,'rust');assert.equal(debug.metrics.rustFallback,undefined);
   await releaseNetworkSelection();
  }
 }finally{await cleanup(w);}
});

test('runtime native index supports retained live storage mutations and ordering',native,async()=>{
 const w=await workspace(wireCapture(fixtures()[0].nodes).records);let session;
 try {
  const scratch=await mkdtemp(path.join(w.store.root,'decode-'));session=await RustSnapshot.open(w.store.root,w.snapshot,scratch);
  const call=async q=>{const r=await session.request(q);assert.equal(r.error,undefined);return r.result;};
  await call({op:'select',id:'1:1'});
  const old=await call({op:'node',id:'1:2'});
  await call({op:'upsert',node:{...old,name:'Updated',parentIndex:{guid:guid(1),position:'z'}}});
  assert.equal((await call({op:'node',id:'1:2'})).name,'Updated');assert.equal((await call({op:'children',id:'1:1'})).at(-1),'1:2');
  await call({op:'upsert',node:{...old,guid:guid(99),parentIndex:{guid:guid(1),position:'0'}}});
  assert.equal((await call({op:'children',id:'1:1'}))[0],'1:99');
  await call({op:'upsert',node:{...old,parentIndex:{guid:guid(99),position:'0'}}});
  assert.equal((await call({op:'children',id:'1:1'})).includes('1:2'),false);
  assert.deepEqual(await call({op:'children',id:'1:99'}),['1:2']);
  await call({op:'remove',id:'1:2'});assert.deepEqual(await call({op:'children',id:'1:99'}),[]);
 }finally{await session?.destroy();await cleanup(w);}
});

test('runtime missing binary and native JSON incompatibility fall back transactionally',native,async()=>{
 for(const missing of [true,false]) {
  const records=wireCapture(fixtures()[0].nodes).records;if(!missing)records[2].unknown='\ud800';
  const w=await workspace(records);
  try {
   const expected=await read(w,'node',{format:'debug'});await releaseNetworkSelection();
   if(missing)process.env.FIGMA_RUST_BINARY=path.join(w.project,'missing');
   const actual=await read(w,'rust',{format:'debug'});assert.equal(actual.metrics.backend,'node');assert.ok(actual.metrics.rustFallback);assert.deepEqual(normalize(actual),normalize(expected));
   await releaseNetworkSelection();assert.equal((await readdir(w.store.root)).filter(n=>n.startsWith('decode-')).length,0);
  }finally{await cleanup(w);}
 }
});

test('runtime cancellation, native crash and retained release remove processes and scratch',native,async()=>{
 const w=await workspace(wireCapture(fixtures().find(f=>f.id==='beyond-selection-cache').nodes).records);
 try {
  process.env.FIGMA_NETWORK_BACKEND='rust';const abort=new AbortController();
  const pending=readStoredNetworkSnapshot(w.store,w.snapshot,query,abort.signal);setTimeout(()=>abort.abort(),10);
  await assert.rejects(pending,/cancel/i);
  assert.equal((await readdir(w.store.root)).filter(n=>n.startsWith('decode-')).length,0);
  const r=await read(w,'rust',{format:'debug',maxNodes:1});const pid=r.metrics.rustPid;assert.ok(pid);process.kill(pid,'SIGKILL');
  await assert.rejects(read(w,'rust'),/Rust|exit|SIGKILL/);
  assert.throws(()=>process.kill(pid,0));
  assert.equal((await readdir(w.store.root)).filter(n=>n.startsWith('decode-')).length,0);
 }finally{await cleanup(w);}
});

test('runtime read batches are bounded, reject writes and do not hide lookup errors',native,async()=>{
 const nodes=fixtures()[0].nodes.slice(0,5).map(n=>({...n,name:'x'.repeat(300000)}));
 const w=await workspace(wireCapture(nodes).records);let session;
 try {
  const scratch=await mkdtemp(path.join(w.store.root,'decode-'));session=await RustSnapshot.open(w.store.root,w.snapshot,scratch);
  const r=await session.request({op:'batch',requests:nodes.map(n=>({op:'node',id:`1:${n.guid.localID}`}))});
  assert.equal(r.error,undefined);assert.ok(r.result.length>0&&r.result.length<5);assert.ok(Buffer.byteLength(JSON.stringify(r.result))<=1024*1024);
  assert.match((await session.request({op:'batch',requests:[{op:'remove',id:'1:1'}]})).error,/Invalid read batch/);
  assert.equal((await session.request({op:'node',id:'1:1'})).result.name.length,300000);
  const missing=await session.request({op:'batch',requests:[{op:'node',id:'1:999'}]});assert.deepEqual(missing.result,[]);
  assert.match((await session.request({op:'node',id:'1:999'})).error,/not present/);
 }finally{await session?.destroy();await cleanup(w);}
});
