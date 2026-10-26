import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NetworkStore } from '../dist/network-store.js';
import { AssetStore, decodeImage, decodeImageAsync } from '../dist/assets.js';
import { nativeCommand } from '../dist/native-command.js';
import { rustBinary } from '../dist/network-rust.js';
import { PNG } from './helpers.mjs';
const native={skip:existsSync(rustBinary)?false:'Release helper required'};
if(process.env.REQUIRE_RUST_HELPER&&!existsSync(rustBinary))throw Error('Release helper required');
const snapshot={fileKey:'native',sessionId:'store',generation:1};
const evidence={schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:1,droppedParts:0,sequenceComplete:true};
async function fixture(t){
 const previous=process.env.FIGMA_NETWORK_BACKEND;process.env.FIGMA_NETWORK_BACKEND='rust';
 const project=await mkdtemp(path.join(tmpdir(),'native-storage-'));
 t.after(async()=>{if(previous===undefined)delete process.env.FIGMA_NETWORK_BACKEND;else process.env.FIGMA_NETWORK_BACKEND=previous;await rm(project,{recursive:true,force:true});});
 const store=await NetworkStore.create(project);assert.equal(store.native,true);return {project,store};
}
test('native store cannot publish after disk failure or cancellation; no replay after binary failure',native,async t=>{
 const {store}=await fixture(t);let writer=await store.begin(snapshot);
 const directory=path.join(store.root,(await readdir(store.root))[0]);
 await mkdir(path.join(directory,'part-0.bin'));
 await assert.rejects(writer.append(0,Buffer.from('x')));assert.equal(writer.state.status,'error');
 await assert.rejects(store.readManifest(snapshot),/ENOENT/);
 writer=await store.begin({...snapshot,generation:2});await writer.append(0,Buffer.from('ok'));
 const controller=new AbortController();controller.abort(new Error('cancel native commit'));
 await assert.rejects(writer.commit(evidence,controller.signal),/cancel native commit/);
 await assert.rejects(store.readManifest({...snapshot,generation:2}),/ENOENT/);
 const closed=await nativeCommand('--store',{op:'info',root:store.root,stamps:[]}).then(()=>false,()=>true);assert.equal(closed,true);
 await assert.rejects(nativeCommand('--store',{},path.join(store.root,'missing-helper')),/ENOENT/);
});
test('native store verifies whole snapshot, detects corruption and protects hardlinked files',native,async t=>{
 const {store,project}=await fixture(t);const writer=await store.begin(snapshot);await writer.append(0,Buffer.from('first'));await writer.commit(evidence);
 await store.verifyParts(snapshot);
 const dir=path.join(store.root,(await readdir(store.root))[0]);const part=path.join(dir,'part-0.bin');
 await writeFile(part,'other');await assert.rejects(store.verifyParts(snapshot),/Corrupt/);
 await link(part,path.join(project,'external-link'));
 await assert.rejects(store.readPart(snapshot,0),/Invalid cache file/);
 assert.equal((await store.info()).protectedEntries,1);
 assert.equal((await store.clean()).removedGenerations,0);
 assert.equal((await readFile(part)).toString(),'other');
});
test('native asset validation parity, canonical base64 and Unicode confined filenames',native,async t=>{
 const {project}=await fixture(t);const store=await AssetStore.create(project);assert.equal(store.native,true);
 const valid=[{nodeId:'1:1',name:'ＡＢＣ/Тест',format:'PNG',data:PNG,scale:1,scaleBasis:'clipboard'},
 {nodeId:'1:2',name:'vector',format:'SVG',data:Buffer.from('<svg\ufeff/>').toString('base64')}];
 for(const value of valid){assert.deepEqual(await decodeImageAsync(value),decodeImage(value));const result=await store.write(value);assert.equal(path.dirname(result.path),store.root);assert.deepEqual(await readFile(result.path),Buffer.from(value.data,'base64'));}
 for(const value of [{...valid[0],data:PNG+'\n'},{...valid[0],scale:0},{...valid[0],scaleBasis:'bad'},{...valid[0],name:'x'.repeat(501)},
 {...valid[1],data:Buffer.from('<svg\u0085/>').toString('base64')},{...valid[1],data:Buffer.from('SVG').toString('base64')}]){
 assert.throws(()=>decodeImage(value));await assert.rejects(decodeImageAsync(value));await assert.rejects(store.write(value));
 }
 assert.ok((await readdir(project)).some(n=>n.startsWith('figma-ABC_Тест-')));
});
