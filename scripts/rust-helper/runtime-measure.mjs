import {NetworkStore} from '../../dist/network-store.js';
// Small public-reader integration diagnostic; not stage-13 performance acceptance.
import {readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {workspace} from './stage6-common.mjs';
import {readStoredNetworkSnapshot,releaseNetworkSelection} from '../../dist/network-reader.js';
const root=path.resolve('.cache/figma-network/rust-corpus-real');
const probe=JSON.parse(await readFile(path.join(root,'probe.json')));
const w=await workspace(probe.events.filter(e=>e.kind==='ws-received').map((e,eventSequence)=>({version:1,kind:'ws-received',session:'real',requestId:'real',opcode:2,eventSequence,payload:e.payload})));
const results=[];
try {
 for(const [scenario,id] of [['component','3215:21227'],['section','3215:21204']])for(let run=0;run<3;run++)for(const backend of run%2?['rust','node']:['node','rust']) {
  process.env.FIGMA_NETWORK_BACKEND=backend;
  const store=await NetworkStore.create(w.project);
  if(store.native!==(backend==='rust'))throw Error('Unexpected store backend');
  const q={url:`https://www.figma.com/design/corpus/File?node-id=${id.replace(':','-')}`,format:'context',depth:12,maxNodes:200,maxBytes:24000,offset:0,includeHidden:false,variablesFile:path.join(root,'profile-ui-kit.variables.scss')};
  const pages=async()=>{let continuation,pages=0,nodes=0,firstMs;const start=performance.now();do{const r=await readStoredNetworkSnapshot(store,w.snapshot,{...q,continuation});firstMs??=performance.now()-start;continuation=r.traversal.continuation;nodes+=r.nodes.length;pages++;if(pages>100)throw Error('Unexpected page count');}while(continuation);return {firstMs,totalMs:performance.now()-start,pages,nodes};};
  const cold=await pages(),warm=await pages();
  const diagnostic=await readStoredNetworkSnapshot(store,w.snapshot,{...q,format:'debug',maxNodes:1});
  if(diagnostic.metrics.backend!==backend||diagnostic.metrics.rustFallback)throw Error('Unexpected backend or fallback');
  results.push({scenario,backend,run,cold,warm});await releaseNetworkSelection();
 }
 const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
 const summary=[];for(const scenario of ['component','section'])for(const backend of ['node','rust']){const rows=results.filter(r=>r.scenario===scenario&&r.backend===backend);summary.push({scenario,backend,coldFirstMs:median(rows.map(r=>r.cold.firstMs)),coldAllMs:median(rows.map(r=>r.cold.totalMs)),warmAllMs:median(rows.map(r=>r.warm.totalMs)),pages:rows[0].cold.pages,nodes:rows[0].cold.nodes});}
 const report={date:'2026-10-26',platform:process.platform,arch:process.arch,node:process.version,method:'3 runs per backend/selection, alternating order, one host, fresh retained state per cold run, all context pages with UI-kit; no forced GC; RAM/CPU not measured; diagnostic only',summary,results};
 await writeFile(process.argv[2] ?? 'docs/rust-runtime-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
}finally{await releaseNetworkSelection();await rm(w.project,{recursive:true,force:true});}
