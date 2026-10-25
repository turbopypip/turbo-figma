// Replay source-value preservation and complete pagination; no live UI or production UI-kit claim.
// Usage: node scripts/check-network-variables.mjs CAPTURE_JSON VARIABLES_SCSS SELECTION_URL [context|debug]
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {readNetworkSnapshot,releaseNetworkSelection} from '../dist/network-reader.js';
const [capture,variables,url,format='context']=process.argv.slice(2);
if(!capture||!variables||!url||!['context','debug'].includes(format))throw new Error('Expected CAPTURE_JSON VARIABLES_SCSS SELECTION_URL [context|debug]');
const query={captureFile:resolve(capture),url,format,depth:50,maxNodes:100,maxBytes:150000,offset:0,includeHidden:false};
const read=async variablesFile=>{
 const nodes=[];let continuation,pages=0,maxBytes=0;
 do {
  const r=await readNetworkSnapshot({...query,variablesFile,continuation});
  const bytes=Buffer.byteLength(JSON.stringify(r));assert.ok(bytes<=query.maxBytes);
  assert.equal(r.traversal.pendingDepthCount,0);nodes.push(...r.nodes);pages++;maxBytes=Math.max(maxBytes,bytes);continuation=r.traversal.continuation;
 }while(continuation);
 assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);
 return {nodes,pages,maxBytes};
};
try {
 const original=await read(),mapped=await read(resolve(variables));
 assert.deepEqual(mapped.nodes.map(n=>n.id),original.nodes.map(n=>n.id));
 const statuses={matched:0,ambiguous:0,'not-found':0,unsupported:0};let scopes=0,references=0,colorAmbiguities=0;
 const check=(before,after)=>{
  if(!before)return;
  assert.deepEqual(after.resolvedValues,before.css);scopes++;
  for(const m of after.variableMatching){statuses[m.status]++;if(m.ambiguous&&m.selectionPolicy==='first-literal-color')colorAmbiguities++;}
 };
 original.nodes.forEach((before,i)=>{
  const after=mapped.nodes[i];assert.ok(!before.propertiesOmitted&&!after.propertiesOmitted);
  assert.deepEqual(after.style.nativeBindings,before.style.nativeBindings);references+=after.style.nativeBindings.references.length;
  check(before.layout,after.layout);check(before.style,after.style);
  assert.deepEqual(after.style.source,before.style.source);
  if(before.style.text){check(before.style.text.base,after.style.text.base);assert.equal(after.style.text.ranges.length,before.style.text.ranges.length);
   before.style.text.ranges.forEach((r,j)=>{const s=after.style.text.ranges[j];assert.deepEqual([s.start,s.end,s.source],[r.start,r.end,r.source]);check(r,s);});}
 });
 const report={accepted:true,date:new Date().toISOString(),format,nodes:original.nodes.length,originalPages:original.pages,mappedPages:mapped.pages,maxResponseBytes:mapped.maxBytes,scopes,statuses,colorAmbiguities,nativeReferences:references,
  limitations:['Replay of saved capture; no fresh live UI comparison.','UI-kit file is supplied by caller; production provenance is not inferred.','Native definitions and modes remain unresolved.']};
 const directory=new URL('../.cache/figma-network/variable-checks/',import.meta.url);await mkdir(directory,{recursive:true});
 await writeFile(new URL(`acceptance-${format}.json`,directory),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await releaseNetworkSelection();}
