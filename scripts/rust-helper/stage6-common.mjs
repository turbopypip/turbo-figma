import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { NetworkStore } from '../../dist/network-store.js';
import { storedEvents } from '../../dist/network-source.js';
export const hash = b => createHash('sha256').update(b).digest('hex');
export async function workspace(records, { snapshot = { fileKey:'corpus', sessionId:'stage6', generation:1 }, chunkSize = 262144, raw } = {}) {
  const root = path.resolve('.cache/figma-network'); await mkdir(root, { recursive:true });
  const project = await mkdtemp(path.join(root,'stage6-'));
  const store = await NetworkStore.create(project), writer = await store.begin(snapshot);
  const data = raw ?? Buffer.from(records.map(r => JSON.stringify(r)+'\n').join(''));
  let parts = 0;
  for (let i=0; i<data.length; i+=chunkSize) await writer.append(parts++, data.subarray(i,i+chunkSize));
  await writer.commit({schemaReceived:true,joinStarted:true,joinEnded:true,sequenceComplete:true,droppedParts:0,receivedParts:parts});
  const key=hash(JSON.stringify([snapshot.fileKey,null,null,snapshot.sessionId,snapshot.generation]));
  const directory=path.join(project,'.cache/figma-network',key);
  const config=path.join(project,'config.json');
  await writeFile(config,JSON.stringify({directory,snapshot}));
  return {project, directory, snapshot, config, data, store};
}
export async function* nodeInput(config) {
  for await (const e of storedEvents(config.project,config.snapshot)) {
    if(e.kind!=='ws-received')continue;
    if(typeof e.payload!=='string'||e.payload.length>24*1024*1024)throw Error('Invalid binary payload');
    const bytes=Buffer.from(e.payload,'base64');
    if(!bytes.length || bytes.toString('base64')!==e.payload)throw Error('Invalid binary payload');
    yield bytes;
  }
}
export async function* frames(filename) {
  // Bounded chunks, including at most one compressed message at a time.
  const { open }=await import('node:fs/promises');const file=await open(filename,'r');
  try { for(;;) {
    const header=Buffer.alloc(8);let got=0;
    while(got<8){const r=await file.read(header,got,8-got,null);if(!r.bytesRead)break;got+=r.bytesRead;}
    if(!got)break;if(got!==8)throw Error('Truncated frame header');
    const n=header.readUInt32LE(),limit=header.readUInt32LE(4);if(n>24*1024*1024+4096||limit>64*1024*1024)throw Error('Frame limit');
    const bytes=Buffer.alloc(n);got=0;while(got<n){const r=await file.read(bytes,got,n-got,null);if(!r.bytesRead)throw Error('Truncated frame');got+=r.bytesRead;}
    yield {bytes,limit};
  }}finally{await file.close();}
}
export function digestSink() {
  const h=createHash('sha256');let count=0,bytes=0;
  return {push(b){const n=Buffer.alloc(4);n.writeUInt32LE(b.length);h.update(n);h.update(b);count++;bytes+=b.length;},result(){return {hash:h.digest('hex'),count,bytes};}};
}
