import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLayoutPages } from '../dist/network-layout-parity.js';
const uiNode = {id:'1:1',layout:{css:{padding:'8px',width:'100px'},sizing:{width:{mode:'fixed',measured:'100px'}}}};
const netNode = {id:'1:1',layout:{css:{'padding-top':'8px','padding-right':'8px','padding-bottom':'8px','padding-left':'8px',width:'100px'},sizing:{width:{mode:'fixed'}},geometry:{size:{width:100}}}};
const ui = (nodes=[uiNode])=>({fileKey:'test',node:{id:'1:1'},nodes,traversal:{complete:true}});
const net = (nodes=[netNode])=>({fileKey:'test',rootId:'1:1',nodes,traversal:{nextOffset:null}});
const compare = (u=ui(),n=net())=>compareLayoutPages([u],[n],{sameStateEvidence:'fixture same snapshot'});
test('parity accepts equal layout including padding shorthand and float32 inspector rounding',()=>{
 assert.equal(compare().accepted,true);
 const n=structuredClone(netNode);n.layout.geometry.size.width=100.000002;
 assert.equal(compare(ui(),net([n])).accepted,true);
 n.layout.geometry.size.width=100.02;assert.equal(compare(ui(),net([n])).accepted,false);
});
test('parity fails for missing fields, nodes, extras, omitted properties and unresolved instances',()=>{
 const n=structuredClone(netNode);delete n.layout.css['padding-left'];delete n.layout.sizing.width;
 const r=compare(ui(),net([n,{id:'1:2',instanceUnresolved:true}]));
 assert.equal(r.accepted,false);assert.ok(r.issues.some(i=>i.kind==='missing-property'&&i.property==='css.padding-left'));
 assert.ok(r.issues.some(i=>i.kind==='extra-node'));assert.ok(r.issues.some(i=>i.kind==='unresolved-instance'));
 assert.ok(compare(ui(),net([])).issues.some(i=>i.kind==='missing-node'));
 assert.equal(compare(ui(),net([{...netNode,propertiesOmitted:'too large'}])).accepted,false);
});
test('parity fails closed on incomplete baselines, missing pages, duplicate IDs and unverified state',()=>{
 for(const traversal of [undefined,{complete:false},{complete:false,nextRequest:{afterNodeId:'1:1'}},{complete:true,pending:[{reason:'depth limit'}]}])
   assert.equal(compare({...ui(),traversal}).accepted,false);
 assert.equal(compare(ui(),{...net(),traversal:{nextOffset:1}}).accepted,false);
 assert.equal(compare(ui([uiNode,uiNode])).accepted,false);
 assert.equal(compareLayoutPages([ui()],[net()]).accepted,false);
 assert.equal(compare({...ui(),fileKey:'other'}).accepted,false);
});
test('parity compares geometry retained outside css and does not accept missing Top or Rotation',()=>{
 const n=structuredClone(uiNode);n.layout.source={Top:'4.5px',Rotation:'-180°'};
 const r=compare(ui([n]));assert.equal(r.accepted,false);
 assert.deepEqual(r.issues.map(i=>i.property),['inspector.Top','inspector.Rotation']);
});
test('bare inspector dimensions are explicitly recorded as parser corrections, never treated as Fixed evidence',()=>{
 const u=structuredClone(uiNode);u.layout.source={Width:'100px'};
 const n=structuredClone(netNode);n.layout.sizing.width.mode='fill';delete n.layout.css.width;n.layout.measuredCss={width:'100px'};
 const r=compare(ui([u]),net([n]));assert.equal(r.accepted,true);assert.equal(r.baselineCorrections.length,1);
 n.layout.measuredCss.width='101px';assert.equal(compare(ui([u]),net([n])).accepted,false);
});
test('instance aliases require a complete matching ordered structure and preserve every node',()=>{
 const u={...uiNode,id:'9:1',name:'Icon',depth:1,parentId:'1:1'};
 const n={...netNode,id:'I1:1;1:2',name:'Icon',depth:1,parentId:'1:1'};
 const rootU={...uiNode,name:'Root',depth:0},rootN={...netNode,name:'Root',depth:0};
 const r=compareLayoutPages([ui([rootU,u])],[net([rootN,n])],{sameStateEvidence:'fixture',alignInstanceIds:true});
 assert.equal(r.accepted,true);assert.equal(r.identityMappings.length,1);
 const bad=compareLayoutPages([ui([rootU,u])],[net([rootN,{...n,name:'Other'}])],{sameStateEvidence:'fixture',alignInstanceIds:true});
 assert.equal(bad.accepted,false);assert.ok(bad.issues.some(i=>i.kind==='instance-identity-structure-mismatch'));
});
test('reported unavailable fields and capture losses cannot pass even when their values happen to match',()=>{
 const n=structuredClone(netNode);n.layout.unavailable=['sizing.width'];
 assert.ok(compare(ui(),net([n])).issues.some(i=>i.kind==='unavailable-property'));
 assert.equal(compare(ui(),{...net(),captureWarnings:['dropped event']}).accepted,false);
 assert.equal(compare(ui(),{...net(),ignoredLiveBatches:1}).accepted,false);
});

test('public context parity reads normalized coordinates and consumes every page without accepting omissions',()=>{
 const u=structuredClone(uiNode);u.layout.source={Top:'4px',Rotation:'0°'};
 const n=structuredClone(netNode);n.layout.source={Top:'4px',Rotation:'0°'};
 const childU={...uiNode,id:'1:2'},childN={...netNode,id:'1:2'};
 const pages=[{...net([n]),truncated:true,childrenTruncated:true,traversal:{continuation:'next',nextOffset:1,eligibleRecords:2}},
  {...net([childN]),traversal:{nextOffset:null,eligibleRecords:2}}];
 const check=()=>compareLayoutPages([ui([u,childU])],pages,{sameStateEvidence:'fixture'});
 assert.equal(check().accepted,true);
 n.layout.unresolved=[{property:'sizing.width',reason:'unknown'}];
 assert.ok(check().issues.some(i=>i.kind==='unavailable-property'));
 delete n.layout.unresolved;
 n.propertiesOmitted='too large';assert.equal(check().accepted,false);delete n.propertiesOmitted;
 pages[0].traversal.pendingDepthCount=1;assert.equal(check().accepted,false);delete pages[0].traversal.pendingDepthCount;
 pages.pop();assert.equal(check().accepted,false);
});
