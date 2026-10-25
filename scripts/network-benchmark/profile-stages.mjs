// Diagnostic decomposition using unchanged production functions, outside end-to-end timings.
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NetworkStore } from '../../dist/network-store.js';
import { storedEvents } from '../../dist/network-source.js';
import { inflateFrame, nodeFields } from '../../dist/network.js';
import { BoundedWireDecoder, WIRE_LIMITS } from '../../dist/network-wire.js';
import { liveFields } from '../../dist/network-live.js';
import { DiskNetworkSnapshot } from '../../dist/network-disk.js';
import { loadVariables } from '../../dist/variables.js';
import { mapNetworkNodeVariables } from '../../dist/network-variables.js';
import { statistics } from './series.mjs';
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const scratch = await mkdtemp(path.join(config.directory, 'scratch-'));
  const timings = {}, counts = { nodes: 0, compressedBytes: 0, inflatedBytes: 0, readPartBytes: 0, readPartCalls: 0 };
  const add = (name, ms) => { timings[name] = (timings[name] ?? 0) + ms; };
  const time = (name, fn) => { const at=performance.now(); try{return fn();}finally{add(name,performance.now()-at);} };
  const readPart = NetworkStore.prototype.readPart;
  NetworkStore.prototype.readPart = async function(...args) { const at=performance.now();try{const b=await readPart.apply(this,args);counts.readPartCalls++;counts.readPartBytes+=b.length;return b;}finally{add('readPartIncludingManifestHashMs',performance.now()-at);} };
  const cpu = process.cpuUsage(), started = performance.now();
  const model = time('indexCreateMs',()=>new DiskNetworkSnapshot(config.snapshot.fileKey, scratch));
  try {
    let codec, liveCodec;
    const iterator = storedEvents(config.project,config.snapshot)[Symbol.asyncIterator]();
    for (;;) {
      const at=performance.now(), item=await iterator.next(); add('streamReadParseInclusiveMs',performance.now()-at);
      if(item.done)break;
      const e=item.value; if(e.kind!=='ws-received')continue;
      const b=time('base64ValidateMs',()=>{const bytes=Buffer.from(e.payload,'base64');if(!bytes.length||bytes.toString('base64')!==e.payload)throw Error('Invalid base64');return bytes;});
      const schema=b.subarray(0,8).toString()==='fig-wire';
      counts.compressedBytes+=b.length;
      const bytes=time('zstdMs',()=>inflateFrame(schema?b.subarray(12):b,schema?WIRE_LIMITS.schemaBytes:WIRE_LIMITS.frameBytes)); counts.inflatedBytes+=bytes.length;
      if(schema) { time('schemaMs',()=>{model.setLayoutSchemaHash(createHash('sha256').update(bytes).digest('hex'));codec=new BoundedWireDecoder(bytes,nodeFields);liveCodec=new BoundedWireDecoder(bytes,liveFields);});continue; }
      if(!codec)throw Error('Missing schema');
      const beforeIndex=timings.indexAcceptMs??0, before=performance.now();
      const message=codec.decode(bytes,node=>time('indexAcceptMs',()=>{model.acceptNode(node);counts.nodes++;}));
      add('kiwiExclusiveMs',performance.now()-before-((timings.indexAcceptMs??0)-beforeIndex));
      time('indexAcceptMs',()=>model.acceptMessage(message));
    }
    time('indexFinishMs',()=>model.finish());
    const output=time('contextQueryMs',()=>model.query(config.query));
    if (config.variablesFile) {
      const at=performance.now(),variables=await loadVariables(config.variablesFile);add('uiKitLoadMs',performance.now()-at);
      output.nodes=time('uiKitMapMs',()=>output.nodes.map(n=>mapNetworkNodeVariables(n,variables)));
    }
    const serialized=time('serializeOnceMs',()=>JSON.stringify(output));
    if(!liveCodec)throw Error('Missing live schema');
    const report={success:true,timings,counts,durationMs:performance.now()-started,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),maxRssBytes:process.resourceUsage().maxRSS*1024,
      returned:output.nodes.length,serializedBytes:Buffer.byteLength(serialized),selectionCache:model.selectionCacheStats()};
    process.send(report);
  } finally {model.close();await rm(scratch,{recursive:true,force:true});}
  process.disconnect();
} else {
  const [probeFile,nodeId,runsArg='30',variablesFile]=process.argv.slice(2), runs=Number(runsArg);
  if(!probeFile||!nodeId||!Number.isInteger(runs)||runs<1||runs>1000)throw Error('Usage: profile-stages.mjs PROBE NODE_ID [RUNS]');
  const parent=path.resolve('.cache/figma-network/benchmarks');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'stages-')), project=path.join(directory,'workspace');await mkdir(project);
  const raw=await readFile(probeFile), probe=JSON.parse(raw), fileKey=new URL(probe.fileUrl).pathname.split('/')[2];
  const snapshot={fileKey,sessionId:'stage-profile',generation:1}, store=await NetworkStore.create(project), writer=await store.begin(snapshot);
  const socket=probe.events.find(e=>e.kind==='ws-open'&&e.url===`wss://www.figma.com/api/multiplayer/${fileKey}`)?.key;
  if(!socket||probe.dropped)throw Error('Incomplete probe');
  let sequence=0,writerSequence=0;
  for(const e of probe.events.filter(e=>e.kind==='ws-received'&&e.key===socket)) {
    const record=Buffer.from(JSON.stringify({version:1,kind:'ws-received',session:'main',requestId:'profile',eventSequence:sequence,opcode:e.opcode,payload:e.payload})+'\n');
    // Preserve the production bounded transport chunk size; records may span parts.
    for(let offset=0;offset<record.length;offset+=262144)await writer.append(writerSequence++,record.subarray(offset,offset+262144));
    sequence++;
  }
  await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:writerSequence});
  const query={url:`https://www.figma.com/design/${fileKey}/File?node-id=${nodeId}`,format:'context',depth:12,maxNodes:200,maxBytes:24000,offset:0,includeHidden:false};
  const config=path.join(directory,'config.json');await writeFile(config,JSON.stringify({directory,project,snapshot,query,variablesFile:variablesFile?path.resolve(variablesFile):undefined}),{mode:0o600});
  const results=[];
  for(let i=0;i<runs;i++) {
    const child=fork(self,['--child',config],{silent:true});child.stdout.resume();child.stderr.pipe(process.stderr);
    let report;child.on('message',r=>report=r);
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);}).finally(()=>clearTimeout(timer));
    if(code!==0||!report?.success)throw Error('Stage profiler failed');results.push(report);
  }
  const names=[...new Set(results.flatMap(r=>Object.keys(r.timings)))];
  const report={version:1,probeSha256:createHash('sha256').update(raw).digest('hex'),query,runs,results,
    timings:Object.fromEntries(names.map(name=>[name,statistics(results.map(r=>r.timings[name]))])),
    limitations:['Diagnostic wrappers add overhead; these are not end-to-end MCP timings.','streamReadParseInclusiveMs includes readPartIncludingManifestHashMs; do not add both.','Kiwi excludes acceptNode callback time; indexing includes disk I/O and transformations performed by acceptNode.','serializeOnce excludes public reader repeated JSON byte-budget calculations.','Fresh process does not flush OS file caches. No forced GC.']};
  const output=path.join(directory,'report.json');await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({report:output}));
}
