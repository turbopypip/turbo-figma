import {parseSchema, compileSchema, encodeBinarySchema} from 'kiwi-schema';
import {zstd} from '../../tests/wire-fixture.mjs';
export const SEED = 20261025;
export const guid = n => ({sessionID:1,localID:n});
const node = (id,parent,extra={}) => ({guid:guid(id),phase:'CREATED',type:'FRAME',name:`Node ${id}`,stackMode:'VERTICAL',size:{x:100,y:20},...(parent?{parentIndex:{guid:guid(parent),position:String(id).padStart(8,'0')}}:{}),...extra});
export const query = {url:'https://www.figma.com/design/corpus/File?node-id=1-1',format:'context',depth:12,maxNodes:200,maxBytes:24000,offset:0,includeHidden:false};
export function fixtures() {
 let state=SEED;
 const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
 const tree=count=>Array.from({length:count},(_,i)=>node(i+1,i?Math.floor((i-1)/8)+1:0,{opacity:Math.round(random()*100)/100}));
 const alias=n=>({dataType:'ALIAS',value:{alias:{guid:guid(n)}}});
 const literal=n=>({dataType:'FLOAT',value:{floatValue:n}});
 const variable=(id,value)=>node(id,0,{type:'VARIABLE',variableSetID:{guid:guid(100)},variableResolvedType:'FLOAT',variableDataValues:{entries:[{modeID:guid(10),variableData:value}]}});
 return [
  {id:'small',layer:'wire',nodes:tree(9)},
  {id:'typical',layer:'wire',nodes:tree(1000)},
  {id:'beyond-selection-cache',layer:'wire',nodes:tree(4097)},
  {id:'deep-tree',layer:'wire',nodes:Array.from({length:70},(_,i)=>node(i+1,i))},
  {id:'unicode-text-style',layer:'wire',nodes:[node(1),node(2,1,{type:'TEXT',name:'Кириллица 😀 日本語 e\u0301',textData:'Строка\nمرحبا 👨‍👩‍👧‍👦 '.repeat(100),opacity:0,fontSize:16,fontFamily:'Inter'})]},
  {id:'excluded-blob',layer:'wire',nodes:[node(1,0,{ignored:new Uint8Array(131072).fill(42)})]},
  {id:'hidden-order',layer:'wire',nodes:[node(4,3),node(2,1),node(3,1,{visible:false}),node(1)]},
  {id:'instances-overrides',layer:'model',nodes:[node(1),node(2,1,{type:'INSTANCE',symbolData:{symbolID:guid(100),symbolOverrides:[{guidPath:{guids:[guid(20)]},visible:false}]}}),node(100,0,{type:'SYMBOL'}),node(200,100,{overrideKey:guid(20),type:'RECTANGLE'}),node(201,100,{type:'TEXT',textData:'Component text'})]},
  {id:'variables-alias-mode',layer:'model',nodes:[node(1,0,{variableModeBySetMap:{entries:[{variableSetID:{guid:guid(100)},variableModeID:guid(10)}]}}),node(2,1,{variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:alias(101)}]}}),node(100,0,{type:'VARIABLE_SET',name:'Theme',variableSetModes:[{id:guid(10),name:'Default'}]}),variable(101,alias(102)),variable(102,literal(16))]},
  {id:'variables-missing',layer:'model',nodes:[node(1,0,{variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:alias(999)}]}})]},
  {id:'live-supported',layer:'model',nodes:[node(1),node(2,1)],live:[[{guid:guid(2),name:'Updated 😀',opacity:0}],[node(3,1)],[{guid:guid(2),phase:'REMOVED'}]]},
  {id:'live-unsupported',layer:'model',nodes:[node(1)],live:[[{guid:guid(1),unknown:'unsupported'}]],error:'Unsupported live field'},
  {id:'duplicate-node',layer:'model',nodes:[node(1),node(1)],error:'Duplicate'},
  {id:'cycle',layer:'model',nodes:[node(1,2),node(2,1)],error:'Cycle'},
 ];
}
export const schema = parseSchema(`
 enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
 enum Phase { CREATED = 0; REMOVED = 1; }
 struct Guid { uint sessionID; uint localID; }
 struct Parent { Guid guid; string position; }
 struct Vector { float x; float y; }
 message NodeChange { Guid guid = 1; Phase phase = 2; Parent parentIndex = 3; string type = 4; string name = 5; bool visible = 6; float opacity = 7; Vector size = 8; string stackMode = 9; string textData = 10; byte[] ignored = 11; float fontSize = 12; string fontFamily = 13; }
 message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
`);
export const codec=compileSchema(schema);
export const schemaBytes=Buffer.from(encodeBinarySchema(schema));
export function wireCapture(nodes) {
 const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
 const messages=[{type:'JOIN_START'}];
 for(let i=0;i<nodes.length;i+=128)messages.push({type:'NODE_CHANGES',nodeChanges:nodes.slice(i,i+128)});
 messages.push({type:'JOIN_END'});
 const payloads=[Buffer.concat([header,zstd(schemaBytes)]),...messages.map(m=>zstd(codec.encodeMessage(m)))];
 const records=payloads.map((b,eventSequence)=>({version:1,kind:'ws-received',session:'synthetic',requestId:'stream',eventSequence,opcode:2,payload:b.toString('base64')}));
 const probe={version:2,fileUrl:'https://www.figma.com/design/corpus/File',dropped:0,events:[{kind:'ws-open',key:'synthetic:stream',url:'wss://www.figma.com/api/multiplayer/corpus'},...records.map(r=>({kind:r.kind,key:'synthetic:stream',opcode:r.opcode,payload:r.payload}))]};
 return {records,probe};
}
export function damagedCaptures() {
 const original=wireCapture(fixtures()[0].nodes).probe;
 const mutate=(id,edit,error)=>{const probe=structuredClone(original);edit(probe);return {id,probe,error};};
 return [
  mutate('wire-string-limit',p=>p.events[3].payload=zstd(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[node(1,0,{name:'x'.repeat(1024*1024+1)})]})).toString('base64'),'string size'),
  mutate('missing-join-end',p=>p.events.pop(),'Incomplete'),
  mutate('invalid-base64',p=>p.events[2].payload+='\n','Invalid binary payload'),
  mutate('truncated-zstd',p=>p.events[2].payload=Buffer.from(p.events[2].payload,'base64').subarray(0,-1).toString('base64'),'Truncated'),
  mutate('truncated-kiwi',p=>p.events[2].payload=zstd(Buffer.from([1])).toString('base64'),'out of bounds'),
 ];
}
