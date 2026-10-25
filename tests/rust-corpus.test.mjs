import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fixtures,wireCapture,codec,schemaBytes,query,SEED} from '../scripts/rust-corpus/fixtures.mjs';
import {normalize,compare,collectPages} from '../scripts/rust-corpus/compare.mjs';
import {BoundedWireDecoder} from '../dist/network-wire.js';
import {nodeFields} from '../dist/network.js';
import {DiskNetworkSnapshot} from '../dist/network-disk.js';

test('corpus seed gives identical bytes; wire corpus retains Unicode and skips excluded blobs',()=>{
 assert.equal(SEED,20261025);
 const a=fixtures(),b=fixtures();
 for(let i=0;i<a.length;i++)if(a[i].layer==='wire')assert.deepEqual(wireCapture(a[i].nodes),wireCapture(b[i].nodes));
 const decoder=new BoundedWireDecoder(schemaBytes,nodeFields);
 for(const id of ['unicode-text-style','excluded-blob']) {
  const f=a.find(f=>f.id===id),nodes=[];
  decoder.decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:f.nodes}),n=>nodes.push(n));
  assert.equal(nodes.length,f.nodes.length);
  assert.equal(nodes[0].ignored,undefined);
  if(id==='unicode-text-style'){assert.equal(nodes[1].name,f.nodes[1].name);assert.equal(nodes[1].textData,f.nodes[1].textData);assert.equal(nodes[1].opacity,0);}
 }
 assert.ok(a.find(f=>f.id==='beyond-selection-cache').nodes.length>2048);
});

test('normalization only changes explicit volatile paths and preserves semantic regressions',()=>{
 const base={capturedAt:'2026-10-25T00:00:00Z',snapshot:{generation:1},freshness:{revision:0},nodes:[{id:'1:1',name:'a',opacity:0},{id:'1:2',name:'b'}],traversal:{continuation:'abc.def',complete:false,nextOffset:2},error:'STALE'};
 compare(normalize(base),base);
 compare(base,{...base,capturedAt:'2026-10-26T00:00:00Z',traversal:{...base.traversal,continuation:'xyz.sig'}});
 for(const changed of [
  {...base,nodes:[...base.nodes].reverse()}, {...base,error:'Other'},
  {...base,freshness:{revision:1}}, {...base,snapshot:{generation:2}},
  {...base,traversal:{...base.traversal,continuation:null}},
  {...base,nodes:[{...base.nodes[0],opacity:1},base.nodes[1]]},
  {...base,traversal:{...base.traversal,complete:true}},
 ])assert.throws(()=>compare(base,changed));
 assert.throws(()=>normalize({...base,traversal:{continuation:123}}));
 assert.throws(()=>normalize({...base,capturedAt:'invalid'}));
});

test('page collector rejects duplicates, stalled offsets and an incomplete node count',async()=>{
 const page={nodes:[{id:'1:1'}],traversal:{nextOffset:null,eligibleRecords:2}};
 await assert.rejects(collectPages(async()=>page,{}));
 await assert.rejects(collectPages(async()=>({...page,traversal:{nextOffset:0}}),{}),/stalled/);
 await assert.rejects(collectPages(async()=>({...page,traversal:{nextOffset:1}}),{}),/Duplicate/);
});

test('semantic corpus independently checks overrides, variables, hidden branches and live final state',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});
 for(const id of ['hidden-order','instances-overrides','variables-alias-mode','variables-missing','live-supported']) {
  const f=fixtures().find(f=>f.id===id),dir=await mkdtemp(path.join(root,'corpus-'));
  const m=new DiskNetworkSnapshot('corpus',dir);
  try {
   m.acceptMessage({type:'JOIN_START'});for(const n of f.nodes)m.acceptNode(n);m.acceptMessage({type:'NODE_CHANGES'});m.acceptMessage({type:'JOIN_END'});m.finish();
   let p=m.query(query);
   if(id==='hidden-order')assert.deepEqual(p.nodes.map(n=>n.id),['1:1','1:2']);
   if(id==='instances-overrides')assert.deepEqual(p.nodes.map(n=>n.id),['1:1','1:2','I1:2;1:201']);
   if(id==='variables-alias-mode')assert.equal(p.nodes[1].layout.geometry.size.width,16);
   if(id==='variables-missing')assert.equal(p.nodes[0].style.nativeBindings.references[0].status,'unresolved');
   if(id==='live-supported'){for(const changes of f.live)m.applyLive(changes);p=m.query(query);assert.deepEqual(p.nodes.map(n=>n.id),['1:1','1:3']);assert.equal(p.appliedLiveBatches,3);}
  } finally {m.close();await rm(dir,{recursive:true,force:true});}
 }
});

test('freezing verifies hashes and creates replayable managed parts without config files',async()=>{
 const {freeze}=await import('../scripts/rust-corpus/freeze.mjs');
 const {writeFile,readFile,readdir}=await import('node:fs/promises');
 const {createHash}=await import('node:crypto');
 const root=await mkdtemp(path.resolve('.cache/figma-network/tests/freeze-'));
 try {
  const source=path.join(root,'source');await mkdir(source);
  const {records}=wireCapture(fixtures()[0].nodes);
  const data=Buffer.from(records.map(r=>JSON.stringify(r)+'\n').join(''));
  const manifest={version:1,status:'ready',snapshot:{fileKey:'corpus',sessionId:'synthetic',generation:1},parts:[{bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}]};
  await writeFile(path.join(source,'ready.json'),JSON.stringify(manifest));await writeFile(path.join(source,'part-0.bin'),data);
  await writeFile(path.join(source,'config.json'),'must not copy');
  const output=path.join(root,'frozen');await freeze(source,output);
  assert.deepEqual((await readdir(output)).sort(),['part-0.bin','probe.json','ready.json']);
  const p=JSON.parse(await readFile(path.join(output,'probe.json')));assert.equal(p.events.length,records.length+1);
  await writeFile(path.join(source,'part-0.bin'),'corrupt');
  await assert.rejects(freeze(source,path.join(root,'corrupt')),/Corrupt part/);
  await assert.rejects(readFile(path.join(root,'corrupt','ready.json')),{code:'ENOENT'});
 } finally {await rm(root,{recursive:true,force:true});}
});

test('corrupt corpus inputs fail in the real worker with explicit reasons; cancellation stays explicit',async()=>{
 const {damagedCaptures}=await import('../scripts/rust-corpus/fixtures.mjs');
 const {readNetworkSnapshot,releaseNetworkSelection}=await import('../dist/network-reader.js');
 const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.resolve('.cache/figma-network/tests/corpus-errors-'));
 try {
  for(const f of damagedCaptures()) {
   const captureFile=path.join(dir,`${f.id}.json`);await writeFile(captureFile,JSON.stringify(f.probe));
   await assert.rejects(readNetworkSnapshot({...query,captureFile}),new RegExp(f.error,'i'));await releaseNetworkSelection();
  }
  const controller=new AbortController();controller.abort();
  await assert.rejects(readNetworkSnapshot({...query,captureFile:path.join(dir,'unused.json')},controller.signal),/Request cancelled/);
 }finally{await releaseNetworkSelection();await rm(dir,{recursive:true,force:true});}
});
