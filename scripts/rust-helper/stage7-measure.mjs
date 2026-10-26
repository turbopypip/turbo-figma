import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,copyFile,open,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {defaultBinary} from './host.mjs';
import {workspace,nodeInput,hash} from './stage6-common.mjs';
import {statistics} from '../network-benchmark/series.mjs';
import {readRss} from '../network-benchmark/rss.mjs';
import {verify} from '../rust-corpus/verify.mjs';
import {fixtures,wireCapture,query} from '../rust-corpus/fixtures.mjs';
import {inflateFrame,nodeFields} from '../../dist/network.js';
const root=path.resolve('.cache/figma-network');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'stage7-benchmark-'));
const runs=Number(process.env.STAGE7_RUNS??30),warmRuns=Number(process.env.STAGE7_WARM_RUNS??100);
const sources=['rust/helper/src/wire.rs','rust/helper/src/stage7.rs','rust/helper/src/stage6.rs','rust/helper/src/main.rs','scripts/rust-helper/stage7-host.mjs','scripts/rust-helper/stage7-driver.mjs','scripts/rust-helper/stage7-measure.mjs','scripts/rust-helper/stage6-host.mjs'];
const report={runId:path.basename(dir),date:new Date().toISOString(),thresholds:{timePercent:20,memoryPercent:15,otherRegressionPercent:5,fullColdPercent:10},metadata:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,os:os.release(),arch:process.arch,cpu:os.cpus()[0].model,binary:hash(await readFile(defaultBinary)),cargoLock:hash(await readFile('rust/helper/Cargo.lock'))},sourceHashes:Object.fromEntries(await Promise.all(sources.map(async f=>[f,hash(await readFile(f))]))),cases:[]};
const copied=path.join(dir,'dist');await cp(path.resolve('dist'),copied,{recursive:true});
let worker=await readFile(path.join(copied,'network-worker.js'),'utf8');
const old='for await (const event of storedEvents(workerData.projectDirectory, workerData.snapshot))\n            consume(event);';assert.ok(worker.includes(old));
worker=worker.replace(old,`const { compatibleDecode } = await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/rust-helper/stage7-host.mjs')).href)});
        const { readFile } = await import('node:fs/promises');
        const config = JSON.parse(await readFile(process.env.STAGE7_CONFIG, 'utf8'));
        await compatibleDecode({...config,config:process.env.STAGE7_CONFIG}, item => {
          if(item.kind==='S'){model.setLayoutSchemaHash(createHash('sha256').update(item.value).digest('hex')); liveCodec=new BoundedWireDecoder(item.value,liveFields);}
          else if(item.kind==='N')model.acceptNode(item.value);
          else model.acceptMessage(item.value);
        },{onPid:helperPid=>parentPort.postMessage({measurement:{helperPid}}),onMetrics:nativeMetrics=>parentPort.postMessage({measurement:{nativeMetrics}}),onFallback:()=>parentPort.postMessage({measurement:{fallback:true}})});`);
await writeFile(path.join(copied,'network-worker.js'),worker);
async function execute(command,args,label,config){
 const child=spawn(command,args,{env:{...process.env,STAGE7_CONFIG:config},stdio:['ignore','pipe','pipe']});let out='',err='',helperPid,done=false;const samples=[];
 child.stdout.on('data',b=>{out+=b;const m=/"helperPid":(\d+)/.exec(out);if(m)helperPid=Number(m[1]);});child.stderr.on('data',b=>err+=b);
 const observer=process.cpuUsage();const sampling=(async()=>{while(!done){const pids=[child.pid,...(helperPid?[helperPid]:[])];try{const m=await readRss(pids);if(pids.every(p=>m.has(p)))samples.push({rss:Object.fromEntries(m),sum:[...m.values()].reduce((a,b)=>a+b,0)});}catch{}if(!done)await new Promise(r=>setTimeout(r,10));}})();
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});done=true;clearTimeout(timer);await sampling;
 await writeFile(path.join(dir,label+'.json'),JSON.stringify({code,out,err,samples,observerCpu:process.cpuUsage(observer)},null,2));if(code!==0)throw Error(`${label}: ${err}`);
 const r=JSON.parse(out.trim().split('\n').at(-1)),m=/STAGE6_METRICS (.+)/.exec(err);if(m)r.metrics=JSON.parse(m[1]);r.sampledTotalRssBytes=samples.length?Math.max(...samples.map(s=>s.sum)):null;return r;
}
const summary=rs=>({timeMs:statistics(rs.flatMap(r=>r.times)),schemaMs:statistics(rs.flatMap(r=>r.schemaTimes??[])),cpuWorkMs:statistics(rs.map(r=>r.workCpuMs)),cpuProcessMs:statistics(rs.map(r=>r.metrics.cpuMs)),peakRssBytes:statistics(rs.map(r=>r.metrics.maxRssBytes)),sampledTotalRssBytes:statistics(rs.map(r=>r.sampledTotalRssBytes))});
for(const name of (process.env.STAGE7_CASES??'real,typical,beyond-selection-cache').split(',')){
 let w,q=query;
 if(name==='real'){
  const source=path.resolve('.cache/figma-network/rust-corpus-real');report.realCorpus=await verify(source);const m=JSON.parse(await readFile(path.join(source,'snapshot/ready.json')));
  w=await workspace([{version:1,kind:'ws-received',session:'init',requestId:'init',opcode:2,eventSequence:0,payload:'AQ=='}],{snapshot:m.snapshot});
  for(let i=0;i<m.parts.length;i++)await copyFile(path.join(source,`snapshot/part-${i}.bin`),path.join(w.directory,`part-${i}.bin`));await copyFile(path.join(source,'snapshot/ready.json'),path.join(w.directory,'ready.json'));
  const mfest=JSON.parse(await readFile(path.join(source,'manifest.json')));q={...query,...mfest.cases.find(c=>c.id===(process.env.STAGE7_SELECTION??'real-small')).query};
  if(process.env.STAGE7_VARIABLES){q.variablesFile=path.resolve(process.env.STAGE7_VARIABLES);report.variablesHash=hash(await readFile(q.variablesFile));}
 }else w=await workspace(wireCapture(fixtures().find(f=>f.id===name).nodes).records);
 const schema=path.join(w.project,'schema'),messages=path.join(w.project,'messages'),f=await open(messages,'wx');
 try{for await(const b of nodeInput(w)){const isSchema=b.subarray(0,8).toString()==='fig-wire',data=inflateFrame(isSchema?b.subarray(12):b);if(isSchema)await writeFile(schema,data);else{const h=Buffer.alloc(4);h.writeUInt32LE(data.length);await f.write(h);await f.write(data);}}}finally{await f.close();}
 const c={name,project:w.project,query:q,inputHashes:{schema:hash(await readFile(schema)),messages:hash(await readFile(messages))},raw:[],summary:{}};report.cases.push(c);
 for(const phase of (process.env.STAGE7_PHASES??'cold,warm,request').split(',')){
  if(phase==='request'&&name!=='real')continue;
  const config={directory:w.directory,project:w.project,snapshot:w.snapshot,fields:[...nodeFields],schema,messages,runs:phase==='warm'?warmRuns:1,warmup:phase==='warm'?10:0,query:q};const results={node:[],rust:[]};
  for(let i=0;i<(phase==='warm'?1:runs);i++)for(const impl of (i%2?['rust','node']:['node','rust'])){
   config.reader=path.resolve(impl==='rust'?path.join(copied,'network-reader.js'):'dist/network-reader.js');await writeFile(w.config,JSON.stringify(config));
   const native=impl==='rust'&&phase!=='request';const r=await execute(native?defaultBinary:process.execPath,native?['--stage7','bench',w.config]:['scripts/rust-helper/stage7-driver.mjs',phase==='request'?'cold':'bench',w.config],`${name}-${phase}-${impl}-${i}`,w.config);
   results[impl].push(r);c.raw.push({phase,implementation:impl,index:i,...r});assert.deepEqual(r.result,results.node[0].result);
  }
  c.summary[phase]=Object.fromEntries(Object.entries(results).map(([impl,rs])=>[impl,summary(rs)]));await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(`${name} ${phase} complete`);
 }
}
console.log(JSON.stringify({report:path.join(dir,'report.json')}));
