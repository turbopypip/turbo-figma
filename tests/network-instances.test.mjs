import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {DiskNetworkSnapshot} from '../dist/network-disk.js';
import {enterInstance,instanceNode} from '../dist/network-instances.js';
const guid=n=>({sessionID:1,localID:n});
const patch=(ids,extra)=>({guidPath:{guids:ids.map(guid)},...extra});
const master={guid:guid(100),type:'SYMBOL',stackMode:'HORIZONTAL'};
test('component patches use overrideKey, derived geometry, and outer overrides after nested overrides',()=>{
 const inner={guid:guid(10),overrideKey:guid(99),type:'INSTANCE',symbolData:{symbolID:guid(100),symbolOverrides:[patch([20],{size:{x:4,y:4}})]},derivedSymbolData:[patch([20],{size:{x:8,y:8}})]};
 const outer={scopes:[{overrides:[patch([99,20],{visible:false})],derived:[patch([99,20],{size:{x:12,y:12}})]}],prefix:'I1:1',symbols:[]};
 const resolved=enterInstance(inner,'I1:1;1:10',()=>master,outer);
 const child=instanceNode({guid:guid(200),overrideKey:guid(20),visible:true},resolved.context);
 assert.equal(child.visible,false);assert.deepEqual(child.size,{x:12,y:12});assert.deepEqual(child.guid,guid(200));
 assert.ok(enterInstance(inner,'1:1',()=>undefined).error);
 assert.throws(()=>enterInstance(inner,'1:1',()=>master,{...outer,symbols:['1:100']}),/cycle/);
});
test('disk traversal expands instances in order, applies visibility and parent sizing, and paginates without master RAM index',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'instances-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 const node=(id,parent,extra)=>({guid:guid(id),phase:'CREATED',...(parent?{parentIndex:{guid:guid(parent),position:String(id)}}:{}),...extra});
 model.acceptMessage({type:'JOIN_START'});
 for(const n of [node(1,null,{type:'FRAME',stackMode:'VERTICAL'}),node(2,1,{type:'INSTANCE',symbolData:{symbolID:guid(100),symbolOverrides:[patch([30],{visible:false})]},derivedSymbolData:[patch([20],{size:{x:40,y:8}})]}),node(100,null,{...master}),node(200,100,{type:'FRAME',overrideKey:guid(20),size:{x:10,y:8},stackChildPrimaryGrow:1}),node(300,100,{type:'RECTANGLE',overrideKey:guid(30)})])model.acceptNode(n);
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const q={format:'debug',url:'https://www.figma.com/design/test/File?node-id=1-1',depth:50,maxNodes:500,offset:0,includeHidden:false};
 const r=model.query(q);
 assert.deepEqual(r.nodes.map(n=>n.id),['1:1','1:2','I1:2;1:200']);
 assert.equal(r.nodes[2].parentId,'1:2');assert.equal(r.nodes[2].layout.sizing.width.mode,'fill');
 assert.equal(r.nodes[2].layout.geometry.size.width,40);assert.equal(r.nodes[1].instanceUnresolved,undefined);
 assert.equal(r.nodes[1].symbolData,undefined);assert.equal(model.selectionCacheStats().nodes,2);
 assert.equal(model.query({...q,includeHidden:true}).nodes.length,4);
 assert.equal(model.query({...q,offset:2,maxNodes:1}).nodes[0].id,'I1:2;1:200');
 assert.equal(model.query({...q,depth:1}).traversal.pendingDepthCount,1);
});
test('component assignments preserve false, merge by definition ID, swap symbols and reject unverified scaling',()=>{
 const instance={guid:guid(2),type:'INSTANCE',symbolData:{symbolID:guid(100),uniformScaleFactor:1},componentPropAssignments:[{defID:guid(9),value:{boolValue:false}},{defID:guid(8),value:{guidValue:guid(102)}}]};
 const r=enterInstance(instance,'1:2',()=>master);
 const hidden=instanceNode({guid:guid(3),visible:true,componentPropRefs:[{defID:guid(9),componentPropNodeField:'VISIBLE'}]},r.context);
 assert.equal(hidden.visible,false);
 const swap=instanceNode({guid:guid(4),componentPropRefs:[{defID:guid(8),componentPropNodeField:'OVERRIDDEN_SYMBOL_ID'}]},r.context);
 assert.deepEqual(swap.overriddenSymbolID,guid(102));
 const merged=instanceNode(instance,{scopes:[{overrides:[patch([2],{componentPropAssignments:[{defID:guid(9),value:{boolValue:true}}]})],derived:[]}],prefix:'I1:1',symbols:[]});
 assert.equal(merged.componentPropAssignments.length,2);assert.equal(merged.componentPropAssignments[0].value.boolValue,true);
 assert.throws(()=>enterInstance({...instance,symbolData:{...instance.symbolData,uniformScaleFactor:2}},'1:2',()=>master),/Scaled instance/);
});

test('component text parameters preserve empty strings, defaults, and report missing/unsupported references',()=>{
 const definition={...master,componentPropDefs:[{id:guid(8),initialValue:{textValue:'default'}}]};
 const instance={guid:guid(2),type:'INSTANCE',symbolData:{symbolID:guid(100)}};
 const text={guid:guid(3),textData:{characters:'original'},componentPropRefs:[{defID:guid(8),componentPropNodeField:'TEXT_DATA'}]};
 const defaultContext=enterInstance(instance,'1:2',()=>definition).context;
 assert.equal(instanceNode(text,defaultContext).textData,'default');
 const assigned=enterInstance({...instance,componentPropAssignments:[{defID:guid(8),varValue:{value:{textValue:''}}}]},'1:2',()=>definition);
 assert.equal(instanceNode(text,assigned.context).textData,'');
 const missing=instanceNode({...text,componentPropRefs:[{defID:guid(99),componentPropNodeField:'TEXT_DATA'}]},defaultContext);
 assert.equal(missing.instanceUnresolved,true);assert.match(missing.instanceError,/absent/);
 const unsupported=instanceNode({...text,componentPropRefs:[{defID:guid(8),componentPropNodeField:'WIDTH'}]},defaultContext);
 assert.equal(unsupported.instanceUnresolved,true);
});

test('structural overrides cannot be ignored as successful expansion, and dependency cycles/depth fail closed',()=>{
 const instance={guid:guid(2),type:'INSTANCE',symbolData:{symbolID:guid(100),symbolOverrides:[patch([20],{phase:'REMOVED'})]}};
 assert.match(enterInstance(instance,'1:2',()=>master).error,/Structural/);
 const moved={...instance,symbolData:{symbolID:guid(100),symbolOverrides:[patch([20],{parentIndex:{guid:guid(99),position:'x'}})]}};
 assert.match(enterInstance(moved,'1:2',()=>master).error,/Structural/);
 assert.throws(()=>enterInstance(instance,'1:2',()=>master,{symbols:Array(32).fill('1:999'),scopes:[]}),/limit/);
 assert.match(enterInstance(instance,'1:2',()=>({...master,type:'FRAME'})).error,/definition/);
});

test('missing definitions suppress raw child fallback, swaps use target descendants and external masters stay off RAM cache',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'component-cases-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 const node=(id,parent,extra)=>({guid:guid(id),phase:'CREATED',...(parent?{parentIndex:{guid:guid(parent),position:String(id)}}:{}),...extra});
 model.acceptMessage({type:'JOIN_START'});
 for(const n of [node(1,null,{type:'FRAME',stackMode:'VERTICAL'}),
  node(2,1,{type:'INSTANCE',symbolData:{symbolID:guid(999)}}),node(3,2,{type:'TEXT',textData:'raw child'}),
  node(4,1,{type:'INSTANCE',name:'Original',overriddenSymbolID:guid(101),symbolData:{symbolID:guid(100)}}),
  node(100,null,{type:'SYMBOL',name:'Original'}),node(200,100,{type:'TEXT',textData:'old'}),
  node(101,null,{type:'SYMBOL',name:'Replacement'}),node(201,101,{type:'TEXT',textData:'new'})])model.acceptNode(n);
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 const q={format:'context',url:'https://www.figma.com/design/test/File?node-id=1-1',depth:50,maxNodes:500,offset:0,includeHidden:false};
 const r=model.query(q);
 assert.deepEqual(r.nodes.map(n=>n.id),['1:1','1:2','1:4','I1:4;1:201']);
 assert.equal(r.nodes[1].component.status,'unresolved');assert.equal(r.nodes[2].name,'Replacement');assert.equal(r.nodes[3].text,'new');
 assert.equal(r.traversal.unresolvedInstanceCount,1);assert.equal(r.components.complete,false);
 assert.ok(r.components.dependencyReads>=4);assert.ok(r.components.dependencyBytes>0);assert.equal(model.selectionCacheStats().nodes,3);
 assert.equal(model.query({...q,offset:3,maxNodes:1}).nodes[0].id,'I1:4;1:201');
 assert.equal(model.query({...q,depth:1}).traversal.pendingDepthCount,1);
});

test('repeated large component dependencies exhaust a bounded read budget without retaining definitions',async t=>{
 const root=path.resolve('.cache/figma-network/tests');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'component-budget-'));
 const model=new DiskNetworkSnapshot('test',dir);t.after(async()=>{model.close();await rm(dir,{recursive:true,force:true});});
 model.acceptMessage({type:'JOIN_START'});
 model.acceptNode({guid:guid(1),phase:'CREATED',type:'FRAME',stackMode:'VERTICAL'});
 model.acceptNode({...master,phase:'CREATED',name:'x'.repeat(900000)});
 for(let i=0;i<80;i++)model.acceptNode({guid:guid(i+1000),phase:'CREATED',parentIndex:{guid:guid(1),position:String(i).padStart(3,'0')},type:'INSTANCE',name:'Small',symbolData:{symbolID:guid(100)}});
 model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
 assert.throws(()=>model.query({format:'context',url:'https://www.figma.com/design/test/File?node-id=1-1',depth:2,maxNodes:1,offset:0,includeHidden:false}),/dependency read budget/);
 assert.ok(model.selectionCacheStats().bytes<100000);
});
