import {mkdir,writeFile,rm,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixtures,damagedCaptures,wireCapture,query,SEED,schemaBytes} from './fixtures.mjs';
import {collectPages,normalize} from './compare.mjs';
import {DiskNetworkSnapshot} from '../../dist/network-disk.js';
import {readNetworkSnapshot,releaseNetworkSelection} from '../../dist/network-reader.js';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function generate(output) {
 await mkdir(output,{recursive:false,mode:0o700});
 const manifest={version:1,seed:SEED,baseline:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),schemaSha256:sha256(schemaBytes),compression:'Zstandard raw blocks (not compression-speed evidence)',cases:[]};
 const save=async(name,value)=>{const data=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(path.join(output,name),data,{flag:'wx',mode:0o600});return {path:name,bytes:data.length,sha256:sha256(data)};};
 for(const f of fixtures()) {
  const entry={id:f.id,layer:f.layer,seed:SEED,nodes:f.nodes.length,query,files:[],classification:f.id==='beyond-selection-cache'?'stress':'functional'};
  let read,model,scratch;
  try {
   if(f.layer==='wire') {
    const {records,probe}=wireCapture(f.nodes);
    entry.files.push(await save(`${f.id}.probe.json`,probe));
    const ndjson=Buffer.from(records.map(r=>JSON.stringify(r)+'\n').join(''));
    entry.files.push(await save(`${f.id}.ndjson`,ndjson));
    // Fixed small chunks deliberately split JSON records across transport parts.
    entry.parts=[];
    for(let offset=0;offset<ndjson.length;offset+=262144)entry.parts.push({offset,bytes:Math.min(262144,ndjson.length-offset),sha256:sha256(ndjson.subarray(offset,offset+262144))});
    read=options=>readNetworkSnapshot({...options,captureFile:path.join(output,`${f.id}.probe.json`)});
   } else {
    entry.files.push(await save(`${f.id}.model.json`,{nodes:f.nodes,live:f.live??[]}));
    scratch=await mkdtemp(path.join(output,'.scratch-'));
    model=new DiskNetworkSnapshot('corpus',scratch);
    model.acceptMessage({type:'JOIN_START'});for(const n of f.nodes)model.acceptNode(n);
    model.acceptMessage({type:'NODE_CHANGES'});model.acceptMessage({type:'JOIN_END'});model.finish();
    read=options=>model.query(options);
   }
   const stages=[{phase:'initial',pages:(await collectPages(read,query)).map(normalize)}];
   for(const [index,changes] of (f.live??[]).entries()) {
    model.applyLive(changes);stages.push({phase:`live-${index+1}`,pages:(await collectPages(read,query)).map(normalize)});
   }
   if(f.error)throw Error(`Expected failure not observed: ${f.id}`);
   entry.expected=await save(`${f.id}.expected.json`,{stages});
  } catch(error) {
   if(!f.error || !error.message.includes(f.error))throw error;
   entry.expected=await save(`${f.id}.expected.json`,{error:{message:error.message}});
  } finally {model?.close();await releaseNetworkSelection();if(scratch)await rm(scratch,{recursive:true,force:true});}
  manifest.cases.push(entry);
 }
 for(const f of damagedCaptures()) {
  const input=await save(`${f.id}.probe.json`,f.probe);
  let failure;
  try{await readNetworkSnapshot({...query,captureFile:path.join(output,input.path)});}catch(e){failure=e.message;}finally{await releaseNetworkSelection();}
  if(!failure?.toLowerCase().includes(f.error.toLowerCase()))throw Error(`${f.id}: unexpected error ${failure}`);
  manifest.cases.push({id:f.id,layer:'wire',query,files:[input],expected:await save(`${f.id}.expected.json`,{error:{message:failure}})});
 }
 manifest.cases.sort((a,b)=>a.id.localeCompare(b.id));
 await save('manifest.json',manifest);return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const output=path.resolve(process.argv[2]??'.cache/figma-network/rust-corpus-v1');
 const manifest=await generate(output);console.log(JSON.stringify({output,cases:manifest.cases.length}));
}
