import test from 'node:test';
import assert from 'node:assert/strict';
import {scaleNode,instanceScale} from '../dist/network-scale.js';
import {enterInstance,instanceNode} from '../dist/network-instances.js';
import {nativeVariableBindings,effectiveVariableNode} from '../dist/network-variables.js';
const guid=n=>({sessionID:1,localID:n});
const patch=(ids,extra)=>({guidPath:{guids:ids.map(guid)},...extra});
test('scale lengths without mutating source, changing matrix basis or dimensionless values',()=>{
 const node={size:{x:100,y:30},minSize:{value:{x:10,y:20}},transform:{m00:0,m01:-1,m02:4,m10:1,m11:0,m12:-3},fontSize:20,
  lineHeight:{value:150,units:'PERCENT'},letterSpacing:{value:-2,units:'PIXELS'},cornerRadius:8,strokeWeight:2,stackSpacing:10,
  opacity:.4,stackChildPrimaryGrow:1,dashPattern:[2,4],effects:[{radius:4,spread:2,offset:{x:4,y:-2},color:{r:1,g:0,b:0,a:.5}}],
  textData:{characters:'ab',characterStyleIDs:[0,1],styleOverrideTable:[{styleID:1,fontSize:40,lineHeight:{value:44,units:'PIXELS'}}]}};
 const before=structuredClone(node),r=scaleNode(node,.5);
 assert.deepEqual(node,before);assert.deepEqual(r.size,{x:50,y:15});assert.deepEqual(r.minSize,{value:{x:5,y:10}});
 assert.deepEqual(r.transform,{m00:0,m01:-1,m02:2,m10:1,m11:0,m12:-1.5});
 assert.equal(r.fontSize,10);assert.equal(r.lineHeight.value,150);assert.equal(r.letterSpacing.value,-1);
 assert.equal(r.cornerRadius,4);assert.equal(r.strokeWeight,1);assert.equal(r.stackSpacing,5);
 assert.equal(r.opacity,.4);assert.equal(r.stackChildPrimaryGrow,1);assert.deepEqual(r.dashPattern,[1,2]);
 assert.equal(r.effects[0].radius,2);assert.deepEqual(r.effects[0].offset,{x:2,y:-1});assert.equal(r.effects[0].color.a,.5);
 assert.equal(r.textData.styleOverrideTable[0].fontSize,20);assert.equal(r.textData.styleOverrideTable[0].lineHeight.value,22);
});
test('nested scale composes, overrides scale before rendered derived patches, instance roots are not scaled twice',()=>{
 const master={guid:guid(100),type:'SYMBOL',size:{x:100,y:100},stackSpacing:10};
 const outer=enterInstance({guid:guid(1),type:'INSTANCE',size:{x:50,y:50},transform:{m02:10,m12:20},symbolData:{symbolID:guid(100),uniformScaleFactor:.5,
  symbolOverrides:[patch([2,3],{fontSize:30})]},derivedSymbolData:[patch([2],{size:{x:12,y:15}}),patch([2,3],{size:{x:7,y:9}})]},'1:1',()=>master);
 assert.equal(outer.effective.stackSpacing,5);assert.equal(outer.effective.size.x,50);assert.equal(outer.effective.transform.m02,10);
 const inner=instanceNode({guid:guid(2),type:'INSTANCE',size:{x:20,y:30},symbolData:{symbolID:guid(200),uniformScaleFactor:2,
  symbolOverrides:[patch([3],{fontSize:12})]}},outer.context);
 const entered=enterInstance(inner,'I1:1;1:2',()=>({...master,guid:guid(200)}),outer.context);
 assert.equal(entered.effective.size.x,12);assert.equal(entered.effective.stackSpacing,10);
 assert.equal(entered.effective.instanceScaleFactor,1);
 const child=instanceNode({guid:guid(3),size:{x:6,y:8},fontSize:10,strokeWeight:2},entered.context);
 assert.equal(child.fontSize,15);assert.equal(child.strokeWeight,2);assert.deepEqual(child.size,{x:7,y:9});
});
test('bound lengths resolve in scaled space while opacity and colors remain unchanged',()=>{
 const binding=(variableField)=>({variableField,variableData:{dataType:'FLOAT'}});
 const n={instanceScaleFactor:.5,size:{x:50,y:16},fontSize:10,opacity:.7,minSize:{value:{x:4}},lineHeight:{value:12,units:'PIXELS'},
  variableConsumptionMap:{entries:['WIDTH','HEIGHT','FONT_SIZE','OPACITY','MIN_WIDTH','LINE_HEIGHT'].map(binding)}};
 const values=[100,32,20,.7,8,24];let i=0;
 const bindings=nativeVariableBindings(n,()=>({status:'resolved',value:values[i++]}));
 const r=effectiveVariableNode(n,bindings);
 assert.deepEqual(r.size,{x:50,y:16});assert.equal(r.fontSize,10);assert.equal(r.opacity,.7);assert.equal(r.minSize.value.x,4);assert.equal(r.lineHeight.value,12);
 assert.ok(bindings.references.every(ref=>ref.capturedValueCheck==='matched'));
 assert.equal(bindings.references[0].unscaledValue,100);
});
test('invalid scales and numeric overflow fail explicitly',()=>{
 for(const v of [0,-1,Infinity,NaN,'2',null])assert.throws(()=>instanceScale(v),/Invalid/);
 assert.throws(()=>scaleNode({fontSize:Number.MAX_VALUE},2),/overflow/);
 assert.equal(scaleNode({fontSize:2},1).fontSize,2);
});
