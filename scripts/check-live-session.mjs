// Real Chrome + stdio MCP acceptance, without an LLM/provider. The browser must
// be paired and captured explicitly. Raw design data stays at OUTPUT_PREFIX.
// Usage: node scripts/check-live-session.mjs CONFIG_JSON FIGMA_URL OUTPUT_PREFIX
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const [config, url, prefix] = process.argv.slice(2);
if (!config || !url || !prefix) throw Error('Usage: check-live-session.mjs CONFIG_JSON FIGMA_URL OUTPUT_PREFIX');
const client = new Client({name:'live-acceptance',version:'1.0.0'});
const transport = new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/index.js')],
  env:{...process.env,FIGMA_KILO_CONFIG:path.resolve(config)},stderr:'pipe'});
transport.stderr.on('data',chunk=>process.stderr.write(chunk));
const save = (suffix,value)=>fs.writeFile(prefix+suffix+'.json',JSON.stringify(value,null,2));
const query = {url,depth:12,maxNodes:100};
const calls = [];
async function call(name,args={}) {
  const start=Date.now();
  const reply=await client.callTool({name,arguments:args});
  const text=reply.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  calls.push({name,args,start,end:Date.now(),bytes:Buffer.byteLength(text),isError:!!reply.isError});
  if(reply.isError) throw Error(text);
  return JSON.parse(text);
}
let network=[], ui=[];
try {
  await client.connect(transport);
  console.log('Waiting up to 120s: connect extension and Reload and capture.');
  const deadline=Date.now()+120000;
  while(!network.length && Date.now()<deadline) {
    try {
      const page=await call('get_design_context',query);
      if(page.freshness?.status==='observed') network.push(page);
    } catch { /* Old/missing capture is expected until the explicit browser action. */ }
    if(!network.length) await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(network.length,1,'No fresh observed capture');
  console.log('Capture ready; reading full network and UI concurrently.');
  await Promise.all([
    (async()=>{
      const seen=new Set();
      while(network.at(-1).traversal.continuation) {
        const continuation=network.at(-1).traversal.continuation;
        assert.ok(!seen.has(continuation),'Repeated network continuation');seen.add(continuation);
        const page=await call('get_design_context',{...query,continuation});
        network.push(page);
        if(network.length%20===0) console.log(`Network: ${network.length} pages, ${page.traversal.nextOffset} nodes`);
      }
    })(),
    (async()=>{
      let next={...query,source:'ui'};
      const seen=new Set();
      while(next) {
        const page=await call('get_design_context',next);ui.push(page);
        console.log(`UI: ${ui.length} pages, ${ui.flatMap(p=>p.nodes).length} records`);
        const request=page.traversal.nextRequest;
        if(request) {
          assert.ok(!seen.has(request.afterNodeId),'Repeated UI continuation');seen.add(request.afterNodeId);
          next={...request,source:'ui'};
        } else next=null;
      }
    })(),
  ]);
  const repeat=await call('get_design_context',query);
  assert.deepEqual(repeat.nodes,network[0].nodes,'First page changed after full traversal');
  assert.equal(ui.at(-1).traversal.complete,true);
  const nodes=network.flatMap(p=>p.nodes);
  assert.equal(new Set(nodes.map(n=>n.id)).size,network[0].traversal.eligibleRecords);
  assert.equal(nodes.length,network[0].traversal.eligibleRecords);
  assert.equal(network.at(-1).traversal.complete,true);
  for(const page of [...network,repeat]) {
    assert.equal(page.freshness.status,'observed');
    assert.deepEqual(page.snapshot,network[0].snapshot);
    assert.equal(page.freshness.revision,network[0].freshness.revision);
    assert.equal(page.traversal.pendingDepthCount,0);
    assert.equal(page.traversal.unresolvedInstanceCount,0);
    assert.ok(page.nodes.every(n=>!n.propertiesOmitted));
  }
  console.log('Full traversal passed; testing an isolated UI request after network reads.');
  const isolated=await call('get_design_context',{...query,source:'ui'});
  await save('-isolated-ui',isolated);
  const afterIsolated=await call('get_design_context',query);
  assert.deepEqual(afterIsolated.nodes,network[0].nodes);
  assert.equal(afterIsolated.freshness.status,'observed');
  const status=await call('get_connection_status');
  assert.equal(status.connected,true);
  const references=nodes.flatMap(n=>n.style?.nativeBindings?.references??[]);
  assert.ok(references.every(r=>r.status==='resolved'));
  const summary={passed:true,networkPages:network.length,networkNodes:nodes.length,
    uiPages:ui.length,uiUnique:new Set(ui.flatMap(p=>p.nodes).map(n=>n.id)).size,
    references:references.length,repeatEqual:true,isolatedUiPassed:true,status,
    snapshot:network[0].snapshot,revision:network[0].freshness.revision,
    maxNetworkBytes:Math.max(...calls.filter(c=>c.name==='get_design_context'&&c.args.source!=='ui'&&!c.isError).map(c=>c.bytes))};
  await save('-summary',summary);console.log(JSON.stringify(summary));
} catch(error) {
  const status=await call('get_connection_status').catch(()=>null);
  await save('-summary',{passed:false,error:error.message,status});
  console.error(error.message,JSON.stringify(status));process.exitCode=1;
} finally {
  await save('-network-pages',network);await save('-ui-pages',ui);await save('-calls',calls);
  await client.close();
}
