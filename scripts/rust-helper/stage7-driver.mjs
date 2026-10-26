import {readFile,open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {BoundedWireDecoder} from '../../dist/network-wire.js';
import {normalize} from '../rust-corpus/compare.mjs';
import {NetworkStore} from '../../dist/network-store.js';
const [mode,file]=process.argv.slice(2),c=JSON.parse(await readFile(file));
const startCpu=process.cpuUsage();let result;const times=[],schemaTimes=[];
if(mode==='bench'){
 const schema=await readFile(c.schema);
 for(let i=0;i<(c.warmup??0)+(c.runs??1);i++){
  let at=performance.now();const d=new BoundedWireDecoder(schema,new Set(c.fields));const schemaMs=performance.now()-at;
  const f=await open(c.messages);let nodes=0,decodeMs=0;
  try{for(;;){const h=Buffer.alloc(4),r=await f.read(h,0,4,null);if(!r.bytesRead)break;if(r.bytesRead!==4)throw Error('Header truncated');const b=Buffer.alloc(h.readUInt32LE());let n=0;while(n<b.length){const r=await f.read(b,n,b.length-n,null);if(!r.bytesRead)throw Error('Message truncated');n+=r.bytesRead;}const before=performance.now();d.decode(b,()=>nodes++);decodeMs+=performance.now()-before;}}finally{await f.close();}
  if(i>=(c.warmup??0)){times.push(decodeMs);schemaTimes.push(schemaMs);}result={nodes};
 }
}else if(mode==='cold'){
 const reader=await import(pathToFileURL(c.reader).href);const store=await NetworkStore.create(c.project);store.observe(c.snapshot,120000);let nativeCpu=0,fallbacks=0;
 const observe=m=>{if(m.helperPid)console.log(JSON.stringify({helperPid:m.helperPid}));if(m.nativeMetrics)nativeCpu+=m.nativeMetrics.cpuMs??0;if(m.fallback)fallbacks++;};
 // Normalize only expected differences, preserving every semantic field and ordering.

 const at=performance.now();let page=await reader.readStoredNetworkSnapshot(store,c.snapshot,c.query,undefined,observe);times.push(performance.now()-at);
 const hash=createHash('sha256');let pages=0,nodes=0;
 for(;;){hash.update(JSON.stringify(normalize(page)));pages++;nodes+=page.nodes.length;if(!page.traversal.continuation)break;page=await reader.readStoredNetworkSnapshot(store,c.snapshot,{...c.query,continuation:page.traversal.continuation},undefined,observe);if(pages>10000)throw Error('Pagination did not finish');}
 await reader.stopNetworkSelection();result={hash:hash.digest('hex'),pages,nodes,fallbacks};
 const cpu=process.cpuUsage(startCpu);console.log(JSON.stringify({times,result,workCpuMs:(cpu.user+cpu.system)/1000+nativeCpu,metrics:{cpuMs:(process.cpuUsage().user+process.cpuUsage().system)/1000+nativeCpu,maxRssBytes:process.resourceUsage().maxRSS*1024}}));process.exit(0);
}else throw Error('Unknown mode');
const cpu=process.cpuUsage(startCpu);console.log(JSON.stringify({times,schemaTimes,result,workCpuMs:(cpu.user+cpu.system)/1000,metrics:{cpuMs:(process.cpuUsage().user+process.cpuUsage().system)/1000,maxRssBytes:process.resourceUsage().maxRSS*1024}}));
