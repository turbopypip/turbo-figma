import test from 'node:test';
import assert from 'node:assert/strict';
import { networkStyle } from '../dist/network-style.js';
import { designContextNode } from '../dist/network-context.js';
import { networkLayout } from '../dist/network-layout.js';
import { BoundedWireDecoder } from '../dist/network-wire.js';
import { nodeFields, compileWireSchema } from '../dist/network.js';
import { parseSchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { readNetworkSnapshot, readStoredNetworkSnapshot, releaseNetworkSelection } from '../dist/network-reader.js';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { NetworkStore } from '../dist/network-store.js';
import { zstd } from './wire-fixture.mjs';
const paint=(extra={})=>({type:'SOLID',visible:true,opacity:1,blendMode:'NORMAL',color:{r:1,g:0,b:0,a:1},...extra});
const font={family:'Sample',style:'Regular'};
const base={type:'TEXT',fontName:font,fontSize:20,lineHeight:{value:120,units:'PERCENT'},letterSpacing:{value:-2,units:'PERCENT'},fillPaints:[paint()],
 textData:{characters:'A😀Б',characterStyleIDs:[0,2,2,2],styleOverrideTable:[{styleID:2,fontName:{family:'Sample',style:'Bold'},fontSize:24}]},
 derivedTextData:{fontMetaData:[{key:font,fontWeight:400,fontStyle:'NORMAL'},{key:{family:'Sample',style:'Bold'},fontWeight:700,fontStyle:'ITALIC'}]}};
test('mixed text ranges retain UTF-16 boundaries, inherited values and metadata weights; only uniform CSS is promoted',()=>{
 const r=networkStyle(base);
 assert.deepEqual(r.text.ranges.map(r=>[r.start,r.end,r.css['font-size'],r.css['font-weight']]),[[0,1,'20px','400'],[1,4,'24px','700']]);
 assert.equal(r.text.mixed,true);assert.equal(r.css['font-weight'],undefined);assert.equal(r.css['font-size'],undefined);
 assert.equal(r.css['line-height'],'120%');assert.equal(r.css['letter-spacing'],'-0.02em');assert.equal(r.css.color,'rgba(255, 0, 0, 1)');
 assert.equal(r.text.ranges[1].css['font-style'],'italic');assert.equal(r.text.ranges[1].source.lineHeight.value,120);
 assert.equal(networkStyle({...base,derivedTextData:undefined}).text.base.css['font-weight'],undefined);
});
test('invalid style tables and lengths cannot silently become uniform text; surrogate splits and range floods are explicit',()=>{
 for(const data of [
  {...base.textData,characterStyleIDs:[0]},
  {...base.textData,characterStyleIDs:[0,3,3,3]},
  {...base.textData,characterStyleIDs:[0,0,2,2]},
  {...base.textData,styleOverrideTable:[{styleID:2},{styleID:2}]},
 ]) {const r=networkStyle({...base,textData:data});assert.equal(r.text.ranges.length,0);assert.ok(r.text.unresolved.length);assert.equal(r.css.color,undefined);}
 const r=networkStyle({...base,textData:{...base.textData,characters:'x'.repeat(1025),characterStyleIDs:Array.from({length:1025},(_,i)=>i%2?2:0)}});
 assert.deepEqual(r.text.ranges,[]);assert.ok(r.text.unresolved.includes('text.rangeByteLimit'));assert.ok(JSON.stringify(r).length<100000);
});
test('solid paint alpha is multiplied independently of layer opacity, hidden paints excluded, unsupported stacks not approximated',()=>{
 const r=networkStyle({type:'FRAME',opacity:.5,fillPaints:[paint({visible:false}),paint({opacity:.5,color:{r:0,g:0,b:0,a:.4}})]});
 assert.equal(r.css.opacity,'0.5');assert.equal(r.css['background-color'],'rgba(0, 0, 0, 0.2)');
 for(const fills of [[paint(),paint()],[paint({blendMode:'MULTIPLY'})],[paint({type:'IMAGE'})],[paint({opacity:undefined})]]) {
  const r=networkStyle({type:'FRAME',fillPaints:fills});assert.equal(r.css['background-color'],undefined);assert.ok(r.unresolved.length);
 }
 const gradient=networkStyle({fillPaints:[paint({type:'GRADIENT_LINEAR',stops:[{position:0,color:{r:0,g:0,b:0,a:1}}]})]});
 assert.equal(gradient.fills[0].stops[0].position,0);assert.equal(gradient.css['background-image'],undefined);
 assert.equal(networkStyle({opacity:2}).css.opacity,undefined);
});
test('corners follow CSS order; smoothing, stroke alignment and effects retain design semantics without false CSS',()=>{
 const n={type:'FRAME',cornerRadius:50,rectangleCornerRadiiIndependent:true,rectangleTopLeftCornerRadius:1,rectangleTopRightCornerRadius:2,
  rectangleBottomRightCornerRadius:3,rectangleBottomLeftCornerRadius:4,strokePaints:[paint()],strokeAlign:'OUTSIDE',strokeWeight:2,
  effects:[{type:'DROP_SHADOW',visible:true,offset:{x:1,y:2},radius:4,spread:0,color:{r:0,g:0,b:0,a:.2}}]};
 const r=networkStyle(n);assert.equal(r.css['border-radius'],'1px 2px 3px 4px');assert.equal(r.source.strokeAlign,'OUTSIDE');
 assert.equal(r.css.border,undefined);assert.equal(r.effects[0].radius,4);assert.equal(r.css['box-shadow'],undefined);
 assert.ok(r.unresolved.includes('effects[0].css'));assert.equal(networkStyle({...n,cornerSmoothing:.5}).css['border-radius'],undefined);
 assert.equal(networkStyle({...n,rectangleBottomLeftCornerRadius:undefined}).css['border-radius'],undefined);
});
test('normalization caps collections and does not pass technical paint/image metadata or unsafe font CSS through',()=>{
 const r=networkStyle({...base,fontName:{family:'x"; color:red;/*',style:'Regular'},textData:{characters:'a'},fillPaints:[paint({image:{hash:[1,2,3]},colorVar:{secret:'raw'}})]});
 assert.equal(r.fills[0].image,undefined);assert.equal(r.fills[0].colorVar,undefined);assert.equal(r.fills[0].variableBindingUnresolved,true);
 assert.match(r.css['font-family'],/\\22 /);
 assert.equal(networkStyle({fillPaints:Array.from({length:129},()=>paint())}).fills,null);
 assert.ok(networkStyle({effects:Array.from({length:129},()=>({type:'CUSTOM'}))}).unresolved.includes('effects.limit'));
});
test('public context exposes styling without leaking wire text records and keeps layout CSS',()=>{
 const n={...base,textData:{characters:'one'},id:'1:1',stackMode:'HORIZONTAL'};
 const r=designContextNode({...n,layout:networkLayout(n),style:networkStyle(n)});
 assert.equal(r.text,'one');assert.equal(r.textData,undefined);assert.equal(r.layout.css.display,'flex');assert.equal(r.layout.css['font-weight'],'400');
 assert.ok(r.layout.cssText.includes('font-weight: 400;'));assert.ok(r.style.text.ranges.length);
});
const schema=parseSchema(`
 enum Kind { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
 struct GUID { uint sessionID; uint localID; }
 struct Parent { GUID guid; string position; }
 message FontName { string family = 1; string style = 2; }
 message Meta { FontName key = 1; int fontWeight = 2; string fontStyle = 3; }
 message DerivedTextData { Meta[] fontMetaData = 1; byte[] glyphs = 2; }
 message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; byte[] glyphs = 4; }
 message NodeChange { GUID guid = 1; string phase = 2; Parent parentIndex = 3; string type = 4; TextData textData = 5; FontName fontName = 6; float fontSize = 7; uint styleID = 8; DerivedTextData derivedTextData = 9; string name = 10; }
 message Message { Kind type = 1; NodeChange[] nodeChanges = 2; }
`);
const codec=compileSchema(schema), wire=encodeBinarySchema(schema);
const guid=n=>({sessionID:1,localID:n});
const nodes=Array.from({length:12},(_,i)=>({guid:guid(i+1),phase:'CREATED',...(i?{parentIndex:{guid:guid(1),position:String(i).padStart(2,'0')}}:{}),...base,
 textData:{...base.textData,glyphs:new Uint8Array(20000)},derivedTextData:{...base.derivedTextData,glyphs:new Uint8Array(20000)}}));
test('wire decoder retains style IDs inside overrides and derived font metadata while skipping glyph allocations',()=>{
 const out=[];new BoundedWireDecoder(wire,nodeFields).decode(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[nodes[0]]}),n=>out.push(n));
 assert.equal(out[0].textData.styleOverrideTable[0].styleID,2);assert.equal(out[0].derivedTextData.fontMetaData[1].fontWeight,700);
 assert.equal(out[0].derivedTextData.glyphs,undefined);assert.equal(out[0].textData.glyphs,undefined);
 assert.equal(networkStyle(out[0]).text.ranges[1].css['font-weight'],'700');
 const legacy=compileWireSchema(wire).decodeMessage(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[nodes[0]]}));
 assert.deepEqual(legacy.nodeChanges[0],out[0]);
});
test('styled context survives replay/cache/pagination within UTF-8 byte budget, oversized text stays explicit',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'styles-'));
 t.after(async()=>{await releaseNetworkSelection();await rm(dir,{recursive:true,force:true});});
 const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 const all=[...nodes,{guid:guid(99),phase:'CREATED',parentIndex:{guid:guid(1),position:'z'},type:'TEXT',textData:{characters:'😀'.repeat(50000)}}];
 const events=[{kind:'ws-open',key:'a',url:'wss://www.figma.com/api/multiplayer/test'},...[Buffer.concat([header,zstd(wire)]),...[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:all},{type:'JOIN_END'}].map(m=>zstd(codec.encodeMessage(m)))].map(b=>({kind:'ws-received',key:'a',opcode:2,payload:b.toString('base64')}))];
 const captureFile=path.join(dir,'capture.json');await writeFile(captureFile,JSON.stringify({version:2,fileUrl:'https://www.figma.com/design/test/File',events}));
 const params={captureFile,url:'https://www.figma.com/design/test/File?node-id=1-1',depth:5,maxNodes:100,offset:0,includeHidden:false,maxBytes:8192};
 let continuation;const seen=[];do{const r=await readNetworkSnapshot({...params,continuation});assert.ok(Buffer.byteLength(JSON.stringify(r))<=8192);seen.push(...r.nodes);continuation=r.traversal.continuation;}while(continuation);
 assert.equal(seen.length,13);assert.equal(new Set(seen.map(n=>n.id)).size,13);
 assert.equal(seen[0].style.text.ranges[1].css['font-weight'],'700');assert.ok(seen.at(-1).propertiesOmitted);
 const minimum=await readNetworkSnapshot({...params,maxBytes:4096});assert.ok(Buffer.byteLength(JSON.stringify(minimum))<=4096);
 const debug=await readNetworkSnapshot({...params,format:'debug',maxBytes:150000});
 assert.equal(debug.nodes[0].style.text.ranges[1].css['font-weight'],'700');
 const store=await NetworkStore.create(dir), identity={fileKey:'test',sessionId:'styles',generation:1};
 const writer=await store.begin(identity);
 const records=events.slice(1).map((e,eventSequence)=>({version:1,kind:'ws-received',session:'main',requestId:'1',eventSequence,opcode:2,payload:e.payload}));
 await writer.append(0,Buffer.from(records.map(r=>JSON.stringify(r)+'\n').join('')));
 await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:1});
 const first=await readStoredNetworkSnapshot(store,identity,{...params,format:'context',maxBytes:150000});
 const cached=await readStoredNetworkSnapshot(store,identity,{...params,format:'debug',maxBytes:150000});
 assert.equal(cached.metrics.selectionCacheHit,true);assert.deepEqual(cached.nodes[0].style,first.nodes[0].style);
});
