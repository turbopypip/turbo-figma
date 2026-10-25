import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixtures, wireCapture } from '../scripts/rust-corpus/fixtures.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const parent=path.resolve('.cache/figma-network/benchmarks');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(path.join(parent,'profile-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'probe.json');await writeFile(file,JSON.stringify(wireCapture(fixtures()[0].nodes).probe));return file;
}
test('public profiler follows bounded continuation and measures source verification on warm requests', {timeout:30000}, async t => {
  const file=await fixture(t);
  const {stdout}=await exec(process.execPath,['scripts/measure-network-pipeline.mjs','--capture',file,'--node-id','1:1','--public','--profile','--all-pages','--switch-node-id','1:2','--max-bytes','4096','--idle-ms','20','--release-ms','1000'],{timeout:25000});
  const output=JSON.parse(stdout),r=JSON.parse(await readFile(output.report,'utf8'));t.after(()=>rm(path.dirname(output.report),{recursive:true,force:true}));
  assert.equal(r.success,true);
  const pages=r.pageMeasurements.filter(p=>p.label==='all-pages');
  assert.ok(pages.length>1);assert.equal(pages.reduce((n,p)=>n+p.nodes,0),9);
  assert.equal(pages.at(-1).traversal.continuation,null);assert.ok(pages.every(p=>p.bytes<=4096));
  assert.ok(pages.every(p=>p.metrics===undefined));
  const cold=r.stages.find(s=>s.name==='cold-decode-request'),warm=r.stages.find(s=>s.name==='repeat-decode-request');
  assert.equal(cold.after.partReads.calls-cold.before.partReads.calls,0); // cold reads live in worker, not host
  assert.ok(warm.after.partReads.bytes>warm.before.partReads.bytes);
  assert.ok(r.stages.find(s=>s.name==='switch-selection'));
});
test('phase diagnostics execute production bounded decoder and disk index with exclusive Kiwi timing', {timeout:15000},async t=>{
  const file=await fixture(t);
  const {stdout}=await exec(process.execPath,['scripts/network-benchmark/profile-stages.mjs',file,'1:1','1'],{timeout:10000});
  const output=JSON.parse(stdout),r=JSON.parse(await readFile(output.report,'utf8'));t.after(()=>rm(path.dirname(output.report),{recursive:true,force:true}));
  assert.equal(r.results[0].counts.nodes,9);assert.ok(r.results[0].counts.readPartBytes>0);
  for(const key of ['base64ValidateMs','zstdMs','kiwiExclusiveMs','indexAcceptMs','contextQueryMs','serializeOnceMs'])assert.ok(r.timings[key].median>=0,key);
  assert.ok(r.timings.streamReadParseInclusiveMs.median>=r.timings.readPartIncludingManifestHashMs.median);
});

test('benchmark stop can join an already running TTL-style release',async()=>{
  const {releaseNetworkSelection,stopNetworkSelection}=await import('../dist/network-reader.js');
  const ttl=releaseNetworkSelection();
  await assert.rejects(releaseNetworkSelection(),/reader is busy/);
  await ttl;
  const nextTtl=releaseNetworkSelection();
  await Promise.all([nextTtl,stopNetworkSelection()]);
});
