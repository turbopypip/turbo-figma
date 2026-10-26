import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {parseSchema,encodeBinarySchema,compileSchema,ByteBuffer} from 'kiwi-schema';
import {defaultBinary} from '../scripts/rust-helper/host.mjs';
import {nativeSession} from '../scripts/rust-helper/stage6-host.mjs';
import {unpack,compatibleDecode,nodeDecode} from '../scripts/rust-helper/stage7-host.mjs';
import {workspace} from '../scripts/rust-helper/stage6-common.mjs';
import {BoundedWireDecoder} from '../dist/network-wire.js';
import {nodeFields} from '../dist/network.js';
import {fixtures,wireCapture} from '../scripts/rust-corpus/fixtures.mjs';
const native={skip:existsSync(defaultBinary)?false:'Release helper not built'};
if(process.env.REQUIRE_RUST_HELPER&&!existsSync(defaultBinary))throw Error('Release helper required');
const root=path.resolve('.cache/figma-network');
const schema=body=>parseSchema(`message NodeChange { ${body} } message Message { NodeChange[] nodeChanges = 1; }`);
async function compare(s,messages,fields) {
 await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'stage7-test-'));
 try {
  const b=s instanceof Uint8Array?s:encodeBinarySchema(s);await writeFile(path.join(dir,'schema'),b);
  const parts=messages.flatMap(b=>{const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return [h,b];});await writeFile(path.join(dir,'messages'),Buffer.concat(parts));
  const config=path.join(dir,'config.json');await writeFile(config,JSON.stringify({schema:path.join(dir,'schema'),messages:path.join(dir,'messages'),fields}));
  const expected=[];let expectedError;try{const d=new BoundedWireDecoder(b,new Set(fields));for(const b of messages){const m=d.decode(b,n=>expected.push({kind:'N',value:n}));expected.push({kind:'M',value:m});}}catch(e){expectedError=e;}
  const actual=[];let actualError;const session=nativeSession('decode',config,{stage:7});try{for await(const b of session.records())actual.push(unpack(b));}catch(e){actualError=e;}finally{await session.destroy();}
  assert.equal(!!actualError,!!expectedError,`${actualError?.message} / ${expectedError?.message}`);
  assert.deepEqual(actual,expected);return expectedError;
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('stage7 numeric boundaries, Unicode/BOM, selection and nested style projection',native,async()=>{
 const s=parseSchema(`struct TextData { string characters; byte[] glyphs; uint[] characterStyleIDs; } message NodeChange { uint u = 1; int i = 2; uint64 big = 3; int64 signed = 4; float f = 5; string name = 6; byte[] blob = 7; TextData textData = 8; NodeChange[] overrides = 9; } message Message { NodeChange[] nodeChanges = 1; }`),c=compileSchema(s);
 const fields=['u','i','big','signed','f','name','textData','overrides'];
 const nodes=[0,1,4294967295].map((u,i)=>({u,i:i===2?-2147483648:2147483647,big:'18446744073709551615',signed:'-9223372036854775808',f:[NaN,Infinity,-Infinity][i],name:'\ufeff\ufeffКириллица 😀 日本語',blob:new Uint8Array(100000),textData:{characters:'текст',glyphs:new Uint8Array(10000),characterStyleIDs:[0,1]},overrides:[{name:'override'}]}));
 assert.equal(await compare(s,[c.encodeMessage({nodeChanges:nodes})],fields),undefined);
 for(const f of [-0,1e-38,Math.PI,-3.4028234663852886e38])await compare(s,[c.encodeMessage({nodeChanges:[{f}]})],fields);
});
test('stage7 malformed messages: truncation, varint, tags, enums, UTF-8, trailing bytes',native,async()=>{
 const s=schema('string name = 1; uint number = 2;'),c=compileSchema(s),good=c.encodeMessage({nodeChanges:[{name:'hello',number:4000000000}]});
 for(let n=0;n<good.length;n++)await compare(s,[good.subarray(0,n)],['name','number']);
 for(const b of [Buffer.from([1,1,1,255,0,0,0]),Buffer.from([1,1,2,255,255,255,255,16,0,0]),Buffer.from([1,1,2,0,2,0,0,0]),Buffer.from([1,1,99,0,0]),Buffer.concat([good,Buffer.from([0])])])assert.ok(await compare(s,[b],['name','number']));
 // Invalid UTF-8 in skipped strings is accepted by the production decoder.
 assert.equal(await compare(s,[Buffer.from([1,1,1,255,0,0,0])],[]),undefined);
 const e=parseSchema('enum E { A = 1; } message NodeChange { E value = 1; } message Message { NodeChange[] nodeChanges = 1; }');assert.ok(await compare(e,[Buffer.from([1,1,1,2,0,0])],['value']));
});
test('stage7 schema validation and limits',native,async()=>{
 const s=schema('string name = 1;'),b=encodeBinarySchema(s);
 for(let n=0;n<b.length;n++)await compare(b.subarray(0,n),[],['name']);
 await compare(Buffer.concat([b,Buffer.from([0])]),[],[]);
 for(const text of ['message Other { uint a = 1; }','message NodeChange { uint constructor = 1; } message Message { NodeChange[] nodeChanges = 1; }'])await compare(encodeBinarySchema(parseSchema(text)),[],[]);
 const bb=new ByteBuffer();bb.writeVarUint(2001);await compare(bb.toUint8Array(),[],[]);
});
test('stage7 bounded depth, node work, retained bytes, arrays and strings',native,async()=>{
 const s=schema('NodeChange nested = 1; string name = 2; uint[] values = 3; byte[] blob = 4;'),c=compileSchema(s);
 for(const n of [63,64,65]){let node={};for(let i=0;i<n;i++)node={nested:node};await compare(s,[c.encodeMessage({nodeChanges:[node]})],['nested']);}
 for(const n of [10000,10001,200000,200001])await compare(s,[c.encodeMessage({nodeChanges:[{values:Array(n).fill(0)}]})],n<200000?['values']:[]);
 for(const n of [1048559,1048576,1048577])await compare(s,[c.encodeMessage({nodeChanges:[{name:'x'.repeat(n)}]})],['name']);
 await compare(s,[c.encodeMessage({nodeChanges:[{blob:new Uint8Array(4*1024*1024)}]})],[]);
 await compare(s,[c.encodeMessage({nodeChanges:[{values:Array(10000).fill(0),name:'x'.repeat(900000)}]})],['name','values']);
});
test('stage7 shared wire corpus and real compressed capture agree without fallback',native,async()=>{
 const records=fixtures().filter(f=>f.layer==='wire').map(f=>wireCapture(f.nodes).records);
 const real='.cache/figma-network/rust-corpus-real/probe.json';if(existsSync(real)){const p=JSON.parse(await readFile(real));records.push(p.events.filter(e=>e.kind==='ws-received').map((e,eventSequence)=>({version:1,kind:'ws-received',session:'real',requestId:'real',opcode:2,eventSequence,payload:e.payload})));}
 for(const rs of records){const w=await workspace(rs);try{const config={...w,fields:[...nodeFields]};await writeFile(w.config,JSON.stringify({directory:w.directory,snapshot:w.snapshot,fields:config.fields}));
  const expected=[],actual=[];await nodeDecode(config,x=>expected.push(x));let fallbacks=0;await w.store.withRead(()=>compatibleDecode(config,x=>actual.push(x),{onFallback:()=>fallbacks++}));assert.deepEqual(actual,expected);assert.equal(fallbacks,0);
 }finally{await rm(w.project,{recursive:true,force:true});}}
});
test('stage7 compatibility replay preserves prefix, nonfinite floats, consumer errors and cancellation',native,async()=>{
 const {zstd}=await import('./wire-fixture.mjs');const s=schema('float opacity = 1;'),c=compileSchema(s),header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 const payloads=[Buffer.concat([header,zstd(encodeBinarySchema(s))]),zstd(c.encodeMessage({nodeChanges:[{opacity:1}]})),zstd(c.encodeMessage({nodeChanges:[{opacity:Infinity}]}))];
 const w=await workspace(payloads.map((b,eventSequence)=>({version:1,kind:'ws-received',session:'a',requestId:'a',opcode:2,eventSequence,payload:b.toString('base64'),...(eventSequence===2?{extra:'\ud800'}:{})})));
 try{const cfg={...w,fields:['opacity']};await writeFile(w.config,JSON.stringify({directory:w.directory,snapshot:w.snapshot,fields:cfg.fields}));const a=[],b=[];let fallback=0;await nodeDecode(cfg,x=>a.push(x));await compatibleDecode(cfg,x=>b.push(x),{onFallback:()=>fallback++});assert.deepEqual(b,a);assert.equal(fallback,1);
 let pid;const abort=new AbortController();await assert.rejects(compatibleDecode(cfg,()=>abort.abort(),{signal:abort.signal,onPid:p=>pid=p}),{code:'ABORTED'});assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 fallback=0;await assert.rejects(compatibleDecode(cfg,()=>{throw Error('consumer failed');},{onFallback:()=>fallback++}),/consumer failed/);assert.equal(fallback,0);
 }finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage7 retained overrides, variables and typography preserve fields and skip glyph blobs',native,async()=>{
 const s=parseSchema(`
 struct Guid { uint sessionID; uint localID; }
 message VariableAnyValue { Guid alias = 1; float floatValue = 2; string textValue = 3; byte[] ignored = 4; }
 struct VariableData { string dataType; VariableAnyValue value; }
 struct Entry { Guid modeID; VariableData variableData; }
 struct Values { Entry[] entries; }
 struct Font { string family; string style; }
 message FontMetaData { Font key = 1; uint fontWeight = 2; string fontStyle = 3; byte[] glyphs = 4; }
 message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; FontMetaData[] fontMetaData = 4; byte[] glyphs = 5; }
 message DerivedTextData { FontMetaData[] fontMetaData = 1; byte[] glyphs = 2; }
 message SymbolData { Guid symbolID = 1; NodeChange[] symbolOverrides = 2; }
 message NodeChange { Guid guid = 1; string name = 2; TextData textData = 3; DerivedTextData derivedTextData = 4; SymbolData symbolData = 5; Values variableDataValues = 6; float fontSize = 7; uint styleID = 8; }
 message Message { NodeChange[] nodeChanges = 1; }
 `),c=compileSchema(s),meta={key:{family:'Inter',style:'Bold'},fontWeight:700,fontStyle:'NORMAL',glyphs:new Uint8Array(1000)};
 const node={guid:{sessionID:1,localID:2},name:'Instance',textData:{characters:'AB😀',characterStyleIDs:[0,1,1,1],styleOverrideTable:[{styleID:1,fontSize:16}],fontMetaData:[meta],glyphs:new Uint8Array(20000)},derivedTextData:{fontMetaData:[meta],glyphs:new Uint8Array(20000)},symbolData:{symbolID:{sessionID:1,localID:10},symbolOverrides:[{name:'Override',fontSize:12}]},variableDataValues:{entries:[{modeID:{sessionID:2,localID:1},variableData:{dataType:'FLOAT',value:{floatValue:16,ignored:new Uint8Array(1000)}}}]}};
 assert.equal(await compare(s,[c.encodeMessage({nodeChanges:[node]})],[...nodeFields]),undefined);
});
test('stage7 primitive-name schema alias and byte array retention limits',native,async()=>{
 const def=parseSchema('struct Alias { byte x; } message NodeChange { Alias name = 1; } message Message { NodeChange[] nodeChanges = 1; }');
 const bytes=Buffer.from(encodeBinarySchema(def));const at=bytes.indexOf(Buffer.from('Alias'));const s=Buffer.concat([bytes.subarray(0,at),Buffer.from('uint'),bytes.subarray(at+5)]);
 await compare(s,[Buffer.from([1,1,1,128,1,0,0])],['name']);
 const b=schema('byte[] name = 1;'),c=compileSchema(b);for(const n of [10000,10001])await compare(b,[c.encodeMessage({nodeChanges:[{name:new Uint8Array(n)}]})],['name']);
});
test('stage7 large tag tables reject duplicate high-index fields and compatibility keeps error reason',native,async()=>{
 const s=schema(Array.from({length:258},(_,i)=>`uint f${i} = ${i+1};`).join(' '));
 const bb=new ByteBuffer();for(const n of [1,1,258,3,258,4,0,0])bb.writeVarUint(n);
 const error=await compare(s,[bb.toUint8Array()],['f257']);assert.match(error.message,/Duplicate wire field/);
 const rs=wireCapture(fixtures()[0].nodes).records;const {zstd}=await import('./wire-fixture.mjs');rs.push({...rs.at(-1),eventSequence:rs.length,payload:zstd(Buffer.from([1])).toString('base64')});
 const w=await workspace(rs);try{const cfg={...w,fields:[...nodeFields]};await writeFile(w.config,JSON.stringify({directory:w.directory,snapshot:w.snapshot,fields:cfg.fields}));let expected;try{await nodeDecode(cfg,()=>{});}catch(e){expected=e.message;}await assert.rejects(compatibleDecode(cfg,()=>{}),e=>e.message===expected);}finally{await rm(w.project,{recursive:true,force:true});}
});
test('stage7 deterministic wire mutation differential',native,async()=>{
 const {schema:s,codec:c}=await import('../scripts/rust-corpus/fixtures.mjs');const original=Buffer.from(c.encodeMessage({type:'NODE_CHANGES',nodeChanges:fixtures()[0].nodes}));let seed=20261025;
 for(let i=0;i<100;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const b=Buffer.from(original);b[seed%b.length]^=1<<((seed>>>16)%8);await compare(s,[b],[...nodeFields]);}
});
