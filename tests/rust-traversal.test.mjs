import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const golden=JSON.parse(await readFile(new URL('./fixtures/traversal.json',import.meta.url),'utf8'));
let goldenIndex=0;
const nodeFields=JSON.parse(await readFile(new URL('../resources/fields.json',import.meta.url),'utf8'));
import {rustBinary} from './native-server.mjs';
const native={skip:existsSync(rustBinary)?false:'Release binary not built'};
if(process.env.REQUIRE_TURBO_FIGMA&&!existsSync(rustBinary))throw Error('Release binary required');
const g=n=>({sessionID:1,localID:n});
const n=(id,parent,extra)=>({guid:g(id),phase:'CREATED',...(parent?{parentIndex:{guid:g(parent),position:String(id).padStart(4,'0')}}:{}),...extra});
const patch=(ids,extra)=>({guidPath:{guids:ids.map(g)},...extra});
const literal=value=>({dataType:typeof value==='number'?'FLOAT':typeof value==='boolean'?'BOOLEAN':'STRING',value:{[typeof value==='number'?'floatValue':typeof value==='boolean'?'boolValue':'textValue']:value}});
const alias=id=>({dataType:'ALIAS',value:{alias:{guid:g(id)}}});
const mode=id=>({variableModeBySetMap:{entries:[{variableSetID:{guid:g(100)},variableModeID:g(id)}]}});
const variable=(id,a,b)=>n(id,null,{type:'VARIABLE',name:'Token',variableResolvedType:'FLOAT',variableSetID:{guid:g(100)},variableDataValues:{entries:[{modeID:g(10),variableData:a},{modeID:g(11),variableData:b}]}});
const collection=n(100,null,{type:'VARIABLE_SET',name:'Theme',variableSetModes:[{id:g(10),name:'Light',sortPosition:'a'},{id:g(11),name:'Dark',sortPosition:'b'}]});
const transform={m00:1,m01:0,m02:1,m10:0,m11:1,m12:2};
async function compare(nodes,queries,verify) {
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'native-traversal-'));
 const scratch=path.join(dir,'rust');await mkdir(scratch);

 try {
  const records=[{kind:'M',value:{type:'JOIN_START'}},...nodes.map(value=>({kind:'N',value})),{kind:'M',value:{type:'NODE_CHANGES'}},{kind:'M',value:{type:'JOIN_END'}}];
  const frames=records.map(v=>{const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);});await writeFile(path.join(dir,'model'),Buffer.concat(frames));
  const base={depth:50,maxNodes:500,offset:0,includeHidden:false,format:'debug'};const qs=queries.map(q=>({...base,...q}));
  await writeFile(path.join(dir,'config'),JSON.stringify({model:path.join(dir,'model'),scratch,fields:[...nodeFields],commands:qs.map(q=>({...q,op:'contextQuery',id:q.id??'1:1',fileKey:'test'}))}));
  const output=await new Promise((resolve,reject)=>{const child=spawn(rustBinary,['--inspect-index','model',path.join(dir,'config')]);const chunks=[];let stderr='';child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',(code,signal)=>code!==0?reject(Error(signal+': '+stderr)):resolve(Buffer.concat(chunks)));});
  const replies=[];for(let i=0;i<output.length;){const size=output.readUInt32LE(i);i+=4;replies.push(JSON.parse(output.subarray(i,i+size)));i+=size;}
  assert.equal(replies.length,qs.length+1,JSON.stringify(replies.map(r=>({kind:r.kind,error:r.reply?.error}))));
  if(verify){for(const r of replies.slice(1))assert.equal(r.reply.error,undefined);await verify(replies.slice(1).map(r=>r.reply.result));return;}
  for(const [i,q] of qs.entries()){const result=replies[i+1].reply;const expected=golden[goldenIndex++];assert.ok(expected);assert.equal(result.error,expected.error,JSON.stringify(q));if(!expected.error)assert.deepEqual(result.result,expected.result,JSON.stringify(q));}
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('native traversal owns nested instance scale, overrides, properties and geometry',native,async()=>{
 const nodes=[n(900,null,{type:'CANVAS'}),n(901,900,{type:'FRAME',transform}),n(1,901,{type:'FRAME',stackMode:'VERTICAL',transform}),
 n(2,1,{type:'INSTANCE',name:'Original',transform,symbolData:{symbolID:g(200),uniformScaleFactor:2,symbolOverrides:[patch([20,30],{fontSize:7}),patch([20,31],{visible:false})]},derivedSymbolData:[patch([20,30],{size:{x:99,y:20}})],componentPropAssignments:[{defID:g(8),value:{textValue:''}}]}),
 n(200,null,{type:'SYMBOL',size:{x:50,y:20},stackMode:'HORIZONTAL',componentPropDefs:[{id:g(8),initialValue:{textValue:'default'}}]}),
 n(20,200,{type:'INSTANCE',transform,symbolData:{symbolID:g(300),uniformScaleFactor:3,symbolOverrides:[patch([30],{fontSize:5})]}}),
 n(300,null,{type:'SYMBOL',stackMode:'VERTICAL'}),n(30,300,{type:'TEXT',transform,fontSize:10,textData:'Hi',size:{x:10,y:10}}),n(31,300,{type:'RECTANGLE',transform}),n(32,200,{type:'TEXT',textData:'base',componentPropRefs:[{defID:g(8),componentPropNodeField:'TEXT_DATA'}]})];
 await compare(nodes,[{}, {format:'context'}, {depth:1}, {includeHidden:true}, {offset:2,maxNodes:1}, {maxBytes:4096}, {id:'1:2',depth:2}]);
 for(const change of [{uniformScaleFactor:0},{symbolID:g(404)},{symbolOverrides:[patch([20],{phase:'REMOVED'})]},{symbolID:g(200),symbolOverrides:[patch([20],{overriddenSymbolID:g(200)})]}]){
  const altered=structuredClone(nodes);altered[3].symbolData={...altered[3].symbolData,...change};await compare(altered,[{}]);
 }
});
test('native variable resolution agrees for mode inheritance, aliases, cycles and conflicts',native,async()=>{
 for(let scenario=0;scenario<10;scenario++){
  const a=variable(101,alias(102),alias(102)),b=variable(102,literal(8),literal(16));const set=structuredClone(collection);
  if(scenario===1)b.variableDataValues.entries[1].variableData=literal(8);
  if(scenario===2)b.variableDataValues.entries[0].variableData=alias(101);
  if(scenario===3)b.variableDataValues.entries.pop();
  if(scenario===4)b.variableDataValues.entries.push(b.variableDataValues.entries[0]);
  if(scenario===5)set.variableSetModes[1].id=g(10);
  if(scenario===6)set.variableSetModes.forEach(m=>delete m.sortPosition);
  if(scenario===7)b.variableResolvedType='STRING';
  if(scenario===8)b.backingVariableId=g(404);
  const nodes=[n(9,null,{type:'FRAME',...(scenario%2?mode(11):{})}),n(1,9,{type:'FRAME',size:{x:7,y:5},variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:alias(101)},{variableField:'VISIBLE',variableData:literal(false)},{variableField:'FONT_SIZE',variableData:literal(2)}]}}),set,a,...(scenario===9?[]:[b])];
  await compare(nodes,[{includeHidden:true},{includeHidden:true,format:'context'},{}]);
 }
});
test('native bindings mask unresolved paint/text values and enforce collection limits',native,async()=>{
 const nodes=[n(1,null,{type:'TEXT',textData:{characters:'abc',styleOverrideTable:[{styleID:2,fontSize:10,variableConsumptionMap:{entries:[{variableField:'FONT_SIZE',variableData:literal(3)}]}}]},fillPaints:[{type:'SOLID',opacity:.5,color:{r:1,g:0,b:0,a:1},colorVar:{dataType:'COLOR',value:{colorValue:{r:0,g:1,b:0,a:.5}}}}],effects:[{type:'DROP_SHADOW',radius:2,radiusVar:literal(6)}],variableConsumptionMap:{entries:[{variableField:'LINE_HEIGHT',variableData:literal(5)},{variableField:'UNKNOWN',variableData:literal(1)},{variableField:'WIDTH',variableData:literal('wrong')}]}})];
 await compare(nodes,[{}, {format:'context'}]);
 nodes[0].variableConsumptionMap.entries=Array.from({length:129},(_,i)=>({nodeField:i,variableData:literal(1)}));await compare(nodes,[{}]);
});

test.after(()=>assert.equal(goldenIndex,golden.length));


test('compact scoped reads preserve instance overrides, field selection and byte savings',native,async()=>{
 const nodes=[n(1,null,{type:'FRAME',size:{x:600,y:400},stackMode:'VERTICAL',transform}),
 n(2,1,{type:'INSTANCE',name:'Card',transform,symbolData:{symbolID:g(200),symbolOverrides:[patch([30],{textData:'Unique',fontSize:17})]}}),
 n(3,1,{type:'TEXT',textData:'Outside',fontSize:12}),
 n(200,null,{type:'SYMBOL',size:{x:100,y:50},stackMode:'VERTICAL'}),
 n(30,200,{type:'TEXT',textData:'Default',fontSize:10,size:{x:40,y:20},transform})];
 const q={format:'context',depth:4};
 await compare(nodes,[q,{...q,compact:true},{...q,compact:true,view:'map'},
 {...q,compact:true,nodeIds:['1:2'],depth:1},
 {...q,compact:true,nodeIds:['1:2','I1:2;1:30'],depth:1},
 {...q,compact:true,nodeIds:['I1:2;1:30'],depth:0,fields:['text']},
 {...q,compact:true,nodeIds:['I1:2;1:30'],depth:0,fields:['style']},
 {...q,compact:true,nodeIds:['I1:2;1:30'],depth:0,fields:['layout']}],r=>{
 const [old,compact,map,batch,overlap,text,style,layout]=r;
 assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(old)));
 assert.deepEqual(compact.nodes.map(n=>n.layout.css),old.nodes.map(n=>n.layout.css));
 assert.deepEqual(batch.nodes.map(n=>n.id),['1:2','I1:2;1:30']);
 assert.equal(new Set(overlap.nodes.map(n=>n.id)).size,overlap.nodes.length);
 assert.equal(text.nodes.length,1);assert.equal(text.nodes[0].text,'Unique');assert.equal(text.nodes[0].layout,undefined);
 assert.equal(text.nodes[0].style.text.base.css['font-size'],'17px');
 assert.equal(style.nodes[0].style.css['font-size'],'17px');assert.equal(style.nodes[0].layout,undefined);
 assert.equal(layout.nodes[0].layout.css['font-size'],'17px');assert.equal(layout.nodes[0].style,undefined);
 assert.equal(map.nodes.find(n=>n.id==='1:2').hasChildren,true);assert.equal(map.nodes.find(n=>n.id==='I1:2;1:30').hasChildren,false);
 for(const n of compact.nodes){assert.equal(n.properties,undefined);assert.equal(n.layout.cssText,undefined);assert.equal(n.style.css,undefined);}
 });
});

test('vector descendants are compact but exact node reads retain full details',native,async()=>{
 const nodes=[n(1,null,{type:'FRAME',transform}),n(2,1,{type:'VECTOR',name:'Letter',transform,size:{x:10,y:20},fillPaints:[{type:'SOLID',color:{r:1,g:0,b:0,a:1}}]})];
 await compare(nodes,[{format:'context',compact:true},{format:'context',compact:true,nodeIds:['1:2'],depth:0},{format:'context',compact:true,id:'1:2',depth:0}],results=>{
  const summary=results[0].nodes.find(n=>n.id==='1:2');
  assert.match(summary.detailsOmitted,/Vector summary/);
  assert.ok(summary.layout.geometry);
  for(const result of results.slice(1)) {
   assert.equal(result.nodes[0].detailsOmitted,undefined);
   assert.ok(result.nodes[0].style);
   assert.ok(JSON.stringify(summary).length < JSON.stringify(result.nodes[0]).length);
  }
 });
});

test('individual badge letters retain text and CSS without repeating full text styles',native,async()=>{
 const nodes=[n(1,null,{type:'FRAME',transform}), ...['я','а','\u2005','More text'].map((text,i)=>n(i+2,1,{type:'TEXT',name:'Badge',textData:text,transform,fontSize:12,size:{x:10,y:20}}))];
 await compare(nodes,[{format:'context',compact:true},{format:'context',compact:true,nodeIds:['1:2'],depth:0},{format:'context',compact:true,id:'1:2',depth:0}],results=>{
  const letters=results[0].nodes.filter(n=>n.type==='TEXT' && n.text!=='More text');
  assert.equal(letters.length,3);
  for(const letter of letters){
   assert.match(letter.detailsOmitted,/Glyph summary/);
   assert.equal(letter.layout.css['font-size'],'12px');
   assert.ok(letter.layout.geometry);
  }
  assert.equal(results[0].nodes.find(n=>n.text==='More text').detailsOmitted,undefined);
  for(const result of results.slice(1)){
   assert.equal(result.nodes[0].text,'я');
   assert.equal(result.nodes[0].detailsOmitted,undefined);
   assert.ok(result.nodes[0].style.text);
   assert.ok(JSON.stringify(result.nodes[0]).length>JSON.stringify(letters.find(n=>n.text==='я')).length);
  }
 });
});
