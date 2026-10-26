import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,open} from 'node:fs/promises';
import {writeSync,closeSync,openSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {workspace,hash} from './stage6-common.mjs';
import {nodeDecode} from './stage7-host.mjs';
import {rawQuery} from './stage8-host.mjs';
import {nodeFields} from '../../dist/network.js';
import {fixtures,wireCapture} from '../rust-corpus/fixtures.mjs';
import {statistics} from '../network-benchmark/series.mjs';
import {readRss} from '../network-benchmark/rss.mjs';
import {defaultBinary} from './host.mjs';
const root=path.resolve('.cache/figma-network');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'stage8-opt-benchmark-'));
const runs=Number(process.env.STAGE8_RUNS??30), warmProcesses=Number(process.env.STAGE8_WARM_PROCESSES??3);
const oldBinary=path.resolve(process.env.STAGE8_OLD_BINARY??'.cache/figma-network/stage8-opt-baseline/figma-rust-helper');
const sources=['rust/helper/src/disk.rs','rust/helper/src/json.rs','rust/helper/src/stage8.rs','rust/helper/src/wire.rs','rust/helper/src/stage6.rs','rust/helper/src/main.rs','rust/helper/Cargo.toml','scripts/rust-helper/stage8-host.mjs','scripts/rust-helper/stage8-driver.mjs','scripts/rust-helper/stage8-opt-measure.mjs','scripts/rust-helper/stage6-host.mjs'];
const report={runId:path.basename(dir),date:new Date().toISOString(),thresholds:{timePercent:20,warmMinimumMs:2,memoryPercent:15,otherRegressionPercent:5,fullColdPercent:10},metadata:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,os:os.release(),arch:process.arch,cpu:os.cpus()[0].model,binary:hash(await readFile(defaultBinary)),oldBinary:hash(await readFile(oldBinary)),cargoLock:hash(await readFile('rust/helper/Cargo.lock'))},sourceHashes:Object.fromEntries(await Promise.all(sources.map(async f=>[f,hash(await readFile(f))]))),cases:[]};
async function execute(config,impl,label){
 config={...config,...(impl==='rust-before'?{binary:oldBinary}:{})};
 const file=path.join(dir,label+'.config.json');await writeFile(file,JSON.stringify(config));const child=spawn(process.execPath,['scripts/rust-helper/stage8-driver.mjs',impl==='node'?'node':'rust',file],{stdio:['ignore','pipe','pipe']});let out='',err='',helperPid,done=false;const samples=[];const observer=process.cpuUsage();
 child.stdout.on('data',b=>{out+=b;const m=/"helperPid":(\d+)/.exec(out);if(m)helperPid=+m[1];});child.stderr.on('data',b=>err+=b);
 const sampling=(async()=>{while(!done){const pids=[child.pid,...(helperPid?[helperPid]:[])];try{const rss=await readRss(pids);if(pids.every(p=>rss.has(p)))samples.push({timeMs:performance.now(),rss:Object.fromEntries(rss),sum:[...rss.values()].reduce((a,b)=>a+b,0)});}catch{}if(!done)await new Promise(r=>setTimeout(r,10));}})();
 const timer=setTimeout(()=>{child.kill('SIGKILL');if(helperPid)try{process.kill(helperPid,'SIGKILL');}catch{}},180000);
 const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});done=true;clearTimeout(timer);await sampling;
 await writeFile(path.join(dir,label+'.json'),JSON.stringify({code,out,err,samples,observerCpu:process.cpuUsage(observer)},null,2));if(code!==0)throw Error(`${label}: ${err}`);
 const r=JSON.parse(out.trim().split('\n').at(-1));r.sampledTotalRssBytes=samples.length?Math.max(...samples.map(s=>s.sum)):null;return r;
}
function summary(rs,phase){const warm=phase==='warm';return {loadMs:statistics(rs.map(r=>r.loaded.loadMs)),indexMs:statistics(rs.map(r=>r.loaded.indexMs)),queryMs:statistics(rs.flatMap(r=>warm?r.rows.slice(10,110).map(x=>x.ms):r.rows.slice(0,1).map(x=>x.ms))),wallMs:statistics(rs.map(r=>r.wallMs)),cpuMs:statistics(rs.map(r=>r.cpuMs)),sampledTotalRssBytes:statistics(rs.map(r=>r.sampledTotalRssBytes)),scratchBytes:statistics(rs.map(r=>r.loaded.stats.scratchBytes)),allocatedScratchBytes:statistics(rs.map(r=>r.loaded.stats.allocatedScratchBytes)),nodeBytes:statistics(rs.map(r=>r.loaded.stats.nodeBytes)),loadIo:rs[0].loaded.stats.io,queryIo:Object.fromEntries(['reads','readBytes','writes','writeBytes'].map(k=>[k,rs[0].rows[0].stats.io[k]-rs[0].loaded.stats.io[k]])),cache:rs[0].rows[0].stats.cache,releaseCache:rs[0].rows.at(-1).stats.cache};}
for(const name of (process.env.STAGE8_CASES??'real,typical,beyond-selection-cache').split(',')){
 let w,rootId='1:1',other='1:2';
 if(name==='real'){
  const source=path.resolve('.cache/figma-network/rust-corpus-real/snapshot'),ready=JSON.parse(await readFile(path.join(source,'ready.json')));
  w=await workspace([{version:1,kind:'ws-received',session:'init',requestId:'init',opcode:2,eventSequence:0,payload:'AQ=='}],{snapshot:ready.snapshot});
  for(let i=0;i<ready.parts.length;i++)await copyFile(path.join(source,`part-${i}.bin`),path.join(w.directory,`part-${i}.bin`));await copyFile(path.join(source,'ready.json'),path.join(w.directory,'ready.json'));rootId='3215:21200';other='3215:21227';
 }else w=await workspace(wireCapture(fixtures().find(f=>f.id===name).nodes).records);
 const model=path.join(w.project,'model'),fd=openSync(model,'wx');
 try{await nodeDecode({...w,fields:[...nodeFields]},item=>{if(item.kind==='S')return;const b=Buffer.from(JSON.stringify(item)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);for(const data of [h,b]){let p=0;while(p<data.length)p+=writeSync(fd,data,p);}});}finally{closeSync(fd);}
 const c={name,rootId,inputHashes:{manifest:hash(await readFile(path.join(w.directory,'ready.json'))),model:hash(await readFile(model))},summary:{},raw:[]};report.cases.push(c);
 for(const phase of (process.env.STAGE8_PHASES??'managed,warm,churn').split(',')){
  const commands=phase==='warm'?Array.from({length:110},()=>rawQuery(rootId)):phase==='churn'?Array.from({length:100},(_,i)=>rawQuery(i%2?other:rootId,{maxNodes:1})):[rawQuery(rootId)];commands.push({op:'release'});
  const config={directory:w.directory,project:w.project,snapshot:w.snapshot,...(phase==='model'?{model}:{}),commands};const results={node:[],'rust-before':[],rust:[]};
  for(let i=0;i<(phase==='warm'?warmProcesses:phase==='churn'?1:runs);i++)for(const impl of [['node','rust-before','rust'],['rust','node','rust-before'],['rust-before','rust','node']][i%3]){
   const r=await execute(config,impl,`${name}-${phase}-${impl}-${i}`);results[impl].push(r);assert.equal(r.digest,Object.values(results).find(rs=>rs.length)[0].digest);c.raw.push({phase,implementation:impl,index:i,...r});
  }
  c.summary[phase]=Object.fromEntries(Object.entries(results).map(([impl,rs])=>[impl,summary(rs,phase)]));await writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(`${name} ${phase} complete`);
 }
}
console.log(JSON.stringify({report:path.join(dir,'report.json')}));
