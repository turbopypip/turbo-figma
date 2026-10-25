// Summarize a private index {label: absoluteReportPath} without exporting design content.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { statistics } from './series.mjs';
const [indexFile,outputFile]=process.argv.slice(2);
if(!indexFile||!outputFile)throw Error('Usage: summarize-profile.mjs PRIVATE_INDEX OUTPUT');
const index=JSON.parse(await readFile(indexFile,'utf8')), result={date:new Date().toISOString(),cases:{}};
for(const [label,file] of Object.entries(index)) {
  const r=JSON.parse(await readFile(file,'utf8'));
  if(r.timings&&r.results) {result.cases[label]={runId:path.basename(path.dirname(file)),kind:'diagnostic-stages',runs:r.runs,probeSha256:r.probeSha256,timings:r.timings,counts:r.results[0].counts,
    cpuMs:statistics(r.results.map(x=>(x.cpu.user+x.cpu.system)/1000)),maxRssBytes:statistics(r.results.map(x=>x.maxRssBytes)),selectionCache:r.results[0].selectionCache};continue;}
  const reports=r.raw?await Promise.all(r.raw.map(async x=>{if(!x.success)throw Error(`Failed run in ${label}`);return JSON.parse(await readFile(x.sourceReport,'utf8'));})):[r];
  const stage=(name,fn)=>statistics(reports.flatMap(x=>x.stages.filter(s=>s.name===name).map(fn)));
  const sample={runId:r.runId??path.basename(path.dirname(file)),kind:'mcp-pipeline',runs:reports.length,environment:r.environment,probeSha256:reports[0].fixture.sha256,
    public:reports[0].query.format===undefined,maxBytes:reports[0].query.maxBytes??null,
    stages:r.results?.node.stages??Object.fromEntries(reports[0].stages.map(s=>[s.name,{durationMs:statistics([s.durationMs])}])),
    captureReadyMs:statistics(reports.map(x=>x.captureDurationMs)),
    peakRssBytes:statistics(reports.map(x=>x.accounting.sampledImplementationPeakBytes)),
    idleBeforeRssBytes:stage('idle-before',s=>s.after.memory.rss),retainedRssBytes:stage('idle-retained-selection',s=>s.after.memory.rss),
    release1sRssBytes:stage('release-1s',s=>s.after.memory.rss),releaseFinalRssBytes:stage('idle-after-release',s=>s.after.memory.rss),
    coldCpuMs:stage('cold-decode-request',s=>s.cpuUserMs+s.cpuSystemMs),warmCpuMs:stage('repeat-decode-request',s=>s.cpuUserMs+s.cpuSystemMs),
    warmVerifyMs:stage('repeat-decode-request',s=>s.after.partReads?.durationMs-s.before.partReads?.durationMs),
    warmVerifyBytes:stage('repeat-decode-request',s=>s.after.partReads?.bytes-s.before.partReads?.bytes),
    allPages:reports.map(x=>{const pages=x.pageMeasurements?.filter(p=>p.label==='all-pages')??[];return {pages:pages.length,nodes:pages.reduce((a,p)=>a+p.nodes,0),bytes:pages.reduce((a,p)=>a+p.bytes,0),terminal:pages.at(-1)?.traversal.continuation===null,complete:pages.at(-1)?.traversal.complete,pendingDepth:pages.at(-1)?.traversal.pendingDepthCount};}),
    continuationPageMs:statistics(reports.flatMap(x=>(x.pageMeasurements??[]).filter(p=>p.label==='all-pages').slice(1).map(p=>p.durationMs))),
    workerColdPhasesMs:Object.fromEntries(['decoded','indexed','queried'].map((name,i)=>[name,statistics(reports.map(x=>{const ms=x.workerMeasurements.slice(0,4);return ms[i+1]?.elapsedMs-ms[i]?.elapsedMs;}))])),
    maximumSampleGapMs:statistics(reports.map(x=>x.maximumSampleGapMs)),
    observerCpuMs:statistics(reports.map(x=>x.observer?.cpu ? (x.observer.cpu.user+x.observer.cpu.system)/1000 : null)),
    observerPeakRssBytes:statistics(reports.map(x=>x.observer?.processPeakRssBytes)),
    observerErrors:reports.reduce((n,x)=>n+x.observerErrors,0),fullBudgetAccepted:false};
  result.cases[label]=sample;
}
await writeFile(outputFile,JSON.stringify(result,null,2)+'\n');console.log(outputFile);
