import {networkStyle} from '../dist/network-style.js';
import {designContextNode} from '../dist/network-context.js';
import {networkLayout} from '../dist/network-layout.js';
import {parseVariables} from '../dist/variables.js';
import {mapNetworkNodeVariables} from '../dist/network-variables.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {resolveNativeVariable,inheritVariableModes} from '../dist/network-variable-resolver.js';
import {DiskNetworkSnapshot} from '../dist/network-disk.js';
import {nativeVariableBindings,effectiveVariableNode} from '../dist/network-variables.js';
const g=n=>({sessionID:1,localID:n});
const alias=n=>({dataType:'ALIAS',value:{alias:{guid:g(n)}}});
const literal=(value,type='FLOAT')=>({dataType:type,value:{[type==='FLOAT'?'floatValue':type==='BOOLEAN'?'boolValue':'textValue']:value}});
const collection={guid:g(100),type:'VARIABLE_SET',name:'Theme',variableSetModes:[{id:g(10),name:'Light'},{id:g(11),name:'Dark'}]};
const variable=(n,name,light,dark)=>({guid:g(n),type:'VARIABLE',name,variableSetID:{guid:g(100)},variableResolvedType:'FLOAT',variableDataValues:{entries:[{modeID:g(10),variableData:light},{modeID:g(11),variableData:dark}]}});
const makeReader=nodes=>({node:id=>nodes.find(n=>`${n.guid.sessionID}:${n.guid.localID}`===id),asset:()=>undefined});
const mode=(n)=>({variableModeBySetMap:{entries:[{variableSetID:{guid:g(100)},variableModeID:g(n)}]}});
test('native names, collection, modes and alias chains resolve under nearest inherited mode',()=>{
 const read=makeReader([collection,variable(1,'Button',alias(2),alias(2)),variable(2,'Spacing',literal(8),literal(16))]);
 const light=inheritVariableModes(new Map(),mode(10),'frame');
 const r=resolveNativeVariable(alias(1),light,read);
 assert.equal(r.name,'Button');assert.equal(r.collection.name,'Theme');assert.equal(r.modeName,'Light');assert.equal(r.value,8);
 assert.deepEqual(r.chain.map(v=>v.name),['Button','Spacing']);assert.deepEqual(r.modes.map(v=>v.value),[8,16]);
 const dark=inheritVariableModes(light,mode(11),'child');const d=resolveNativeVariable(alias(1),dark,read);
 assert.equal(d.value,16);assert.equal(d.modeSourceNodeId,'child');assert.equal(light.get('g:1:100').modeId,'1:10');
});
test('unknown active modes are explicit; equal values may resolve without pretending to know a mode',()=>{
 const read=makeReader([collection,variable(1,'Distinct',literal(8),literal(16)),variable(2,'Common',literal(0),literal(0))]);
 const r=resolveNativeVariable(alias(1),new Map(),read);assert.equal(r.status,'unresolved');assert.equal(r.modeSelection,'unknown');assert.equal(r.value,undefined);
 assert.deepEqual(r.modes.map(v=>v.value),[8,16]);
 const equal=resolveNativeVariable(alias(2),new Map(),read);assert.equal(equal.value,0);assert.equal(equal.modeIndependent,true);assert.equal(equal.modeId,undefined);
 const invalid=resolveNativeVariable(alias(2),inheritVariableModes(new Map(),mode(99),'frame'),read);assert.equal(invalid.status,'unresolved');
});
test('cycles, missing definitions, missing mode values, expressions and duplicates fail explicitly',()=>{
 const a=variable(1,'A',alias(2),alias(2)),b=variable(2,'B',alias(1),alias(1));
 const modes=inheritVariableModes(new Map(),mode(10),'frame');
 assert.match(resolveNativeVariable(alias(1),modes,makeReader([collection,a,b])).reason,/cycle/);
 assert.match(resolveNativeVariable(alias(1),modes,makeReader([collection])).reason,/absent/);
 const missing=variable(1,'A',literal(1),literal(2));missing.variableDataValues.entries.shift();
 assert.equal(resolveNativeVariable(alias(1),modes,makeReader([collection,missing])).status,'unresolved');
 const duplicate=variable(1,'A',literal(1),literal(2));duplicate.variableDataValues.entries.push(duplicate.variableDataValues.entries[0]);
 assert.match(resolveNativeVariable(alias(1),modes,makeReader([collection,duplicate])).reason,/duplicate/);
 assert.equal(resolveNativeVariable({dataType:'EXPRESSION',value:{}},new Map(),makeReader([])).status,'unresolved');
 assert.equal(resolveNativeVariable(literal(false,'BOOLEAN'),new Map(),makeReader([])).value,false);
 assert.equal(resolveNativeVariable(literal('','STRING'),new Map(),makeReader([])).value,'');
});
test('gradient stops and mixed text styles expose separate native binding locations',()=>{
 const n={fillPaints:[{stopsVar:[{colorVar:alias(1)}]}],textData:{styleOverrideTable:[{styleID:2,fillPaints:[{colorVar:alias(2)}]}]}};
 const r=nativeVariableBindings(n,()=>({status:'resolved',value:1}));
 assert.deepEqual(r.references.map(v=>v.path),['fillPaints[0].stopsVar[0].colorVar','textStyle[2].fillPaints[0].colorVar']);
});
test('disk-only asset lookup honors exact version, rejects ambiguity and inherits modes from ancestors outside selection',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'native-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 const external={dataType:'ALIAS',value:{alias:{assetRef:{key:'variable',version:'v2'}}}};
 const v=variable(1,'Library spacing',literal(8),literal(16));v.key='variable';v.version='v2';v.variableSetID={assetRef:{key:'theme',version:'v1'}};
 const older={...v,guid:g(2),version:'v1',name:'Older spacing'};
 model.acceptMessage({type:'JOIN_START'});
 for(const n of [{guid:g(200),type:'FRAME',...mode(11)},
  {guid:g(201),parentIndex:{guid:g(200),position:'a'},type:'FRAME',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:external}]}},
  {guid:g(202),type:'FRAME',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:{...external,value:{alias:{assetRef:{key:'variable'}}}}}]}},
  {guid:g(203),type:'FRAME',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:{...external,value:{alias:{assetRef:{key:'variable',version:'missing'}}}}}]}},
  {...collection,key:'theme',version:'v1'},v,older]) model.acceptNode({...n,phase:'CREATED'});
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const q={format:'context',url:'https://www.figma.com/design/test/File?node-id=1-201',depth:1,maxNodes:10,offset:0,includeHidden:false};
 const r=model.query(q),binding=r.nodes[0].style.nativeBindings.references[0];
 assert.equal(binding.status,'resolved');const detailed=model.query({...q,format:'debug'}).nodes[0].style.nativeBindings.references[0];assert.equal(detailed.value,16);assert.equal(detailed.modeSourceNodeId,'1:200');assert.equal(detailed.collection.name,'Theme');
 assert.equal(model.selectionCacheStats().nodes,1);assert.ok(r.nativeVariables.dependencyReads>0);
 for(const nodeId of [202,203]) {
  const result=model.query({...q,url:`https://www.figma.com/design/test/File?node-id=1-${nodeId}`});
  assert.equal(result.nodes[0].style.nativeBindings.references[0].status,'unresolved');
 }
 const unresolved=resolveNativeVariable({...external,value:{alias:{assetRef:{key:'missing'}}}},new Map(),makeReader([]));assert.equal(unresolved.status,'unresolved');
});

test('native definitions retain a differing stored fallback as diagnostic data',()=>{
 const n={fillPaints:[{color:{r:1,g:1,b:1,a:1},colorVar:alias(1)}],variableConsumptionMap:{entries:[{variableField:'STACK_SPACING',variableData:alias(2)}]},stackSpacing:8};
 const r=nativeVariableBindings(n,data=>({status:'resolved',name:data.value.alias.guid.localID===1?'Black':'Spacing',value:data.value.alias.guid.localID===1?{r:0,g:0,b:0,a:1}:8}));
 const color=r.references.find(v=>v.path==='fillPaints[0].colorVar');
 assert.equal(color.status,'resolved');assert.equal(color.definitionStatus,'resolved');assert.equal(color.name,'Black');assert.equal(color.capturedValueCheck,'different-fallback');
 assert.deepEqual(color.capturedValue,{r:1,g:1,b:1,a:1});assert.deepEqual(color.value,{r:0,g:0,b:0,a:1});
 assert.equal(r.references.find(v=>v.path==='STACK_SPACING').capturedValueCheck,'matched');
});


test('public CSS uses resolved native color then UI-kit token; no native names leak into ordinary context',()=>{
 const n={id:'1:1',type:'FRAME',fillPaints:[{type:'SOLID',visible:true,opacity:1,blendMode:'NORMAL',color:{r:1,g:1,b:1,a:1},colorVar:alias(1)}]};
 const style=networkStyle(n,()=>({status:'resolved',dataType:'COLOR',name:'gray-200',value:{r:0,g:0,b:0,a:1}}));
 assert.equal(style.css['background-color'],'rgba(0, 0, 0, 1)');assert.equal(n.fillPaints[0].color.r,1);
 const context=designContextNode({...n,style,layout:networkLayout(n)});
 assert.equal(JSON.stringify(context).includes('gray-200'),false);
 const mapped=mapNetworkNodeVariables(context,parseVariables(':root { --black:#000; }'));
 assert.equal(mapped.layout.css['background-color'],'var(--black)');
 assert.equal(mapped.layout.resolvedValues['background-color'],'rgba(0, 0, 0, 1)');
 assert.equal(networkStyle(n,()=>({status:'unresolved',reason:'Definition absent'})).css['background-color'],undefined);
 const gray={...n,fillPaints:[{...n.fillPaints[0],colorVar:undefined,color:{r:Math.fround(242/255),g:Math.fround(242/255),b:Math.fround(242/255),a:1}}]};
 const grayStyle=networkStyle(gray);
 assert.equal(grayStyle.css['background-color'],'rgba(242, 242, 242, 1)');
 assert.equal(mapNetworkNodeVariables({style:grayStyle},parseVariables(':root { --gray:#f2f2f2; }')).style.css['background-color'],'var(--gray)');
});

test('all known consuming properties use effective values before CSS and UI-kit matching',async()=>{
 const {effectiveVariableNode}=await import('../dist/network-variables.js');
 const values={WIDTH:80,HEIGHT:40,STACK_SPACING:8,STACK_PADDING_LEFT:8,CORNER_RADIUS:4,OPACITY:0.5,MIN_WIDTH:40};
 const raw={type:'FRAME',size:{x:999,y:999},stackMode:'HORIZONTAL',stackPrimarySizing:'FIXED',stackCounterSizing:'FIXED',stackSpacing:999,cornerRadius:999,opacity:1,
  variableConsumptionMap:{entries:Object.entries(values).map(([variableField,value])=>({variableField,variableData:literal(value)}))}};
 const resolve=data=>resolveNativeVariable(data,new Map(),makeReader([]));
 const bindings=nativeVariableBindings(raw,resolve),n=effectiveVariableNode(raw,bindings);
 const context=designContextNode({...n,layout:networkLayout(n),style:networkStyle(n,undefined,bindings)});
 const mapped=mapNetworkNodeVariables(context,parseVariables(':root { --mimir-space-8:8px; --mimir-space-40:40px; --mimir-space-80:80px; --mimir-control-radius:4px; }'));
 assert.equal(mapped.layout.css.gap,'var(--mimir-space-8)');assert.equal(mapped.layout.css['padding-left'],'var(--mimir-space-8)');
 assert.equal(mapped.layout.css.width,'var(--mimir-space-80)');assert.equal(mapped.layout.css['min-width'],'var(--mimir-space-40)');
 assert.equal(mapped.layout.css['border-radius'],'var(--mimir-control-radius)');assert.equal(mapped.opacity,0.5);
 assert.equal(raw.size.x,999);assert.equal(raw.stackSpacing,999);
 const failed=effectiveVariableNode(raw,nativeVariableBindings(raw,()=>({status:'unresolved'})));
 assert.equal(networkLayout(failed).css.gap,undefined);assert.equal(networkStyle(failed).css.opacity,undefined);
});

test('text bindings project base and mixed runs, with unresolved overrides masking inherited values',()=>{
 const entry=(variableField,value,type)=>({variableField,variableData:literal(value,type)});
 const n={type:'TEXT',fontSize:12,fontName:{family:'Old',style:'Regular'},lineHeight:{value:16,units:'PIXELS'},
  variableConsumptionMap:{entries:[entry('FONT_SIZE',20),entry('FONT_FAMILY','Inter','STRING'),entry('LINE_HEIGHT',24)]},
  textData:{characters:'ab',characterStyleIDs:[0,1],styleOverrideTable:[{styleID:1,fontSize:10,
   variableConsumptionMap:{entries:[{variableField:'FONT_SIZE',variableData:alias(404)}]}}]}};
 const style=networkStyle(n,data=>resolveNativeVariable(data,new Map(),makeReader([])));
 assert.equal(style.text.base.css['font-size'],'20px');assert.equal(style.text.base.css['font-family'],'"Inter"');
 assert.equal(style.text.base.css['line-height'],'24px');assert.equal(style.text.ranges[1].css['font-size'],undefined);
 assert.equal(style.css['font-size'],undefined);assert.equal(n.fontSize,12);
});

test('disk traversal applies visibility binding before filtering hidden nodes and keeps cache raw',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'effective-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 model.acceptMessage({type:'JOIN_START'});
 model.acceptNode({guid:g(1),phase:'CREATED',type:'RECTANGLE',visible:false,size:{x:1,y:2},variableConsumptionMap:{entries:[
  {variableField:'VISIBLE',variableData:literal(true,'BOOLEAN')},{variableField:'WIDTH',variableData:literal(80)}]}});
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const q={format:'context',url:'https://www.figma.com/design/test/File?node-id=1-1',depth:1,maxNodes:10,offset:0,includeHidden:false};
 for(let i=0;i<2;i++){const r=model.query(q);assert.equal(r.nodes.length,1);assert.equal(r.nodes[0].layout.css.width,'80px');assert.equal(r.nodes[0].hidden,false);}
});

test('collection default uses captured sort positions, never array order or color matching',()=>{
 const ordered={...collection,variableSetModes:[{id:g(11),name:'Dark',sortPosition:'"'},{id:g(10),name:'Light',sortPosition:'!'}]};
 const read=makeReader([ordered,variable(1,'Distinct',literal(8),literal(16))]);
 const r=resolveNativeVariable(alias(1),new Map(),read);
 assert.equal(r.value,8);assert.equal(r.modeSelection,'collection-default');assert.equal(r.modeId,'1:10');
 assert.equal(resolveNativeVariable(alias(1),new Map(),{...read,defaultModeAllowed:false}).status,'unresolved');
 assert.equal(resolveNativeVariable(alias(1),inheritVariableModes(new Map(),mode(11),'page'),read).value,16);
 const ambiguous={...ordered,variableSetModes:ordered.variableSetModes.map(m=>({...m,sortPosition:'!'}))};
 assert.equal(resolveNativeVariable(alias(1),new Map(),makeReader([ambiguous,variable(1,'Distinct',literal(8),literal(16))])).status,'unresolved');
});

test('cleared consumption entries keep literal text, font and radii without inventing bindings',async()=>{
 const {effectiveVariableNode}=await import('../dist/network-variables.js');
 const n={textData:{characters:'LIVE'},fontName:{family:'Inter',style:'Regular'},rectangleTopLeftCornerRadius:12,
 variableConsumptionMap:{entries:['TEXT_DATA','FONT_STYLE','RECTANGLE_TOP_LEFT_CORNER_RADIUS'].map(variableField=>({variableField}))}};
 const bindings=nativeVariableBindings(n,()=>{throw new Error('Cleared entries must not resolve');});
 assert.deepEqual(bindings.references,[]);assert.deepEqual(effectiveVariableNode(n,bindings),n);
 const malformed={...n,variableConsumptionMap:{entries:[{variableField:'TEXT_DATA',variableData:{}}]}};
 assert.equal(nativeVariableBindings(malformed).references.length,1);
});

test('page and frame modes flow through expanded components, with a component override taking precedence',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'mode-inheritance-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 const child=(n,parent,extra)=>({guid:g(n),parentIndex:{guid:g(parent),position:String(n)},...extra});
 model.acceptMessage({type:'JOIN_START'});
 const nodes=[{guid:g(200),type:'CANVAS',...mode(11)},child(201,200,{type:'FRAME'}),
 child(202,201,{type:'INSTANCE',symbolData:{symbolID:g(300)}}),child(203,201,{type:'INSTANCE',symbolData:{symbolID:g(301)}}),
 {guid:g(300),type:'SYMBOL'},{guid:g(301),type:'SYMBOL',...mode(10)},
 child(302,300,{type:'RECTANGLE',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:alias(1)}]}}),
 child(303,301,{type:'RECTANGLE',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:alias(1)}]}}),
 collection,variable(1,'width',literal(8),literal(16))];
 for(const n of nodes)model.acceptNode({...n,phase:'CREATED'});
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const q={format:'debug',url:'https://www.figma.com/design/test/File?node-id=1-201',depth:10,maxNodes:100,offset:0,includeHidden:false};
 const result=model.query(q),refs=result.nodes.flatMap(n=>n.style.nativeBindings.references);
 assert.deepEqual(Object.fromEntries(refs.map(r=>[r.modeSourceNodeId,r.value])),{'1:200':16,'1:203':8});
 assert.deepEqual(model.query(q).nodes,result.nodes);
});

test('solid color variable alpha replaces captured paint alpha exactly once, including text overrides',()=>{
 const paint={type:'SOLID',visible:true,blendMode:'NORMAL',opacity:.36,color:{r:1,g:0,b:0,a:1},colorVar:alias(1)};
 const n={type:'FRAME',opacity:.5,fillPaints:[paint],strokePaints:[paint],textData:{styleOverrideTable:[{styleID:2,fillPaints:[paint]}]}};
 const resolve=()=>({status:'resolved',dataType:'COLOR',value:{r:1,g:0,b:0,a:.36}});
 const projected=effectiveVariableNode(n,nativeVariableBindings(n,resolve));
 for(const p of [projected.fillPaints[0],projected.strokePaints[0],projected.textData.styleOverrideTable[0].fillPaints[0]]) {assert.equal(p.color.a,1);assert.equal(p.opacity,.36);}
 const style=networkStyle(n,resolve);assert.equal(style.css['background-color'],'rgba(255, 0, 0, 0.36)');assert.equal(style.css.opacity,'0.5');
 assert.equal(n.fillPaints[0].color.a,1);
 assert.equal(networkStyle(n,()=>({...resolve(),value:{r:1,g:0,b:0,a:0}})).css['background-color'],'rgba(255, 0, 0, 0)');
});
