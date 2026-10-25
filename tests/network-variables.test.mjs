import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVariables} from '../dist/variables.js';
import {mapNetworkNodeVariables,nativeVariableBindings} from '../dist/network-variables.js';
import {networkStyle} from '../dist/network-style.js';
import {BoundedWireDecoder} from '../dist/network-wire.js';
import {compileWireSchema,nodeFields} from '../dist/network.js';
import {parseSchema,compileSchema,encodeBinarySchema} from 'kiwi-schema';

test('network matches retain source values, exact/ambiguous/missing statuses and existing color policy',()=>{
 const variables=parseVariables(':root { --mimir-space-a: 32px; --mimir-space-b: 32px; --mimir-size-text-a: 20px; --red: #f00; --red2: #ff0000; --alias: var(--red); --gos-znak-red: #f00; }');
 const original={layout:{css:{'padding-top':'32px','font-size':'20px',width:'99px',color:'rgba(255, 0, 0, 1)',opacity:'.5'},sizing:{width:{mode:'fill'}}}};
 const n=mapNetworkNodeVariables(original,variables);
 assert.equal(n.layout.css['padding-top'],'32px');assert.equal(n.layout.css['font-size'],'var(--mimir-size-text-a)');
 assert.equal(n.layout.css.width,'99px');assert.equal(n.layout.css.color,'var(--red)');
 assert.deepEqual(n.layout.resolvedValues,original.layout.css);assert.equal(original.layout.css['font-size'],'20px');
 assert.deepEqual(n.layout.variableMatching.map(m=>m.status),['ambiguous','matched','not-found','matched','unsupported']);
 const c=n.layout.variableMatching[3];assert.deepEqual(c.candidates,['--red','--red2']);assert.equal(c.ambiguous,true);assert.equal(c.selectionPolicy,'first-literal-color');
 assert.equal(c.source,'ui-kit-value-match');assert.deepEqual(n.layout.sizing,original.layout.sizing);
});
test('mixed ranges match independently; unresolved Figma references never become UI-kit bindings',()=>{
 const raw={type:'TEXT',fontSize:20,fillPaints:[],variableConsumptionMap:{entries:[{variableField:'FONT_SIZE',variableData:{dataType:'ALIAS',value:{alias:{guid:{sessionID:3,localID:7}}}}}]},
 textData:{characters:'AB',characterStyleIDs:[0,2],styleOverrideTable:[{styleID:2,fontSize:24}]}};
 const style=networkStyle(raw), vars=parseVariables(':root { --mimir-size-text-a:20px; --mimir-size-text-b:24px; }');
 const r=mapNetworkNodeVariables({style},vars);
 assert.deepEqual(r.style.text.ranges.map(r=>r.css['font-size']),['var(--mimir-size-text-a)','var(--mimir-size-text-b)']);
 assert.deepEqual(r.style.text.ranges.map(r=>r.resolvedValues['font-size']),['20px','24px']);
 assert.equal(r.style.css['font-size'],undefined);assert.deepEqual(r.style.nativeBindings,style.nativeBindings);
 assert.equal(r.style.nativeBindings.references[0].variableId,'3:7');assert.equal(r.style.nativeBindings.references[0].status,'unresolved');
 const external=nativeVariableBindings({fillPaints:[{colorVar:{dataType:'ALIAS',value:{alias:{assetRef:{key:'external'}}}}}]});
 assert.equal(external.references[0].variableId,undefined);assert.equal(external.references[0].status,'unresolved');assert.equal(external.complete,false);
});
test('native references decode through both paths; expression payloads are not retained',()=>{
 const schema=parseSchema(`struct GUID { uint sessionID; uint localID; }
 message VariableID { GUID guid = 1; }
 message VariableAnyValue { VariableID alias = 1; string expressionValue = 2; bool boolValue = 3; string textValue = 4; }
 message VariableData { string dataType = 1; VariableAnyValue value = 2; }
 message Entry { string variableField = 1; VariableData variableData = 2; }
 message Map { Entry[] entries = 1; }
 message NodeChange { GUID guid = 1; string phase = 2; Map variableConsumptionMap = 3; }
 message Message { string type = 1; NodeChange[] nodeChanges = 2; }`);
 const wire=encodeBinarySchema(schema), codec=compileSchema(schema);
 const payload=codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:[{guid:{sessionID:1,localID:1},phase:'CREATED',variableConsumptionMap:{entries:[{variableField:'WIDTH',variableData:{dataType:'ALIAS',value:{alias:{guid:{sessionID:5,localID:8}},expressionValue:'x'.repeat(10000),boolValue:false,textValue:'Component text'}}}]}}]});
 const out=[];new BoundedWireDecoder(wire,nodeFields).decode(payload,n=>out.push(n));
 assert.equal(out[0].variableConsumptionMap.entries[0].variableData.value.expressionValue,undefined);
 assert.equal(out[0].variableConsumptionMap.entries[0].variableData.value.boolValue,false);
 assert.equal(out[0].variableConsumptionMap.entries[0].variableData.value.textValue,'Component text');
 assert.equal(nativeVariableBindings(out[0]).references[0].variableId,'5:8');
 assert.deepEqual(compileWireSchema(wire).decodeMessage(payload).nodeChanges,out);
});
test('candidate and native-reference limits are explicit; ambiguity uses full candidate count',()=>{
 const vars=parseVariables(':root {'+Array.from({length:200},(_,i)=>`--mimir-space-${i}:32px;`).join('')+'}');
 const r=mapNetworkNodeVariables({layout:{css:{width:'32px'}}},vars).layout;
 assert.equal(r.css.width,'32px');assert.equal(r.variableMatching[0].status,'ambiguous');assert.equal(r.variableMatching[0].candidateCount,200);
 assert.equal(r.variableMatching[0].candidates.length,32);assert.equal(r.variableMatching[0].candidatesTruncated,true);
 const native=nativeVariableBindings({variableConsumptionMap:{entries:Array.from({length:200},()=>({variableField:'WIDTH',variableData:{}}))}});
 assert.equal(native.references.length,128);assert.ok(native.unresolved.length);
});
