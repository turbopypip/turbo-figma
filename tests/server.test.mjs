import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {writeFile,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {parseSchema,compileSchema,encodeBinarySchema} from 'kiwi-schema';
import {rustBinary,createNativeServer} from './native-server.mjs';
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
 const secret='s'.repeat(64),server=await createNativeServer(secret);let ws;
 t.after(async()=>{ws?.terminate();await server.close();});
 ws=await pair(server.port,secret,respond,'test');
 return {...server,secret,ws,call:async(arguments_=args)=>server.client.callTool({name:'get_design_context',arguments:arguments_})};
}

async function capture(s){const sender=createCaptureSender(s.ws,{fileKey:'test',sessionId:'native',generation:1});await sender.begin();const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);const schemaRecord={version:1,kind:'ws-received',session:'main',requestId:'stream',eventSequence:0,opcode:2,payload:Buffer.concat([header,zstd(encodeBinarySchema(schema))]).toString('base64')};
 const nodes=[{guid:g(1),phase:'CREATED',type:'FRAME',name:'Root',stackMode:'VERTICAL'},...Array.from({length:3},(_,i)=>({guid:g(i+2),phase:'CREATED',type:'RECTANGLE',name:`Child ${i}`,parentIndex:{guid:g(1),position:String(i)}}))];
 const records=[schemaRecord,message({type:'JOIN_START'},1),message({type:'NODE_CHANGES',nodeChanges:nodes},2),message({type:'JOIN_END'},3)];for(const r of records)await sender.append(bytes(r));await sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:4,droppedParts:0,sequenceComplete:true});return sender;}
test('server Rust owns live revisions, selection, stale tokens, corruption and invalidation',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());const first=JSON.parse((await s.call()).content[0].text);assert.equal(first.freshness.revision,0);assert.ok(first.traversal.continuation);
 await sender.delta(bytes(message({type:'USER_CHANGES',userChanges:[{selection:[g(1)]}]},4,'ws-sent')));
 const unchanged=JSON.parse((await s.call()).content[0].text);assert.equal(unchanged.freshness.revision,0);assert.equal(unchanged.traversal.continuation,first.traversal.continuation);
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Changed'}]},5)));
 const stale=await s.call({...args,continuation:first.traversal.continuation});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/continuation/);
 const updated=JSON.parse((await s.call({...args,maxNodes:20})).content[0].text);assert.equal(updated.freshness.revision,1);assert.equal(updated.appliedLiveBatches,1);assert.equal(updated.nodes[1].name,'Changed');
 const changed=await s.call({...args,url:args.url.replace('1-1','1-2')});assert.equal(changed.isError,true);assert.match(changed.content[0].text,/STALE/);
});
test('server rejects unsupported presence and fails closed after a partial live batch',native,async t=>{
 for(const presence of [true,false]){await t.test(presence?'presence':'mutation',async t=>{const s=await setup(t);const sender=await capture(s);await s.call();const payload=presence?message({type:'USER_CHANGES',userChanges:[{unknown:'future field'}]},4,'ws-sent'):message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Must not escape'},{guid:g(999),name:'Missing'}]},4);await assert.rejects(sender.delta(bytes(payload)),/Unsupported|Ambiguous|missing|Missing/);const response=await s.call();assert.equal(response.isError,true);assert.match(response.content[0].text,/STALE/);});}
});
test('server rejects incomplete capture evidence and cannot publish a ready manifest',native,async t=>{
 const s=await setup(t);const sender=createCaptureSender(s.ws,{fileKey:'test',sessionId:'incomplete',generation:1});await sender.begin();await assert.rejects(sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:1,droppedParts:0,sequenceComplete:true}),/count|evidence/);const root=path.join(s.dir,'.cache/figma-network');for(const dir of await readdir(root)){if(/^[a-f0-9]{64}$/.test(dir))assert.equal(existsSync(path.join(root,dir,'ready.json')),false);}
});
test('server pairing rejects another peer and shutdown releases the listener and retained scratch',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());await s.call();const other=new WebSocket(`ws://127.0.0.1:${s.port}`);await once(other,'open');const closed=once(other,'close');other.send(JSON.stringify({type:'auth',secret:s.secret,fileKey:'test'}));assert.equal((await closed)[0],1008);
 const disconnected=once(s.ws,'close');if(process.platform==='win32')await s.client.close();else process.kill(s.transport.pid,'SIGTERM');await disconnected;await s.client.close();assert.equal((await readdir(path.join(s.dir,'.cache/figma-network'))).some(n=>n.startsWith('decode-')),false);const probe=net.createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(s.port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));
});
test('server cancels an outstanding browser operation and invalidates its observation',native,async t=>{
 let request;const received=new Promise(r=>request=r);const s=await setup(t,()=>{request();return new Promise(()=>{});});const sender=await capture(s);t.after(()=>sender.cancel());const controller=new AbortController();const pending=s.client.callTool({name:'get_screenshot',arguments:{nodeId:'1:1'}},{signal:controller.signal});await received;const disconnected=once(s.ws,'close');controller.abort();await assert.rejects(pending);await disconnected;const response=await s.call();assert.equal(response.isError,true);assert.match(response.content[0].text,/STALE/);
});
test('server re-verifies retained parts and rejects changed continuation parameters',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());const first=JSON.parse((await s.call()).content[0].text);
 for(const changed of [{depth:3},{maxNodes:2},{includeHidden:true},{maxBytes:12000},{continuation:first.traversal.continuation+'x'}]){const response=await s.call({...args,continuation:first.traversal.continuation,...changed});assert.equal(response.isError,true);assert.match(response.content[0].text,/continuation/);}
 assert.equal((await s.call()).isError,undefined);
 const root=path.join(s.dir,'.cache/figma-network'),generation=(await readdir(root)).find(n=>/^[a-f0-9]{64}$/.test(n));const file=path.join(root,generation,'part-0.bin');const data=await readFile(file);data[10]^=1;await writeFile(file,data);const corrupt=await s.call();assert.equal(corrupt.isError,true);assert.match(corrupt.content[0].text,/Corrupt/);
});
test('server WebSocket frame limit preserves close code 1009',native,async t=>{
 const s=await setup(t);const closed=once(s.ws,'close');s.ws.send('x'.repeat(6*1024*1024+1));assert.equal((await closed)[0],1009);
});
test('server idle timer releases native indexes without another tool request', {...native,timeout:75000},async t=>{
 const pristine=await setup(t),live=await setup(t);const a=await capture(pristine),b=await capture(live);t.after(()=>{a.cancel();b.cancel();});await pristine.call();await live.call();await b.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Live'}]},4)));
 await new Promise(r=>setTimeout(r,61500));
 for(const s of [pristine,live])assert.equal((await readdir(path.join(s.dir,'.cache/figma-network'))).some(n=>n.startsWith('decode-')),false);
 assert.equal((await pristine.call()).isError,undefined);const stale=await live.call();assert.equal(stale.isError,true);assert.match(stale.content[0].text,/STALE/);
});
test('server service traffic does not spend the document mutation budget',native,async t=>{
 const s=await setup(t),sender=await capture(s);t.after(()=>sender.cancel());await s.call();
 for(let i=0;i<130;i++)await sender.delta(bytes(message({type:'SIGNAL',signalName:'reconnect-sequence-number',signalPayload:String(i)},4+i)));
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'After service traffic'}]},134)));
 const result=JSON.parse((await s.call({...args,maxNodes:20})).content[0].text);assert.equal(result.freshness.revision,1);assert.equal(result.appliedLiveBatches,1);assert.equal(result.nodes[1].name,'After service traffic');
});

test('server exposes native tool schemas and exports confined PNG/SVG assets',native,async t=>{
 const s=await setup(t);const sender=await capture(s);t.after(()=>sender.cancel());
 assert.equal(s.client.getServerVersion().name,'turbo-figma');
 const tools=await s.client.listTools();
 const metadata=JSON.parse(await readFile(new URL('../resources/tools.json',import.meta.url),'utf8'));
 assert.deepEqual(tools.tools.map(t=>t.name).sort(),metadata.tools.map(t=>t.name).sort());
 for(const tool of tools.tools)assert.deepEqual(tool.inputSchema,metadata.tools.find(t=>t.name===tool.name).inputSchema);
 const screenshot=await s.client.callTool({name:'get_screenshot',arguments:{nodeId:'1:1'}});
 assert.equal(screenshot.isError,undefined,JSON.stringify(screenshot));assert.ok(screenshot.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
 for(const format of ['PNG','SVG']){
  const result=await s.client.callTool({name:'export_assets',arguments:{nodeIds:['1:1','1:2'],format}});
  assert.equal(result.isError,undefined);
  const files=await readdir(path.join(s.dir,'assets'));assert.equal(files.length,format==='PNG'?1:2);
  const filename=files.find(f=>f.toLowerCase().endsWith('.'+format.toLowerCase()));assert.ok(filename);
  const data=await readFile(path.join(s.dir,'assets',filename));assert.ok(data.length>0);
  assert.match(result.content[0].text,/1:2/);assert.match(result.content[0].text,/not mounted/);
 }
});

test('cache inventory recognizes new and pre-rename ownership markers',native,async t=>{
 const s=await setup(t),sender=await capture(s);t.after(()=>sender.cancel());
 const root=path.join(s.dir,'.cache/figma-network');
 const generation=(await readdir(root)).find(n=>/^[a-f0-9]{64}$/.test(n));
 const file=path.join(root,generation,'capture.json');
 const owner=JSON.parse(await readFile(file,'utf8'));assert.equal(owner.owner,'turbo-figma');
 for(const name of ['turbo-figma','figma-kilo-mcp']){
  await writeFile(file,JSON.stringify({...owner,owner:name}));
  const id=crypto.randomUUID();
  const response=new Promise(resolve=>{const receive=raw=>{const value=JSON.parse(raw);if(value.type==='cache-result'&&value.id===id){s.ws.off('message',receive);resolve(value);}};s.ws.on('message',receive);});
  s.ws.send(JSON.stringify({type:'cache-control',id,action:'cache-info'}));
  const result=await response;assert.equal(result.error,undefined);assert.equal(result.result.generations,1);assert.equal(result.result.protectedEntries,0);
 }
});
