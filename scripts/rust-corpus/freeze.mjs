// Freeze only managed capture data, never browser profiles, configs or secrets.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {exportProbe} from '../network-benchmark/export-probe.mjs';
export async function freeze(source,output) {
 const manifest=JSON.parse(await readFile(path.join(source,'ready.json'),'utf8'));
 if(manifest.status!=='ready'||!manifest.parts?.length)throw Error('Ready managed snapshot required');
 await mkdir(output,{mode:0o700});
 for(const [i,part] of manifest.parts.entries()) {
  const data=await readFile(path.join(source,`part-${i}.bin`));
  if(data.length!==part.bytes||createHash('sha256').update(data).digest('hex')!==part.sha256)throw Error(`Corrupt part ${i}`);
  await writeFile(path.join(output,`part-${i}.bin`),data,{mode:0o600,flag:'wx'});
 }
 await writeFile(path.join(output,'ready.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
 await exportProbe({withRead:fn=>fn(),readManifest:async()=>manifest,readPart:(_,i)=>readFile(path.join(output,`part-${i}.bin`))},manifest.snapshot,path.join(output,'probe.json'));
 return {snapshot:manifest.snapshot,parts:manifest.parts,seed:null};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [source,output]=process.argv.slice(2);if(!source||!output)throw Error('Usage: freeze.mjs MANAGED_DIRECTORY NEW_LOCAL_OUTPUT');
 console.log(JSON.stringify(await freeze(path.resolve(source),path.resolve(output))));
}
