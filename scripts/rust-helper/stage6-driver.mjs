import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { nodeInput,frames,digestSink } from './stage6-common.mjs';
import { compatibleInflater,compatibleInput } from './stage6-host.mjs';
import { inflateFrame,nodeFields } from '../../dist/network.js';
import { BoundedWireDecoder,WIRE_LIMITS } from '../../dist/network-wire.js';
import { liveFields } from '../../dist/network-live.js';
import { DiskNetworkSnapshot } from '../../dist/network-disk.js';
import { NetworkStore } from '../../dist/network-store.js';
const [mode,filename]=process.argv.slice(2),config=JSON.parse(await readFile(filename));config.config=filename;
const workCpuStart=process.cpuUsage();
const times=[];let result,nativeMetrics=null,fallbacks=0,nativeInputCpuMs=0;
for(let i=0;i<(config.warmup??0)+(config.runs??1);i++){
 const at=performance.now(),sink=digestSink();
 if(mode==='input-bench'||mode==='input-hybrid'){
  if(mode==='input-bench'){for await(const b of nodeInput(config))sink.push(b);}
  else {const store=await NetworkStore.create(config.project);await store.withRead(async()=>{for await(const b of compatibleInput(config,{onFallback:()=>fallbacks++,onPid:helperPid=>console.log(JSON.stringify({helperPid})),onMetrics:m=>{nativeInputCpuMs+=m?.cpuMs??0;}}))sink.push(b);});}
  result=sink.result();
 } else if(mode==='inflate-bench'){
  for await(const {bytes,limit} of frames(path.join(config.directory,'frames.bin')))sink.push(inflateFrame(bytes,limit));result=sink.result();
 } else if(mode==='pipeline-node'||mode==='pipeline-rust'){
  const scratch=await mkdtemp(path.join(config.project,'decode-'));let model,helper,liveCodec;
  try {
   if(mode==='pipeline-rust'){helper=await compatibleInflater();console.log(JSON.stringify({helperPid:helper.pid}));}
   model=new DiskNetworkSnapshot(config.snapshot.fileKey,scratch);let codec;
   for await(const b of nodeInput(config)){
    const schema=b.subarray(0,8).toString()==='fig-wire';
    if(schema&&(codec||b.length<12||b.readUInt32LE(8)!==1))throw Error('Unsupported schema');
    if(!schema&&!codec)throw Error('Missing schema');
    const data=schema?b.subarray(12):b,limit=schema?WIRE_LIMITS.schemaBytes:WIRE_LIMITS.frameBytes;
    const decoded=helper?await helper.inflate(data,limit):inflateFrame(data,limit);
    if(schema){model.setLayoutSchemaHash(createHash('sha256').update(decoded).digest('hex'));codec=new BoundedWireDecoder(decoded,nodeFields);liveCodec=new BoundedWireDecoder(decoded,liveFields);}
    else model.acceptMessage(codec.decode(decoded,node=>model.acceptNode(node)));
   }
   model.finish();if(!liveCodec)throw Error('Missing live schema');
   if(helper){fallbacks+=helper.fallbacks;await helper.close();nativeMetrics=helper.metrics;}
   times.push(performance.now()-at);
   // Verify a complete paginated selection, outside load/decode/index timing.
   const h=createHash('sha256');let offset=0,pages=0,nodes=0;
   for(;;){const page=model.query({...config.query,offset});h.update(JSON.stringify(page));pages++;nodes+=page.nodes.length;if(page.traversal.nextOffset===null)break;offset=page.traversal.nextOffset;if(pages>10000)throw Error('Pagination did not end');}
   result={hash:h.digest('hex'),pages,nodes};
  }finally{model?.close();if(helper)await helper.destroy();await rm(scratch,{recursive:true,force:true});}
  continue;
 }else throw Error('Unknown mode');
 if(i>=(config.warmup??0))times.push(performance.now()-at);
}
const usage=process.cpuUsage(),workCpu=process.cpuUsage(workCpuStart);
console.log(JSON.stringify({times,result,fallbacks,workCpuMs:(workCpu.user+workCpu.system)/1000+(nativeMetrics?.cpuMs??0)+nativeInputCpuMs,metrics:{cpuMs:(usage.user+usage.system)/1000+(nativeMetrics?.cpuMs??0)+nativeInputCpuMs,hostMaxRssBytes:process.resourceUsage().maxRSS*1024,native:nativeMetrics}}));
