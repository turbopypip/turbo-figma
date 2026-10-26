import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {workspace} from '../scripts/rust-helper/stage6-common.mjs';
import {fixtures,wireCapture} from '../scripts/rust-corpus/fixtures.mjs';
import {RustSnapshot,rustBinary} from '../dist/network-rust.js';
import {networkLayout,VERIFIED_LAYOUT_SCHEMA} from '../dist/network-layout.js';
import {designContextNode} from '../dist/network-context.js';
import {geometryContext} from '../dist/network-geometry.js';
const native={skip:existsSync(rustBinary)?false:'Release helper not built'};
if(process.env.REQUIRE_RUST_HELPER&&!existsSync(rustBinary))throw Error('Release helper required');
async function session(fn) {
 const w=await workspace(wireCapture(fixtures()[0].nodes).records);let native;
 try {native=await RustSnapshot.open(w.store.root,w.snapshot,await mkdtemp(path.join(w.store.root,'decode-')));await fn(native,w);}
 finally {await native?.destroy();await rm(w.project,{recursive:true,force:true});}
}
const normalize=v=>JSON.parse(JSON.stringify(v));
test('Rust layout/public context preserves CSS order, sizing evidence, geometry and missing values',native,async()=>session(async s=>{
 let seed=12345;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const types=['FRAME','INSTANCE','TEXT','RECTANGLE','GROUP','VECTOR'];
 const modes=[undefined,'NONE','HORIZONTAL','VERTICAL','GRID'];
 for(let i=0;i<150;i++) {
  const n={type:types[i%types.length],name:'Test',size:i%9?{x:rand()*200,y:rand()*300}:null,
   transform:i%11?{m00:Math.cos(i),m01:-Math.sin(i),m02:rand()*100,m10:Math.sin(i),m11:Math.cos(i),m12:rand()*100}:null,
   stackMode:modes[i%modes.length],stackSpacing:i%3?12:-2,stackHorizontalPadding:1,stackVerticalPadding:2,stackPaddingRight:3,stackPaddingBottom:4,
   stackPrimaryAlignItems:['MIN','MAX','CENTER','SPACE_EVENLY','unknown'][i%5],stackCounterAlignItems:['MIN','MAX','CENTER','BASELINE'][i%4],
   stackPrimarySizing:i%2?'FIXED':undefined,stackCounterSizing:i%3?'RESIZE_TO_FIT':undefined,
   stackChildPrimaryGrow:i%2,stackChildAlignSelf:i%2?'STRETCH':undefined,stackPositioning:i%3?'AUTO':'ABSOLUTE',
   stackWrap:i%3?'WRAP':'NO_WRAP',stackCounterSpacing:8,stackCounterAlignContent:i%2?'SPACE_BETWEEN':undefined,
   textAutoResize:['WIDTH_AND_HEIGHT','HEIGHT','NONE','TRUNCATE'][i%4],minSize:{value:{x:2,y:0}},maxSize:{value:{x:500,y:700}},
   visible:i%2===0,opacity:0.5,textData:{characters:'a😀b'},component:i%5?undefined:{status:'resolved'},instanceUnresolved:i%7===0,instanceError:'Unavailable'};
  const parent={stackMode:modes[(i+1)%modes.length]};
  const pg=geometryContext({type:'CANVAS'},'0:0');
  const fg=geometryContext({type:'FRAME',transform:{m00:0,m01:-1,m02:20,m10:1,m11:0,m12:10}},'0:1',pg);
  const geometry=geometryContext(n,'1:1',fg);
  const entry={...n,id:'1:1',parentId:'0:1',depth:0,style:{css:{opacity:'0.5',width:'17px','font-family':'"A"'},nativeBindings:{complete:false,unresolved:[],references:[{path:'fill',status:'unresolved',reason:'missing',privateData:'do not expose'}]}}};
  for(const format of ['debug','context']) {
   const expected={...entry,layout:networkLayout(n,parent,VERIFIED_LAYOUT_SCHEMA,geometry)};
   const actual=await s.request({op:'project',schema:VERIFIED_LAYOUT_SCHEMA,format,entries:[{node:n,parent,geometry,entry,styleOrder:Object.keys(entry.style.css)}]});
   assert.equal(actual.error,undefined);
   assert.deepEqual(actual.result[0],normalize(format==='debug'?expected:designContextNode(expected)),`case ${i} ${format}`);
  }
 }
}));
test('Rust projection rejects invalid and oversized batches and leaves the index usable',native,async()=>session(async s=>{
 for(const entries of [null,[{}],Array(9).fill({node:{},entry:{}})]) {
  assert.match((await s.request({op:'project',entries})).error,/Invalid projection|limit/);
 }
 assert.ok((await s.request({op:'node',id:'1:1'})).result);
}));

test('Rust visual styles match Node for mixed text, UTF-16 errors, paint alpha and collection limits',native,async()=>session(async s=>{
 const {networkStyle}=await import('../dist/network-style.js');
 const {nativeVariableBindings}=await import('../dist/network-variables.js');
 const paint={type:'SOLID',visible:true,opacity:.5,blendMode:'NORMAL',color:{r:Math.fround(42/255),g:0.12345678,b:1,a:.4}};
 const font={family:'Sample"\\\n',style:'Regular',postscript:'saved'};
 const base={type:'TEXT',opacity:.5,fontName:font,fontSize:20,lineHeight:{value:120,units:'PERCENT'},letterSpacing:{value:-2,units:'PERCENT'},fillPaints:[paint],
  textData:{characters:'A😀Б',characterStyleIDs:[0,2,2,2],styleOverrideTable:[{styleID:2,fontName:{family:'Sample',style:'Bold'},fontSize:24}]},
  derivedTextData:{fontMetaData:[{key:font,fontWeight:400,fontStyle:'NORMAL'},{key:{family:'Sample',style:'Bold'},fontWeight:700,fontStyle:'ITALIC'}]}};
 const cases=[base,{},...[
  {characterStyleIDs:[0]}, {characterStyleIDs:[0,3,3,3]}, {characterStyleIDs:[0,0,2,2]},
  {styleOverrideTable:[{styleID:2},{styleID:2}]}, {styleOverrideTable:Array(1025).fill({styleID:2})},
  {characters:'x'.repeat(1025),characterStyleIDs:Array.from({length:1025},(_,i)=>i%2?2:0)},
 ].map(data=>({...base,textData:{...base.textData,...data}})),
 {...base,textData:{characters:'a'},derivedTextData:{fontMetaData:[{key:{...font,postscript:''},fontWeight:400,fontStyle:'NORMAL'}]}},
 {...base,textData:{characters:'a'},derivedTextData:{fontMetaData:[{key:{family:'Substitute',style:'Regular'},fontWeight:500,fontStyle:'NORMAL'}]}},
 {...base,derivedTextData:{fontMetaData:Array(257).fill({key:font})}},
 {...base,fillPaints:Array(129).fill(paint)}, {...base,effects:Array(129).fill({})},
 {...base,fillPaints:[{...paint,colorVar:{}}]},
 {...base,fillPaints:[{...paint,type:'GRADIENT_LINEAR',stops:Array(129).fill({position:0})}]},
 ];
 for(let i=0;i<80;i++) cases.push({type:['FRAME','RECTANGLE','ELLIPSE','TEXT'][i%4],opacity:i/79,fillPaints:[{...paint,visible:i%3!==0,blendMode:i%2?'NORMAL':'MULTIPLY'}],
   cornerRadius:i/3,rectangleCornerRadiiIndependent:i%2===0,rectangleTopLeftCornerRadius:1,rectangleTopRightCornerRadius:2,rectangleBottomRightCornerRadius:3,rectangleBottomLeftCornerRadius:4,
   effects:[{type:'DROP_SHADOW',visible:i%2===0,offset:{x:1,y:2},radius:4,spread:0,color:paint.color}],
   fontName:font,textData:'x',fontSize:12,paragraphSpacing:i%2,lineHeight:{units:'PIXELS',value:i},letterSpacing:{units:'PERCENT',value:-0.00005},textCase:'UPPER'});
 for(const [i,node]of cases.entries()) {
  const bindings=nativeVariableBindings(node),style=networkStyle(node,undefined,bindings);
  for(const format of ['debug','context']) {
   const entry={...node,id:'1:1',parentId:null,depth:0,style,layout:networkLayout(node)};
   const r=await s.request({op:'project',format,entries:[{node,bindings,entry:{id:'1:1',parentId:null,depth:0}}]});
   assert.equal(r.error,undefined);assert.deepEqual(r.result[0],normalize(format==='debug'?entry:designContextNode(entry)),`style case ${i} ${format}`);
  }
 }
}));

test('Rust projection uses immutable source records, applies effective patches, and bounds entry output',native,async()=>session(async s=>{
 const {networkStyle}=await import('../dist/network-style.js');
 const {nativeVariableBindings}=await import('../dist/network-variables.js');
 const original=(await s.request({op:'node',id:'1:1'})).result;
 const n={...original,name:'Effective',type:'TEXT',fontSize:999999999999999,textData:{characters:'x'},opacity:0};delete n.size;
 const patch={name:n.name,type:n.type,fontSize:n.fontSize,textData:n.textData,opacity:0};
 const bindings=nativeVariableBindings(n),entry={id:'1:1',parentId:null,depth:0};
 const request={op:'project',format:'context',entries:[{id:'1:1',patch,removed:['size'],bindings,entry}]};
 const r=await s.request(request);assert.equal(r.error,undefined);
 assert.deepEqual(r.result[0],normalize(designContextNode({...n,...entry,style:networkStyle(n,undefined,bindings),layout:networkLayout(n)})));
 assert.deepEqual((await s.request({op:'node',id:'1:1'})).result,original);
 assert.deepEqual((await s.request({...request,maxEntryBytes:100})).result,[null]);
 assert.match((await s.request({...request,entries:[{...request.entries[0],removed:[null]}]})).error,/Invalid removed/);
 assert.deepEqual((await s.request({op:'node',id:'1:1'})).result,original);
}));

test('Rust projection cache is bounded and invalidated by live storage changes and selection changes',native,async()=>session(async s=>{
 const bindings={references:[],unresolved:[],complete:false};
 const original=(await s.request({op:'node',id:'1:1'})).result;
 const request={op:'project',format:'context',entries:[{id:'1:1',patch:{},removed:[],bindings,entry:{id:'1:1',depth:0,parentId:null}}]};
 await s.request({op:'select',id:'1:1'});
 const first=await s.request(request),again=await s.request(request);
 assert.deepEqual(again.result,first.result);assert.equal(again.stats.projectionCache.entries,1);
 await s.request({op:'upsert',node:{...original,name:'After mutation'}});
 const changed=await s.request(request);assert.equal(changed.result[0].name,'After mutation');assert.equal(changed.stats.projectionCache.entries,1);
 for(let i=0;i<80;i++) {
  const r=await s.request({op:'project',format:'debug',entries:[{node:{name:'x'.repeat(60000)},bindings,entry:{id:`1:${i}`}}]});
  assert.equal(r.error,undefined);assert.ok(r.stats.projectionCache.bytes<=4*1024*1024);assert.ok(r.stats.projectionCache.entries<=128);
 }
 const cleared=await s.request({op:'select',id:'1:2'});assert.deepEqual(cleared.stats.projectionCache,{entries:0,bytes:0});
 await s.request(request);
 assert.deepEqual((await s.request({op:'invalidate'})).stats.projectionCache,{entries:0,bytes:0});
}));

test('retained Rust verification rechecks all parts, rejects writes and supports request cancellation',native,async()=>session(async(s,w)=>{
 const {NetworkStore}=await import('../dist/network-store.js');
 const previous=process.env.FIGMA_NETWORK_BACKEND;let store;
 try{process.env.FIGMA_NETWORK_BACKEND='rust';store=await NetworkStore.create(w.project);}
 finally{if(previous===undefined)delete process.env.FIGMA_NETWORK_BACKEND;else process.env.FIGMA_NETWORK_BACKEND=previous;}
 const execute=async command=>{const r=await s.request({op:'storeVerify',command});if(r.error)throw Error(r.error);return r.result;};
 assert.deepEqual(await store.verifiedManifest(w.snapshot,execute),await store.readManifest(w.snapshot));
 assert.match((await s.request({op:'storeVerify',command:{op:'clean'}})).error,/Invalid retained store operation/);
 const generation=(await readdir(store.root)).find(n=>/^[a-f0-9]{64}$/.test(n));
 const filename=path.join(store.root,generation,'part-0.bin'),bytes=await readFile(filename);bytes[0]^=1;await writeFile(filename,bytes);
 await assert.rejects(store.verifiedManifest(w.snapshot,execute),/Corrupt snapshot part/);
 if(process.platform!=='win32') {
  process.kill(s.pid,'SIGSTOP');
  const abort=new AbortController();const pending=s.request({op:'node',id:'1:1'},false,abort.signal);
  abort.abort();await assert.rejects(pending,/cancel/i);assert.throws(()=>process.kill(s.pid,0));
 }
}));
