import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {parseSchema,compileSchema,encodeBinarySchema} from 'kiwi-schema';
import {rustBinary} from '../dist/network-rust.js';
import {createCaptureSender} from '../extension/network-transfer.js';
import {pair,mockBrowser} from './helpers.mjs';
import {zstd} from './wire-fixture.mjs';
const native={skip:existsSync(rustBinary)?false:'Native binary unavailable',timeout:20000};
const schema=parseSchema(`struct GUID {uint sessionID; uint localID;} struct Parent {GUID guid; string position;}
message NodeChange {GUID guid=1; string phase=2; string type=3; string name=4; Parent parentIndex=5; string stackMode=6; string unknown=7;}
message UserChange {GUID[] selection=1; string unknown=2;}
message Message {string type=1; NodeChange[] nodeChanges=2; UserChange[] userChanges=3; string signalName=4; string signalPayload=5;}`);
const codec=compileSchema(schema),g=n=>({sessionID:1,localID:n});
const bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const message=(m,eventSequence,kind='ws-received')=>({version:1,kind,session:'main',requestId:'stream',eventSequence,opcode:2,payload:zstd(codec.encodeMessage(m)).toString('base64')});
const args={url:'https://www.figma.com/design/test/File?node-id=1-1',depth:4,maxNodes:1};
async function setup(t,respond=mockBrowser){
 const dir=await mkdtemp(path.join(os.tmpdir(),'native-figma-'));const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const secret='s'.repeat(64),config=path.join(dir,'config.json');await writeFile(config,JSON.stringify({secret,port,assetDirectory:path.join(dir,'assets')}));
 const transport=new StdioClientTransport({command:rustBinary,args:['--server',config,dir],stderr:'pipe'});let diagnostics='';transport.stderr.on('data',b=>diagnostics+=b);const client=new Client({name:'native-test',version:'1'});await client.connect(transport);assert.match(diagnostics,/standalone/);
 const ws=await pair(port,secret,respond,'test');t.after(async()=>{ws.terminate();await client.close();await rm(dir,{recursive:true,force:true});});
 return {dir,port,secret,client,ws,transport,call:async(arguments_=args)=>client.callTool({name:'get_design_context',arguments:arguments_})};
}
async function capture(s){const sender=createCaptureSender(s.ws,{fileKey:'test',sessionId:'native',generation:1});await sender.begin();const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);const schemaRecord={version:1,kind:'ws-received',session:'main',requestId:'stream',eventSequence:0,opcode:2,payload:Buffer.concat([header,zstd(encodeBinarySchema(schema))]).toString('base64')};
 const nodes=[{guid:g(1),phase:'CREATED',type:'FRAME',name:'Root',stackMode:'VERTICAL'},...Array.from({length:3},(_,i)=>({guid:g(i+2),phase:'CREATED',type:'RECTANGLE',name:`Child ${i}`,parentIndex:{guid:g(1),position:String(i)}}))];
 const records=[schemaRecord,message({type:'JOIN_START'},1),message({type:'NODE_CHANGES',nodeChanges:nodes},2),message({type:'JOIN_END'},3)];for(const r of records)await sender.append(bytes(r));await sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:4,droppedParts:0,sequenceComplete:true});return sender;}
test('standalone Rust owns live revisions, selection, stale tokens, corruption and invalidation',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());const first=JSON.parse((await s.call()).content[0].text);assert.equal(first.freshness.revision,0);assert.ok(first.traversal.continuation);
 await sender.delta(bytes(message({type:'USER_CHANGES',userChanges:[{selection:[g(1)]}]},4,'ws-sent')));
 const unchanged=JSON.parse((await s.call()).content[0].text);assert.equal(unchanged.freshness.revision,0);assert.equal(unchanged.traversal.continuation,first.traversal.continuation);
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Changed'}]},5)));
 const stale=await s.call({...args,continuation:first.traversal.continuation});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/continuation/);
 const updated=JSON.parse((await s.call({...args,maxNodes:20})).content[0].text);assert.equal(updated.freshness.revision,1);assert.equal(updated.appliedLiveBatches,1);assert.equal(updated.nodes[1].name,'Changed');
 const changed=await s.call({...args,url:args.url.replace('1-1','1-2')});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/STALE/);
});
test('standalone rejects unsupported presence and fails closed after a partial live batch',native,async t=>{
 for(const presence of [true,false]){await t.test(presence?'presence':'mutation',async t=>{const s=await setup(t);const sender=await capture(s);await s.call();const payload=presence?message({type:'USER_CHANGES',userChanges:[{unknown:'future field'}]},4,'ws-sent'):message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Must not escape'},{guid:g(999),name:'Missing'}]},4);await assert.rejects(sender.delta(bytes(payload)),/Unsupported|Ambiguous|missing|Missing/);const response=await s.call();assert.equal(response.isError,true);assert.match(response.content[0].text,/STALE/);});}
});
test('standalone rejects incomplete capture evidence and cannot publish a ready manifest',native,async t=>{
 const s=await setup(t);const sender=createCaptureSender(s.ws,{fileKey:'test',sessionId:'incomplete',generation:1});await sender.begin();await assert.rejects(sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:1,droppedParts:0,sequenceComplete:true}),/count|evidence/);const root=path.join(s.dir,'.cache/figma-network');for(const dir of await readdir(root)){if(/^[a-f0-9]{64}$/.test(dir))assert.equal(existsSync(path.join(root,dir,'ready.json')),false);}
});
test('standalone pairing rejects another peer and shutdown releases the listener and retained scratch',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());await s.call();const other=new WebSocket(`ws://127.0.0.1:${s.port}`);await once(other,'open');const closed=once(other,'close');other.send(JSON.stringify({type:'auth',secret:s.secret,fileKey:'test'}));assert.equal((await closed)[0],1008);
 const disconnected=once(s.ws,'close');if(process.platform==='win32')await s.client.close();else process.kill(s.transport.pid,'SIGTERM');await disconnected;await s.client.close();assert.equal((await readdir(path.join(s.dir,'.cache/figma-network'))).some(n=>n.startsWith('decode-')),false);const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(s.port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));
});
test('standalone cancels an outstanding browser operation and invalidates its observation',native,async t=>{
 let request;const received=new Promise(r=>request=r);const s=await setup(t,()=>{request();return new Promise(()=>{});});const sender=await capture(s);t.after(()=>sender.cancel());const controller=new AbortController();const pending=s.client.callTool({name:'get_screenshot',arguments:{nodeId:'1:1'}},{signal:controller.signal});await received;const disconnected=once(s.ws,'close');controller.abort();await assert.rejects(pending);await disconnected;const response=await s.call();assert.equal(response.isError,true);assert.match(response.content[0].text,/STALE/);
});
test('standalone re-verifies retained parts and rejects changed continuation parameters',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());const first=JSON.parse((await s.call()).content[0].text);
 for(const changed of [{depth:3},{maxNodes:2},{includeHidden:true},{maxBytes:12000},{continuation:first.traversal.continuation+'x'}]){const response=await s.call({...args,continuation:first.traversal.continuation,...changed});assert.equal(response.isError,true);assert.match(response.content[0].text,/continuation/);}
 assert.equal((await s.call()).isError,undefined);
 const root=path.join(s.dir,'.cache/figma-network'),generation=(await readdir(root)).find(n=>/^[a-f0-9]{64}$/.test(n));const file=path.join(root,generation,'part-0.bin');const data=await readFile(file);data[10]^=1;await writeFile(file,data);const corrupt=await s.call();assert.equal(corrupt.isError,true);assert.match(corrupt.content[0].text,/Corrupt/);
});
test('standalone WebSocket frame limit preserves close code 1009',native,async t=>{
 const s=await setup(t);const closed=once(s.ws,'close');s.ws.send('x'.repeat(6*1024*1024+1));assert.equal((await closed)[0],1009);
});
test('standalone idle timer releases native indexes without another tool request', {...native,timeout:75000},async t=>{
 const pristine=await setup(t),live=await setup(t);const a=await capture(pristine),b=await capture(live);t.after(()=>{a.cancel();b.cancel();});await pristine.call();await live.call();await b.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Live'}]},4)));
 await new Promise(r=>setTimeout(r,61500));
 for(const s of [pristine,live])assert.equal((await readdir(path.join(s.dir,'.cache/figma-network'))).some(n=>n.startsWith('decode-')),false);
 assert.equal((await pristine.call()).isError,undefined);const stale=await live.call();assert.equal(stale.isError,true);assert.match(stale.content[0].text,/STALE/);
});
test('standalone service traffic does not spend the document mutation budget',native,async t=>{
 const s=await setup(t),sender=await capture(s);t.after(()=>sender.cancel());await s.call();
 for(let i=0;i<130;i++)await sender.delta(bytes(message({type:'SIGNAL',signalName:'reconnect-sequence-number',signalPayload:String(i)},4+i)));
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'After service traffic'}]},134)));
 const result=JSON.parse((await s.call({...args,maxNodes:20})).content[0].text);assert.equal(result.freshness.revision,1);assert.equal(result.appliedLiveBatches,1);assert.equal(result.nodes[1].name,'After service traffic');
});
