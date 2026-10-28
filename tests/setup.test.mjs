import test from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('setup generates a direct Rust command, preserves pairing and fails without a binary',async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'figma setup ')));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'scripts'));
 await copyFile(new URL('../scripts/setup.mjs',import.meta.url),path.join(root,'scripts/setup.mjs'));
 const assets=path.join(root,'assets');
 const binary=path.join(root,'target/release',`turbo-figma${process.platform==='win32'?'.exe':''}`);
 const env={...process.env};delete env.TURBO_FIGMA_BINARY;
 const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/setup.mjs'),'--assets',assets],{env,encoding:'utf8'});
 let result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/Rust binary not found/);assert.equal(existsSync(path.join(root,'.local')),false);
 await mkdir(path.dirname(binary),{recursive:true});await writeFile(binary,'test placeholder');
 result=run();assert.equal(result.status,0,result.stderr);
 const configFile=path.join(root,'.local/config.json'),kiloFile=path.join(root,'.local/kilo.json');
 const before=JSON.parse(await readFile(configFile,'utf8'));
 const config=JSON.parse(await readFile(kiloFile,'utf8'));
 assert.deepEqual(Object.keys(config.mcp),['turbo_figma']);
 assert.deepEqual(config.mcp['turbo_figma'].command,[binary,'--server',configFile,root+path.sep]);
 assert.equal(config.mcp['turbo_figma'].environment,undefined);
 result=run();assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(await readFile(configFile,'utf8')).secret,before.secret);
 await rm(binary);result=run();assert.notEqual(result.status,0);assert.deepEqual(JSON.parse(await readFile(kiloFile,'utf8')),config);
});
