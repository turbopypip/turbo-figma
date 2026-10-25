import { fork } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NetworkStore } from '../dist/network-store.js';
import { readStoredNetworkSnapshot, readNetworkSnapshot } from '../dist/network-reader.js';
import { readRss } from './network-benchmark/rss.mjs';
import { parseSchema, encodeBinarySchema, compileSchema } from 'kiwi-schema';

if (process.argv[2] === '--child') {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const store = await NetworkStore.create(config.project);
  const started = performance.now(), stages = [];
  const observe = m => stages.push(m);
  try {
    const result = config.captureFile ? await readNetworkSnapshot({ ...config.query, captureFile: config.captureFile }, undefined, observe)
      : await readStoredNetworkSnapshot(store, config.snapshot, config.query, undefined, observe);
    const afterQuery = process.memoryUsage();
    await new Promise(r => setTimeout(r, 1000));
    process.send({ success: true, durationMs: performance.now() - started - 1000, records: result.documentRecords,
      returned: result.nodes.length, metrics: result.metrics, stages, afterQuery, afterRelease: process.memoryUsage(),
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024 });
  } catch (error) { process.send({ success: false, error: error.message }); }
  process.disconnect();
} else {
  const { values } = parseArgs({ options: { nodes: {type:'string',default:'200000'}, 'name-bytes':{type:'string',default:'1024'},
    capture:{type:'string'}, url:{type:'string'} } });
  const count = Number(values.nodes), nameBytes = Number(values['name-bytes']);
  if (!Number.isInteger(count) || count < 1 || count > 200000 || !Number.isInteger(nameBytes) || nameBytes < 1 || nameBytes > 4096) throw Error('Invalid fixture size');
  const root=fileURLToPath(new URL('../',import.meta.url)), parent=path.join(root,'.cache/figma-network/benchmarks');
  await mkdir(parent,{recursive:true});const directory=await mkdtemp(path.join(parent,'disk-'));
  const project=path.join(directory,'workspace');await mkdir(project);
  const config={project,query:{url:values.url || 'https://www.figma.com/design/benchmark/File?node-id=1-1',depth:50,maxNodes:500,offset:0,includeHidden:true}};
  let fixtureBytes=0;
  if(values.capture) { if(!values.url)throw Error('--capture requires --url');config.captureFile=path.resolve(values.capture); }
  else {
    const schema=parseSchema(`enum Type { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
      enum Phase { CREATED = 0; } struct Guid { uint sessionID; uint localID; }
      struct Parent { Guid guid; string position; }
      message NodeChange { Guid guid = 1; Phase phase = 2; Parent parentIndex = 3; string name = 4; }
      message Message { Type type = 1; NodeChange[] nodeChanges = 2; }`);
    const codec=compileSchema(schema);
    const zstd=data=>{const prefix=Buffer.alloc(9);prefix.writeUInt32LE(0xfd2fb528);prefix[4]=0xa0;prefix.writeUInt32LE(data.length,5);const chunks=[prefix];
      for(let i=0;i<data.length;i+=131072){const b=data.subarray(i,i+131072),h=Buffer.alloc(3);h.writeUIntLE((b.length<<3)|(i+b.length===data.length?1:0),0,3);chunks.push(h,b);}return Buffer.concat(chunks);};
    const store=await NetworkStore.create(project);config.snapshot={fileKey:'benchmark',sessionId:'large',generation:1};const writer=await store.begin(config.snapshot);
    let sequence=0;
    const save=async b=>{const bytes=Buffer.from(JSON.stringify({version:1,kind:'ws-received',session:'main',requestId:'1',eventSequence:sequence,opcode:2,payload:b.toString('base64')})+'\n');fixtureBytes+=bytes.length;await writer.append(sequence++,bytes);};
    const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);await save(Buffer.concat([header,zstd(encodeBinarySchema(schema))]));
    await save(zstd(codec.encodeMessage({type:'JOIN_START'})));
    const name='x'.repeat(nameBytes);
    for(let start=1;start<=count;start+=500){const nodes=[];for(let id=start;id<Math.min(start+500,count+1);id++) nodes.push({guid:{sessionID:1,localID:id},phase:'CREATED',name,
      ...(id>1&&id<=119?{parentIndex:{guid:{sessionID:1,localID:1},position:String(id).padStart(5,'0')}}:{})});
      await save(zstd(codec.encodeMessage({type:'NODE_CHANGES',nodeChanges:nodes})));}
    await save(zstd(codec.encodeMessage({type:'JOIN_END'})));
    await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:sequence});
  }
  const configPath=path.join(directory,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const child=fork(fileURLToPath(import.meta.url),['--child',configPath],{silent:true});child.stdout.resume();child.stderr.resume();
  let running=true,result,observerErrors=0,sampledPeak=0;
  const observer=(async()=>{while(running){try{const rss=(await readRss([child.pid])).get(child.pid);if(rss)sampledPeak=Math.max(sampledPeak,rss);}catch{observerErrors++;}await new Promise(r=>setTimeout(r,20));}})();
  child.on('message',message=>result=message);
  await new Promise(resolve=>child.once('exit',resolve));running=false;await observer;
  const report={date:new Date().toISOString(),environment:{platform:process.platform,release:os.release(),arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model},
    fixture:values.capture?{kind:'existing-probe'}:{kind:'synthetic-managed',nodes:count,nameBytes,bytes:fixtureBytes},
    ...result,sampledPeakRssBytes:sampledPeak,observerErrors,decoderBudgetBytes:350000000,
    decoderBudgetPassed:!!result?.success&&result.processPeakRssBytes<350000000,
    fullImplementationBudgetAccepted:false,limitations:['Fixture generation is outside the measured process.','Worker shares process RSS; no double counting.',
      'Decoder-only budget reserves 150 MB of the 500 MB target; extension/CDP and Windows require separate acceptance.','OS maxRSS includes short process peaks; external samples alone do not.']};
  const filename=path.join(directory,'report.json');await writeFile(filename,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({success:report.success,decoderBudgetPassed:report.decoderBudgetPassed,processPeakRssBytes:report.processPeakRssBytes,durationMs:report.durationMs,report:filename}));
  if(!report.decoderBudgetPassed)process.exitCode=1;
}
