import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const snapshot={fileKey:'test',sessionId:'capture',generation:1};
const page=(id,continuation)=>({adapter:'figma-network-snapshot',snapshot,
  freshness:{status:'observed',snapshot,revision:0},nodes:[{id}],
  traversal:{eligibleRecords:2,continuation,complete:continuation===null,pendingDepthCount:0,unresolvedInstanceCount:0}});
const call=(output,continuation)=>({type:'tool_use',sessionID:'session',part:{callID:crypto.randomUUID(),tool:'denis-figma-mcp_get_design_context',
  state:{status:'completed',input:{url:'https://www.figma.com/design/test/File?node-id=1-2',...(continuation?{continuation}:{})},
    output:JSON.stringify(output),metadata:{truncated:false}}}});
const valid=()=>[call(page('1','next')),call(page('2',null),'next'),call(page('1','next'))];
for(const [name,mutate,passed] of [
  ['complete continuation chain and repeat',a=>a,true],
  ['compaction re-emits old events with the same call IDs',a=>[a[0],a[1],a[1],a[0],a[2]],true],
  ['real repeated request has a new call ID',a=>[a[0],{...a[0],part:{...a[0].part,callID:'new'}},a[1],a[2]],false],
  ['partial run despite model claiming completion',a=>[a[0],{type:'text',part:{text:'All done, 2 nodes read.'}}],false],
  ['missing first-page repeat',a=>a.slice(0,2),false],
  ['wrong continuation',a=>{a[1].part.state.input.continuation='wrong';return a;},false],
  ['client-clipped output',a=>{a[1].part.state.metadata.truncated=true;return a;},false],
  ['changed first-page nodes',a=>{a[2]=call(page('changed','next'));return a;},false],
  ['missing snapshot identity',a=>a.map(e=>{const p=JSON.parse(e.part.state.output);delete p.snapshot;e.part.state.output=JSON.stringify(p);return e;}),false],
  ['duplicate nodes',a=>{a[1]=call(page('1',null),'next');return a;},false],
  ['shell-assisted network run',a=>[...a,{type:'tool_use',part:{tool:'bash',state:{status:'completed'}}}],false],
]) test(`Kilo acceptance rejects false completion: ${name}`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'kilo-pages-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'events.jsonl'),prefix=join(dir,'result');
  await writeFile(input,mutate(valid()).map(e=>JSON.stringify(e)).join('\n'));
  const result=spawnSync(process.execPath,['scripts/check-kilo-pages.mjs',input,prefix],{encoding:'utf8'});
  assert.equal(result.status,passed?0:1,result.stderr);
  assert.equal(JSON.parse(await readFile(prefix+'-summary.json','utf8')).passed,passed);
});
