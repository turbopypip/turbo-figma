import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export async function verify(root) {
 const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
 let files=0,bytes=0;
 const check=async item=>{
  const file=path.resolve(root,item.path);
  if(!file.startsWith(path.resolve(root)+path.sep))throw Error('File escapes corpus directory');
  const data=await readFile(file);
  if(data.length!==item.bytes||createHash('sha256').update(data).digest('hex')!==item.sha256)throw Error(`Checksum mismatch: ${item.path}`);
  files++;bytes+=data.length;
 };
 for(const c of manifest.cases){for(const f of c.files??[])await check(f);await check(c.expected);}
 if(manifest.probe)await check(manifest.probe);
 for(const [i,part] of (manifest.parts??[]).entries())await check({...part,path:`snapshot/part-${i}.bin`});
 return {cases:manifest.cases.length,files,bytes};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 if(!process.argv[2])throw Error('Usage: verify.mjs CORPUS_DIRECTORY');
 console.log(JSON.stringify(await verify(path.resolve(process.argv[2]))));
}
