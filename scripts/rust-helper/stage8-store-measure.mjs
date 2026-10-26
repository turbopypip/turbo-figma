// R06 decision baseline. No Rust publication/retention implementation is claimed.
import {readFile,mkdtemp,rm,readdir,stat,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {NetworkStore} from '../../dist/network-store.js';
import {hash} from './stage6-common.mjs';
import {statistics} from '../network-benchmark/series.mjs';
const source=path.resolve('.cache/figma-network/rust-corpus-real/snapshot');
if(process.argv[2]==='child'){
 const ready=JSON.parse(await readFile(path.join(source,'ready.json'))),parts=await Promise.all(ready.parts.map((_,i)=>readFile(path.join(source,`part-${i}.bin`))));
 const project=await mkdtemp(path.resolve('.cache/figma-network/stage8-store-'));
 try{const store=await NetworkStore.create(project),cpu=process.cpuUsage();let t=performance.now();const writer=await store.begin(ready.snapshot);
 for(let i=0;i<parts.length;i++)await writer.append(i,parts[i]);
 await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:parts.length});const publishMs=performance.now()-t;
 t=performance.now();const m=await store.readManifest(ready.snapshot);let bytes=0;await store.withRead(async()=>{for(let i=0;i<m.parts.length;i++){const b=await store.readPart(ready.snapshot,i);if(hash(b)!==ready.parts[i].sha256)throw Error('Part changed');bytes+=b.length;}});const readVerifyMs=performance.now()-t;
 t=performance.now();const info=await store.info();const inventoryMs=performance.now()-t;
 const generation=path.join(store.root,hash(JSON.stringify([ready.snapshot.fileKey,null,null,ready.snapshot.sessionId,ready.snapshot.generation])));const files=await readdir(generation);const sizes=await Promise.all(files.map(f=>stat(path.join(generation,f))));
 t=performance.now();await store.clean('all');const cleanMs=performance.now()-t;const use=process.cpuUsage(cpu);
 console.log(JSON.stringify({publishMs,readVerifyMs,inventoryMs,cleanMs,cpuMs:(use.user+use.system)/1000,maxRssBytes:process.resourceUsage().maxRSS*1024,parts:parts.length,partBytes:bytes,logicalFileWrites:parts.length+2,maxOutstandingAppends:1,maxPartBytes:Math.max(...parts.map(b=>b.length)),scratchBytes:sizes.reduce((n,s)=>n+s.size,0),allocatedScratchBytes:sizes.reduce((n,s)=>n+s.blocks*512,0),info}));
 }finally{await rm(project,{recursive:true,force:true});}
}else{
 const dir=await mkdtemp(path.resolve('.cache/figma-network/stage8-store-benchmark-'));const rows=[];
 for(let i=0;i<30;i++){const child=spawn(process.execPath,[process.argv[1],'child'],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});if(code!==0)throw Error(err);rows.push(JSON.parse(out));}
 const report={runId:path.basename(dir),date:new Date().toISOString(),sourceManifestSha256:hash(await readFile(path.join(source,'ready.json'))),scriptSha256:hash(await readFile(process.argv[1])),method:'30 fresh Node processes; unchanged 15 real parts; serial awaited append, fsync and atomic publication; OS cache not flushed; source buffers loaded before timed work; read verifies source hash in addition to NetworkStore verification; no slow-disk simulation',summary:Object.fromEntries(Object.keys(rows[0]).filter(k=>typeof rows[0][k]==='number').map(k=>[k,statistics(rows.map(r=>r[k]))])),rows};
 await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:path.join(dir,'report.json')}));
}
