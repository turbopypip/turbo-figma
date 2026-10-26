// Experimental storage boundary. Full design-context projection belongs to stage 09.
import {mkdtemp, mkdir, writeFile, rm, open, stat} from 'node:fs/promises';
import path from 'node:path';
import {nativeSession} from './stage6-host.mjs';
import {nodeDecode} from './stage7-host.mjs';
import {DiskNetworkSnapshot} from '../../dist/network-disk.js';
import {nodeFields,safeId} from '../../dist/network.js';
export const rawQuery=(rootId='1:1',extra={})=>({op:'query',rootId,depth:12,maxNodes:200,maxBytes:24000,offset:0,includeHidden:false,...extra});
export async function writeModel(file,nodes){
 const out=await open(file,'wx');
 try {for(const v of [{kind:'M',value:{type:'JOIN_START'}},...nodes.map(value=>({kind:'N',value})),{kind:'M',value:{type:'NODE_CHANGES'}},{kind:'M',value:{type:'JOIN_END'}}]){const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);await out.write(h);await out.write(b);}}finally{await out.close();}
}
async function* modelRecords(file){const f=await open(file,'r');try{for(;;){const h=Buffer.alloc(4);let n=0;while(n<4){const r=await f.read(h,n,4-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}if(!n)return;if(n!==4)throw Error('Truncated model header');const size=h.readUInt32LE();if(size>2*1024*1024)throw Error('Model record limit exceeded');const b=Buffer.alloc(size);n=0;while(n<size){const r=await f.read(b,n,size-n,null);if(!r.bytesRead)throw Error('Truncated model record');n+=r.bytesRead;}yield JSON.parse(b);}}finally{await f.close();}}
// Same raw storage projection on both sides, intentionally not a public MCP response.
export function referenceQuery(d,q){
 const {rootId:key,depth,maxNodes:max,offset}=q,budget=q.maxBytes??24000;
 if(!/^\d+:\d+$/.test(key)||key.split(':').some(n=>!Number.isSafeInteger(+n)||String(+n)!==n))throw Error('Invalid node GUID');
 if(!Number.isInteger(depth)||depth<0||depth>50||!Number.isInteger(max)||max<1||max>500||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(budget)||budget<4096||budget>1048576)throw Error('Invalid traversal limits');
 if(d.selectionId!==key){d.selected.clear();d.selectedBytes=0;d.selectionId=key;}
 let ancestor=d.node(key).parentIndex?.guid;const ancestors=new Set([key]),selectionPath=[];
 while(ancestor){const id=safeId(ancestor);if(ancestors.has(id)||ancestors.size>64)throw Error('Cycle in ancestors or depth limit exceeded');ancestors.add(id);const slot=d.slot(id);if(!slot?.buffer.readUInt32LE(32))break;const n=d.node(id,false);if(n.type==='CANVAS')break;if(n.type!=='DOCUMENT')selectionPath.push(id);ancestor=n.parentIndex?.guid;}
 const stack=[{id:key,depth:0}],seen=new Set(),nodes=[],pendingDepth=[],skippedHidden=[];let eligibleRecords=0,pendingDepthCount=0,skippedHiddenCount=0,bytes=0,full=false;
 while(stack.length){const item=stack.pop();if(seen.has(item.id))throw Error('Cycle in selected tree');seen.add(item.id);if(seen.size>200000)throw Error('Rendered selection node limit exceeded');const n=d.node(item.id);
  if(!q.includeHidden&&n.visible===false){skippedHiddenCount++;if(skippedHidden.length<10)skippedHidden.push(item.id);continue;}
  if(eligibleRecords>=offset&&nodes.length<max&&!full){let entry={id:item.id,depth:item.depth,node:n},len=Buffer.byteLength(JSON.stringify(entry));if(len+1>budget-3072){entry={id:item.id,depth:item.depth,propertiesOmitted:'Node exceeds output limit'};len=Buffer.byteLength(JSON.stringify(entry));}if(bytes+len+1>budget-3072)full=true;else{bytes+=len+1;nodes.push(entry);}}
  eligibleRecords++;
  if(item.depth>=depth){if(d.slot(item.id)?.buffer.readUInt32LE(40)){pendingDepthCount++;if(pendingDepth.length<10)pendingDepth.push(item.id);}}
  else {const children=d.children(item.id);if(!['HORIZONTAL','VERTICAL','GRID'].includes(n.stackMode)&&['GROUP','BOOLEAN_OPERATION','VECTOR','FRAME','SYMBOL','INSTANCE'].includes(n.type))children.reverse();for(let i=children.length-1;i>=0;i--)stack.push({id:children[i],depth:item.depth+1});}
 }
 const next=offset+nodes.length;
 return {rootId:key,nodes,selectionPath,traversal:{eligibleRecords,returned:nodes.length,pendingDepth,skippedHidden,pendingDepthCount,skippedHiddenCount,diagnosticListsTruncated:pendingDepthCount>10||skippedHiddenCount>10,nextOffset:next<eligibleRecords?next:null}};
}
export async function nodeJob(config,consume,{onScratch}={}){
 await mkdir(path.resolve('.cache/figma-network'),{recursive:true});const scratch=await mkdtemp(path.resolve('.cache/figma-network/stage8-node-'));onScratch?.(scratch);
 let d;
 try{d=new DiskNetworkSnapshot(config.snapshot?.fileKey??'corpus',scratch);let indexMs=0;const start=performance.now();
 const accept=item=>{const t=performance.now();if(item.kind==='N')d.acceptNode(item.value);else if(item.kind==='M')d.acceptMessage(item.value);indexMs+=performance.now()-t;};
 if(config.model){for await(const item of modelRecords(config.model))accept(item);}else await nodeDecode({...config,fields:[...nodeFields]},accept);
 d.finish();const loadMs=performance.now()-start;
 const sizes=await Promise.all(['nodes.bin','index.bin','edges.bin','variable-assets.bin'].map(f=>stat(path.join(scratch,f))));
 const stats=()=>({cache:d.selectionCacheStats(),documentRecords:d.count,initialBatches:d.batches,ignoredLiveBatches:d.live,scratchBytes:sizes.reduce((n,s)=>n+s.size,0),nodeBytes:sizes[0].size});
 await consume({kind:'loaded',loadMs,indexMs,stats:stats()});
 for(const q of config.commands){const t=performance.now();let reply;try{let result;switch(q.op){case 'query':result=referenceQuery(d,q);break;case 'lookup':result=d.node(q.id,false);break;case 'children':result=d.children(q.id);break;case 'asset':result=d.variableAssets.get(q.type,q.ref)??null;break;case 'release':d.selected.clear();d.selectedBytes=0;d.selectionId=undefined;result=null;break;default:throw Error('Unknown index command');}reply={result};}catch(e){reply={error:e.message};}await consume({kind:'reply',reply,ms:performance.now()-t,stats:stats(),metrics:{rssBytes:process.memoryUsage().rss}});}
 }finally{d?.close();await rm(scratch,{recursive:true,force:true});}
}
export async function rustJob(config,consume,options={}){
 await mkdir(path.resolve('.cache/figma-network'),{recursive:true});const scratch=await mkdtemp(path.resolve('.cache/figma-network/stage8-rust-'));options.onScratch?.(scratch);let session,emitted=false,consumerError;
 try {const file=path.join(scratch,'config.json');await writeFile(file,JSON.stringify({directory:config.directory,snapshot:config.snapshot,model:config.model,commands:config.commands,fields:[...nodeFields],scratch}));session=nativeSession(config.model?'model':'managed',file,{...options,stage:8});options.onPid?.(session.pid);
  for await(const bytes of session.records()){emitted=true;try{await consume(JSON.parse(bytes));}catch(e){consumerError=e;throw e;}}
  options.onMetrics?.(session.metrics);
 }catch(e){if(!options.fallback||emitted||consumerError||options.signal?.aborted||e.code==='TIMEOUT'||e.code==='ABORTED')throw e;
  await session?.destroy();session=undefined;await rm(scratch,{recursive:true,force:true});options.onFallback?.(e);await nodeJob(config,consume,options);
 }finally{await session?.destroy();await rm(scratch,{recursive:true,force:true});}
}
