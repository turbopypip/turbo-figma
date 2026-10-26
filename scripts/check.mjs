import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['extension','scripts','tests']){
  for(const file of await readdir(new URL(`../${directory}/`,import.meta.url))){
    if(!/\.(mjs|js)$/.test(file))continue;
    const result=spawnSync(process.execPath,['--check',`${directory}/${file}`],{stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)process.exit(result.status??1);
  }
}
