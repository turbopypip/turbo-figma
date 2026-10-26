import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,copyFile,open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultBinary } from './host.mjs';
import { workspace,nodeInput,hash } from './stage6-common.mjs';
import { statistics } from '../network-benchmark/series.mjs';
import { readRss } from '../network-benchmark/rss.mjs';
import { verify } from '../rust-corpus/verify.mjs';
import { fixtures,wireCapture } from '../rust-corpus/fixtures.mjs';
const root=path.resolve('.cache/figma-network');await mkdir(root,{recursive:true});
const directory=await mkdtemp(path.join(root,'stage6-benchmark-'));
const driver=fileURLToPath(new URL('./stage6-driver.mjs',import.meta.url));
const runs=Number(process.env.STAGE6_RUNS??30),warmRuns=Number(process.env.STAGE6_WARM_RUNS??100);
const sources=['rust/helper/src/main.rs','rust/helper/src/frame.rs','rust/helper/src/stage6.rs','scripts/rust-helper/stage6-common.mjs','scripts/rust-helper/stage6-host.mjs','scripts/rust-helper/stage6-driver.mjs','scripts/rust-helper/stage6-measure.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async f=>[f,hash(await readFile(f))])));
const report={version:1,sourceHashes,runId:path.basename(directory),date:new Date().toISOString(),metadata:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,os:os.release(),arch:process.arch,cpu:os.cpus()[0].model,ram:os.totalmem(),cargoLock:hash(await readFile('rust/helper/Cargo.lock')),binary:hash(await readFile(defaultBinary))},thresholds:{timePercent:20,memoryPercent:15,otherRegressionPercent:5,fullColdPercent:10},cases:[]};
async function execute(command,args,label,sample=false){
 const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let out='',err='',helperPid;const samples=[];
 child.stdout.on('data',b=>{out+=b;const m=/"helperPid":(\d+)/.exec(out);if(m)helperPid=Number(m[1]);});child.stderr.on('data',b=>err+=b);
 let done=false;const observerCpu=process.cpuUsage();
 const sampling=sample?(async()=>{while(!done){const pids=[child.pid,...(helperPid?[helperPid]:[])];try{const m=await readRss(pids);if(pids.every(p=>m.has(p)))samples.push({at:performance.now(),rss:Object.fromEntries(m),sum:[...m.values()].reduce((a,b)=>a+b,0)});}catch{}if(!done)await new Promise(r=>setTimeout(r,10));}})():Promise.resolve();
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});done=true;clearTimeout(timer);await sampling;
 await writeFile(path.join(directory,label+'.raw.json'),JSON.stringify({code,out,err,samples,observerCpu:process.cpuUsage(observerCpu)},null,2));
 if(code!==0)throw Error(`${label}: ${err}`);
 const result=JSON.parse(out.trim().split('\n').at(-1));const m=/STAGE6_METRICS (.+)/.exec(err);if(m)result.metrics={...JSON.parse(m[1])};
 result.sampledTotalRssBytes=samples.length?Math.max(...samples.map(s=>s.sum)):null;
 result.sampleCount=samples.length;return result;
}
for(const name of ['real','typical','beyond-selection-cache']){
 let w;
 if(name==='real'){
  const source=path.resolve('.cache/figma-network/rust-corpus-real');report.realCorpus=await verify(source);
  const m=JSON.parse(await readFile(path.join(source,'snapshot/ready.json')));
  // Create a managed project, then preserve the frozen part boundaries verbatim.
  w=await workspace([{version:1,kind:'ws-received',session:'init',requestId:'init',opcode:2,eventSequence:0,payload:'AQ=='}],{snapshot:m.snapshot});
  for(let i=0;i<m.parts.length;i++)await copyFile(path.join(source,`snapshot/part-${i}.bin`),path.join(w.directory,`part-${i}.bin`));
  await copyFile(path.join(source,'snapshot/ready.json'),path.join(w.directory,'ready.json'));
 }else{const f=fixtures().find(f=>f.id===name);w=await workspace(wireCapture(f.nodes).records);}
 const file=await open(path.join(w.directory,'frames.bin'),'wx');const frameHashes=[];
 try{for await(const b of nodeInput(w)){const schema=b.subarray(0,8).toString()==='fig-wire',data=schema?b.subarray(12):b;const h=Buffer.alloc(8);h.writeUInt32LE(data.length);h.writeUInt32LE(schema?2*1024*1024:64*1024*1024,4);await file.write(h);await file.write(data);frameHashes.push(hash(data));}}finally{await file.close();}
 const c={name,project:w.project,frameHashes,raw:[],summary:{}};report.cases.push(c);
 for(const phase of ['input','inflate']){
  for(const mode of ['cold','warm']){
   const config={directory:w.directory,project:w.project,snapshot:w.snapshot,runs:mode==='warm'?warmRuns:1,warmup:mode==='warm'?10:0};await writeFile(w.config,JSON.stringify(config));
   const results=phase==='input'?{node:[],rust:[],hybrid:[]}:{node:[],rust:[]};
   for(let i=0;i<(mode==='cold'?runs:1);i++)for(const implementation of (i%2?Object.keys(results).reverse():Object.keys(results))){
    const native=implementation==='rust';const r=await execute(native?defaultBinary:process.execPath,native?['--stage6',phase+'-bench',w.config]:[driver,implementation==='hybrid'?'input-hybrid':phase+'-bench',w.config],`${name}-${phase}-${mode}-${implementation}-${i}`,mode==='cold');
    results[implementation].push(r);c.raw.push({phase,mode,implementation,index:i,...r});
   }
   for(const impl of Object.keys(results))for(const r of results[impl])assert.deepEqual(r.result,results.node[0].result);
   c.summary[phase+'-'+mode]=Object.fromEntries(Object.entries(results).map(([impl,rs])=>[impl,{timeMs:statistics(rs.flatMap(r=>r.times)),cpuProcessMs:statistics(rs.map(r=>r.metrics.cpuMs)),cpuWorkMs:statistics(rs.map(r=>r.workCpuMs)),peakRssBytes:statistics(rs.map(r=>r.metrics.maxRssBytes??r.metrics.hostMaxRssBytes)),sampledTotalRssBytes:statistics(rs.map(r=>r.sampledTotalRssBytes))}]));
   console.log(`${name} ${phase} ${mode} complete`);
   await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
  }
 }
 if(name==='real'){
  const query={url:`https://www.figma.com/design/${w.snapshot.fileKey}/File?node-id=2227-70450`,format:'context',depth:12,maxNodes:200,maxBytes:24000,offset:0,includeHidden:false};
  // Use the frozen small-selection query, including its original node ID.
  const manifest=JSON.parse(await readFile('.cache/figma-network/rust-corpus-real/manifest.json'));Object.assign(query,manifest.cases.find(c=>c.id==='real-small').query);
  await writeFile(w.config,JSON.stringify({directory:w.directory,project:w.project,snapshot:w.snapshot,query,runs:1,warmup:0}));
  const results={node:[],rust:[]};
  for(let i=0;i<runs;i++)for(const implementation of (i%2?['rust','node']:['node','rust'])){
   const r=await execute(process.execPath,[driver,`pipeline-${implementation}`,w.config],`real-pipeline-${implementation}-${i}`,true);results[implementation].push(r);c.raw.push({phase:'pipeline',implementation,index:i,...r});
   assert.deepEqual(r.result,results.node[0].result);
  }
  c.summary.pipeline=Object.fromEntries(Object.entries(results).map(([impl,rs])=>[impl,{timeMs:statistics(rs.flatMap(r=>r.times)),cpuProcessMs:statistics(rs.map(r=>r.metrics.cpuMs)),cpuWorkMs:statistics(rs.map(r=>r.workCpuMs)),sampledTotalRssBytes:statistics(rs.map(r=>r.sampledTotalRssBytes)),hostPeakRssBytes:statistics(rs.map(r=>r.metrics.hostMaxRssBytes)),fallbacks:rs.reduce((s,r)=>s+r.fallbacks,0)}]));
  console.log('real pipeline complete');
 }
 await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({report:path.join(directory,'report.json')}));
