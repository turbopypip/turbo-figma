// Stage 07 experiment. Production still uses the Node decoder.
import { createHash } from 'node:crypto';
import { nativeSession } from './stage6-host.mjs';
import { nodeInput } from './stage6-common.mjs';
import { inflateFrame, nodeFields } from '../../dist/network.js';
import { BoundedWireDecoder, WIRE_LIMITS } from '../../dist/network-wire.js';
export function unpack(b) {
 if(b[0]===83)return {kind:'S',value:b.subarray(1)};
 const text=b.subarray(1).toString();
 const revive=(_k,v)=>v&&typeof v==='object'&&Object.hasOwn(v,'$kiwiFloat')?Number(v.$kiwiFloat):v;
 return {kind:String.fromCharCode(b[0]),value:JSON.parse(text,text.includes('"$kiwiFloat"')?revive:undefined)};
}
// Reference replay stays bounded to one compressed message and its bounded nodes.
// Callbacks, rather than an async generator, avoid accumulating a frame's nodes.
export async function nodeDecode(config, consume) {
 let codec;
 for await(const b of nodeInput(config)) {
  if(b.subarray(0,8).toString()==='fig-wire') {
   if(codec||b.length<12||b.readUInt32LE(8)!==1)throw Error('Unsupported or repeated fig-wire schema');
   const schema=inflateFrame(b.subarray(12),WIRE_LIMITS.schemaBytes);codec=new BoundedWireDecoder(schema,new Set(config.fields??nodeFields));consume({kind:'S',value:Buffer.from(schema)});
  } else {
   if(!codec)throw Error('Missing wire schema');
   const message=codec.decode(inflateFrame(b,WIRE_LIMITS.frameBytes),node=>consume({kind:'N',value:node}));consume({kind:'M',value:message});
  }
 }
}
export async function compatibleDecode(config,consume,options={}) {
 const session=nativeSession('stream',config.config,{...options,stage:7});options.onPid?.(session.pid);
 const h=createHash('sha256');let emitted=0,error;
 const update=(digest,item)=>{const b=item.kind==='S'?item.value:Buffer.from(JSON.stringify(item.value,(_k,v)=>typeof v==='number'&&(!Number.isFinite(v)||Object.is(v,-0))?{$kiwiFloat:Object.is(v,-0)?'-0':String(v)}:v));const n=Buffer.alloc(4);n.writeUInt32LE(b.length);digest.update(item.kind).update(n).update(b);};
 // Separate consumer errors from native errors: a failed index callback must not replay.
 let consumerError;
 try {for await(const b of session.records()){const item=unpack(b);update(h,item);emitted++;try{consume(item);}catch(e){consumerError=e;throw e;}}}
 catch(e){error=e;} finally {options.onMetrics?.(session.metrics);await session.destroy();}
 if(!error)return;
 if(consumerError||options.signal?.aborted||error.code==='TIMEOUT'||error.code==='ABORTED')throw error;
 options.onFallback?.(error);
 const previous=h.digest('hex'),replay=createHash('sha256');let skipped=0;
 await nodeDecode(config,item=>{if(skipped<emitted){update(replay,item);skipped++;if(skipped===emitted&&replay.digest('hex')!==previous)throw Error('Snapshot changed during decoder replay');}else consume(item);});
 if(skipped!==emitted)throw Error('Snapshot changed during decoder replay');
}
