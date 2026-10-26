import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile,writeFile,rm,symlink,link } from 'node:fs/promises';
import path from 'node:path';
import { defaultBinary } from '../scripts/rust-helper/host.mjs';
import { nativeSession, compatibleInflater, compatibleInput } from '../scripts/rust-helper/stage6-host.mjs';
import { workspace,nodeInput,hash } from '../scripts/rust-helper/stage6-common.mjs';
import { inflateFrame } from '../dist/network.js';
import { fixtures,wireCapture } from '../scripts/rust-corpus/fixtures.mjs';
import { zstd } from './wire-fixture.mjs';
const collect=async iterable=>{const values=[];for await(const value of iterable)values.push(value);return values;};
const native={skip:existsSync(defaultBinary)?false:'Release Rust helper not built'};
const record=(overrides={})=>({version:1,kind:'ws-received',session:'😀русский',requestId:'日本語',eventSequence:0,opcode:2,payload:'AQID',...overrides});
async function rustInput(w) {const s=nativeSession('input-stream',w.config);try{return await collect(s.records());}finally{await s.destroy();}}
async function parity(w) {
 const capture=async fn=>{try{return {ok:true,data:(await fn()).map(b=>b.toString('hex'))};}catch{return {ok:false};}};
 const a=await capture(()=>collect(nodeInput(w))),b=await capture(()=>rustInput(w));assert.deepEqual(b,a);return a;
}
test('stage6 managed records: split every byte, Unicode, exact bytes and ordered corpus',native,async()=>{
 for(const f of fixtures().filter(f=>f.layer==='wire')) {
  const {records}=wireCapture(f.nodes);const w=await workspace(records,{chunkSize:f.id==='small'?1:262144});
  try{assert.equal((await parity(w)).ok,true);}finally{await rm(w.project,{recursive:true,force:true});}
 }
 const w=await workspace([record()],{chunkSize:1});try{assert.equal((await parity(w)).ok,true);}finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage6 managed invalid records and incomplete tails reject identically',native,async()=>{
 const cases=[record({version:2}),record({opcode:1}),record({eventSequence:1}),record({session:'😀'.repeat(129)}),record({payload:'AQI='+'\n'}),record({payload:'AB=='}),record({payload:''}),record({payload:4}),record({kind:'ws-sent'})];
 for(const r of cases){const w=await workspace([r]);try{assert.equal((await parity(w)).ok,false);}finally{await rm(w.project,{recursive:true,force:true});}}
 for(const raw of [Buffer.from(JSON.stringify(record())),Buffer.from('{\xff}\n','latin1'),Buffer.from('{}\n'),Buffer.from('\n')]){
  const w=await workspace([],{raw});try{assert.equal((await parity(w)).ok,false);}finally{await rm(w.project,{recursive:true,force:true});}
 }
 const w=await workspace([record(),record({eventSequence:1,requestId:'other'})]);try{assert.equal((await parity(w)).ok,false);}finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage6 checks part digest, size, symlinks, hardlinks and manifest identity',native,async()=>{
 for(const mutation of ['hash','size','symlink','hardlink','identity','extra','missing']){
  const w=await workspace([record()]);try{
   const file=path.join(w.directory,'part-0.bin');
   if(mutation==='hash')await writeFile(file,Buffer.alloc(w.data.length,32));
   if(mutation==='size')await writeFile(file,Buffer.alloc(8*1024*1024+1));
   if(mutation==='symlink'||mutation==='hardlink'){const outside=path.join(w.project,'copy');await writeFile(outside,w.data);await rm(file);await (mutation==='symlink'?symlink:link)(outside,file);}
   if(mutation==='identity'||mutation==='extra'){const p=path.join(w.directory,'ready.json'),m=JSON.parse(await readFile(p));if(mutation==='identity')m.snapshot.generation++;else m.extra=true;await writeFile(p,JSON.stringify(m));}
   if(mutation==='missing')await rm(file);
   assert.equal((await parity(w)).ok,false,mutation);
  }finally{await rm(w.project,{recursive:true,force:true});}
 }
});
async function inflateParity(data,limit=64*1024*1024){
 let expected;try{expected={ok:true,data:Buffer.from(inflateFrame(data,limit))};}catch{expected={ok:false};}
 const s=await compatibleInflater();let actual;
 try{actual={ok:true,data:await s.inflate(data,limit)};}catch{actual={ok:false};}finally{await s.destroy();}
 assert.equal(actual.ok,expected.ok);if(expected.ok)assert.equal(hash(actual.data),hash(expected.data));return expected;
}
test('stage6 Zstandard raw/RLE/checksum, limits, truncation and malformed frames',native,async()=>{
 const raw=zstd(Buffer.from('hello 😀'));assert.equal((await inflateParity(raw)).ok,true);
 for(let n=0;n<raw.length;n++)assert.equal((await inflateParity(raw.subarray(0,n))).ok,false);
 for(const extra of [Buffer.from([0]),raw])assert.equal((await inflateParity(Buffer.concat([raw,extra]))).ok,false);
 for(const flag of [1,8,16]){const b=Buffer.from(raw);b[4]|=flag;assert.equal((await inflateParity(b)).ok,false);}
 assert.equal((await inflateParity(raw,Buffer.byteLength('hello 😀'))).ok,true);assert.equal((await inflateParity(raw,1)).ok,false);
 const checksum=Buffer.concat([raw,Buffer.alloc(4,255)]);checksum[4]|=4;assert.equal((await inflateParity(checksum)).ok,true);
 const empty=Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,0,1,0,0]);assert.equal((await inflateParity(empty)).ok,true);
 const rle=Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,10,83,0,0,42]);assert.equal((await inflateParity(rle)).ok,true);
 const invalidBlock=Buffer.from(raw);invalidBlock[6]=7;assert.equal((await inflateParity(invalidBlock)).ok,false);
 const unknown=Buffer.from([0x28,0xb5,0x2f,0xfd,0,0,1,0,0]);assert.equal((await inflateParity(unknown)).ok,false);
 const huge=Buffer.from([0x28,0xb5,0x2f,0xfd,0xe0,255,255,255,255,255,255,255,255,1,0,0]);assert.equal((await inflateParity(huge)).ok,false);
});
test('stage6 real compressed frames and deterministic payload damage',native,async t=>{
 const file='.cache/figma-network/rust-corpus-real/probe.json';if(!existsSync(file)){t.skip('Private real corpus unavailable');return;}
 const probe=JSON.parse(await readFile(file));let tested=0;
 for(const e of probe.events){if(e.kind!=='ws-received'||e.opcode!==2)continue;let b=Buffer.from(e.payload,'base64');if(b.subarray(0,8).toString()==='fig-wire')b=b.subarray(12);if(b.readUInt32LE(0)!==0xfd2fb528)continue;
  await inflateParity(b);tested++;
  for(const index of [Math.floor(b.length/2),b.length-1]){const damaged=Buffer.from(b);damaged[index]^=255;await inflateParity(damaged);}
 }
 assert.ok(tested>0);
});
test('stage6 cancellation reaps subprocess and subsequent session works',native,async()=>{
 const c=new AbortController(),s=nativeSession('inflate-stream',undefined,{signal:c.signal});c.abort();
 await assert.rejects(s.close(),{code:'ABORTED'});assert.throws(()=>process.kill(s.pid,0),{code:'ESRCH'});
 await inflateParity(zstd(Buffer.from('recovered')));
});

test('stage6 JSON.parse compatibility fallback preserves prior records and lone surrogates',native,async()=>{
 const cases=[JSON.stringify(record({session:'\ud800'}))+'\n', '\ufeff'+JSON.stringify(record())+'\n', JSON.stringify(record()).slice(0,-1)+',"extra":'+ '['.repeat(140)+'0'+']'.repeat(140)+'}\n'];
 for(const raw of cases){const w=await workspace([],{raw:Buffer.from(raw)});let fallback=0;try{
  const actual=await w.store.withRead(()=>collect(compatibleInput(w,{onFallback:()=>fallback++})));
  assert.deepEqual(actual,await collect(nodeInput(w)));assert.equal(fallback,1);
 }finally{await rm(w.project,{recursive:true,force:true});}}
 const w=await workspace([record(),record({eventSequence:1,extra:'\ud800'})]);let fallback=0;try{
  assert.deepEqual(await w.store.withRead(()=>collect(compatibleInput(w,{onFallback:()=>fallback++}))),await collect(nodeInput(w)));assert.equal(fallback,1);
 }finally{await rm(w.project,{recursive:true,force:true});}
});

test('stage6 exact record and payload limits, window limit and JS numeric spelling',native,async()=>{
 const max=24*1024*1024+4096;
 for(const excess of [0,1]){
  const text=JSON.stringify(record({payload:'A'.repeat(24*1024*1024)}));
  const raw=Buffer.from(text+' '.repeat(max-Buffer.byteLength(text)+excess)+'\n');
  const w=await workspace([],{raw,chunkSize:8*1024*1024});
  try{assert.equal((await parity(w)).ok,excess===0);}finally{await rm(w.project,{recursive:true,force:true});}
 }
 const window=Buffer.concat([Buffer.from([0x28,0xb5,0x2f,0xfd,0x40,0,0,0,3,8,0]),Buffer.from([42])]);
 assert.equal((await inflateParity(window,1024)).ok,true);assert.equal((await inflateParity(window,1023)).ok,false);
 const raw=Buffer.from(JSON.stringify(record()).replace('"version":1','"version":1e0').replace('"opcode":2','"opcode":2.0')+'\n');
 const w=await workspace([],{raw});try{assert.equal((await parity(w)).ok,true);}finally{await rm(w.project,{recursive:true,force:true});}
});

test('stage6 legacy probe remains a separate Node compatibility path',native,async()=>{
 const {probeEvents}=await import('../dist/network-source.js');
 const {probe,records}=wireCapture(fixtures()[0].nodes);const w=await workspace(records);
 try{
  const filename=path.join(w.project,'legacy.json');await writeFile(filename,JSON.stringify(probe));
  const received=[];let metadata;
  for await(const item of probeEvents(filename)){if(item.metadata)metadata=item.metadata;if(item.event?.kind==='ws-received')received.push(Buffer.from(item.event.payload,'base64'));}
  assert.deepEqual(received,await collect(nodeInput(w)));assert.equal(metadata.version,probe.version);
  const helper=await compatibleInflater();try{for(const b of received){const data=b.subarray(0,8).toString()==='fig-wire'?b.subarray(12):b;assert.equal(hash(await helper.inflate(data,64*1024*1024)),hash(inflateFrame(data)));}}finally{await helper.destroy();}
 }finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage6 stream timeout and malformed packet terminate without leftover processes',native,async()=>{
 const s=nativeSession('inflate-stream',undefined,{timeoutMs:20});await new Promise(r=>setTimeout(r,40));
 await assert.rejects(s.close(),{code:'TIMEOUT'});assert.throws(()=>process.kill(s.pid,0),{code:'ESRCH'});
 const {spawnSync}=await import('node:child_process');const h=Buffer.alloc(8);h.writeUInt32LE(0xffffffff);
 const result=spawnSync(defaultBinary,['--stage6','inflate-stream'],{input:h,timeout:2000});assert.equal(result.status,1);assert.match(result.stderr.toString(),/Invalid packet size/);
});
