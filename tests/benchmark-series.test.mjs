import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { statistics, summarizeReports } from '../scripts/network-benchmark/series.mjs';
import { summarizeSamples } from '../scripts/network-benchmark/rss.mjs';
const exec = promisify(execFile);
test('series statistics preserve missing values and use median / nearest-rank p95', () => {
  assert.deepEqual(statistics([null, undefined, NaN]), { samples: 0, missing: 3, median: null, p95: null, max: null });
  assert.deepEqual(statistics([4, 1, null, 3, 2]), { samples: 4, missing: 1, median: 2.5, p95: 4, max: 4 });
  assert.equal(statistics(Array.from({length:100},(_,i)=>i+1)).p95,95);
  const summary = summarizeReports([{success:true, stages:[{name:'warmup-decode-request',durationMs:999},{name:'repeat-decode-request',durationMs:5}]}, {success:false}]);
  assert.equal(summary.stages['warmup-decode-request'],undefined);
  assert.equal(summary.stages['repeat-decode-request'].durationMs.median,5);
  assert.equal(summary.stages['repeat-decode-request'].cpuUserMs.median,null);
});
test('hybrid memory counts simultaneous host and Rust child, excluding simulator and observer', () => {
  const roles = [{name:'mcp',pid:1},{name:'implementation-rust',pid:2},{name:'observer',pid:3},{name:'node-collector-simulator',pid:4}];
  const r = summarizeSamples([{rss:{1:100,2:20,3:9000,4:9000}},{rss:{1:20,2:80}},{rss:{1:500}}],roles);
  assert.equal(r.sampledImplementationPeakBytes,120); assert.equal(r.completeImplementationSamples,2);
  assert.equal(r.sampledMcpPlusSelectedExtensionProcessesBytes,null);
  assert.equal(summarizeSamples([{rss:{1:100}}],roles).sampledImplementationPeakBytes,null);
  assert.throws(()=>summarizeSamples([], [{name:'mcp',pid:1},{name:'mcp',pid:2}]), /unique/);
});
test('missing Rust driver fails explicitly without substituting Node', async () => {
  await assert.rejects(exec(process.execPath,['scripts/measure-network-pipeline.mjs','--implementation','rust','--series','1','--synthetic']), /unavailable/);
});
test('disk series records cold/warm CPU, simultaneous RSS and reproducible fixture', {timeout:60000}, async t => {
  const {stdout} = await exec(process.execPath,['scripts/measure-network-disk.mjs','--series','2','--nodes','12','--name-bytes','16','--warmup','1','--warm-requests','2','--idle-ms','20','--release-ms','1000'], {timeout:55000});
  const output=JSON.parse(stdout), report=JSON.parse(await readFile(output.report,'utf8'));
  t.after(async()=>{for(const r of report.raw)if(r.sourceReport)await rm(path.dirname(r.sourceReport),{recursive:true,force:true}); await rm(path.dirname(output.report),{recursive:true,force:true});});
  assert.equal(report.success,true); assert.equal(report.results.node.stages['cold-decode-request'].durationMs.samples,2);
  assert.equal(report.results.node.stages['repeat-decode-request'].durationMs.samples,4);
  assert.ok(report.results.node.stages['cold-decode-request'].cpuUserMs.median>=0);
  assert.ok(report.results.node.sampledImplementationPeakBytes.max>0);
  assert.equal(report.raw[0].comparable,report.raw[1].comparable);
  const first=JSON.parse(await readFile(report.raw[0].sourceReport,'utf8'));
  assert.equal(first.results[0].metrics.selectionCacheHit,false);
  assert.ok(first.results.slice(1).every(r=>r.metrics.selectionCacheHit));
  assert.ok(first.afterRelease.rss>0);
});

test('external driver contract accepts matching reports and rejects unequal input hashes', {timeout:30000}, async t => {
  const parent=path.resolve('.cache/figma-network/benchmarks'); await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(path.join(parent,'driver-test-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=path.join(dir,'driver.mjs');
  await writeFile(script, `import {readFile,writeFile} from 'node:fs/promises';
const request=JSON.parse(await readFile(process.argv[4],'utf8'));
if(process.argv[3]!=='--benchmark-request'||request.version!==1)throw Error('Bad protocol');
const report=process.argv[4]+'.report.json';
await writeFile(report,JSON.stringify({success:true,fixture:{sha256:process.argv[2]},query:{depth:1},mode:'test-protocol-only',stages:[]}));
console.log(JSON.stringify({report}));`);
  const registry=path.join(dir,'drivers.json');
  const driver=hash=>({command:process.execPath,args:[script,hash],version:'test-only',revision:'fixture',buildFlags:[]});
  await writeFile(registry,JSON.stringify({a:driver('same'),b:driver('same')}));
  const args=['scripts/measure-network-pipeline.mjs','--series','1','--implementation','a,b','--drivers',registry];
  const first=JSON.parse((await exec(process.execPath,args)).stdout);
  t.after(()=>rm(path.dirname(first.report),{recursive:true,force:true})); assert.equal(first.success,true);
  await writeFile(registry,JSON.stringify({a:driver('same'),b:driver('different')}));
  let failure; try {await exec(process.execPath,args);} catch(e){failure=e;}
  assert.ok(failure); const output=JSON.parse(failure.stdout);
  t.after(()=>rm(path.dirname(output.report),{recursive:true,force:true}));
  const report=JSON.parse(await readFile(output.report,'utf8'));
  assert.equal(report.success,false); assert.match(report.raw[1].error,/comparison refused/);
});
