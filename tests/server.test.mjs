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
message NodeChange {GUID guid=1; string phase=2; string type=3; string name=4; Parent parentIndex=5; string stackMode=6; string unknown=7; float stackSpacing=8;}
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

async function capture(s, sessionId='native', suppliedNodes){const sender=createCaptureSender(s.ws,{fileKey:'test',sessionId,generation:1});await sender.begin();const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);const schemaRecord={version:1,kind:'ws-received',session:'main',requestId:'stream',eventSequence:0,opcode:2,payload:Buffer.concat([header,zstd(encodeBinarySchema(schema))]).toString('base64')};
 const nodes=suppliedNodes ?? [{guid:g(1),phase:'CREATED',type:'FRAME',name:'Root',stackMode:'VERTICAL',stackSpacing:8},...Array.from({length:3},(_,i)=>({guid:g(i+2),phase:'CREATED',type:'RECTANGLE',name:`Child ${i}`,parentIndex:{guid:g(1),position:String(i)}}))];
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

test('reconnect requires recapture and rejects old pagination after live updates',native,async t=>{
 const s=await setup(t);
 assert.equal((await s.status()).readReady,false);
 assert.equal((await s.status()).nextAction,'reload_and_capture');
 const sender=await capture(s);
 assert.equal((await s.status()).readReady,true);
 assert.equal((await s.call()).isError,undefined);
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Live'}]},4)));
 const first=JSON.parse((await s.call()).content[0].text);
 assert.ok(first.traversal.continuation);
 const pending=sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(3),name:'Interrupted'}]},5)));
 const interrupted=assert.rejects(pending,/disconnected|closed/i);
 const closed=once(s.ws,'close');s.ws.terminate();await closed;await interrupted;
 const until=Date.now()+3000;
 while((await s.status()).connected){if(Date.now()>until)throw Error('disconnect timeout');await new Promise(r=>setTimeout(r,10));}
 assert.equal((await s.status()).readReady,false);
 assert.equal((await s.status()).nextAction,'connect');
 const ws=await pair(s.port,s.secret,mockBrowser,'test');t.after(()=>ws.terminate());
 const status=await s.status();assert.equal(status.connected,true);assert.equal(status.readReady,false);
 assert.equal(status.snapshotState,'capture_required');assert.equal(status.nextAction,'reload_and_capture');
 assert.match(status.message,/Нажми «Подключить»/);
 assert.equal((await s.call({...args,continuation:first.traversal.continuation})).isError,true);
 const next=await capture({...s,ws},'recaptured');t.after(()=>next.cancel());
 assert.equal((await s.status()).readReady,true);
 assert.equal((await s.call({...args,continuation:first.traversal.continuation})).isError,true);
 const fresh=await s.call();assert.equal(fresh.isError,undefined);
 const page=JSON.parse(fresh.content[0].text);
 assert.equal((await s.call({...args,continuation:page.traversal.continuation})).isError,undefined);
});

test('map, batched sections and exact fields share observation and enforce coverage',native,async t=>{
 const s=await setup(t),sender=await capture(s);t.after(()=>sender.cancel());
 const call=async(name,arguments_)=>{const r=await s.client.callTool({name,arguments:arguments_});assert.equal(r.isError,undefined,r.content[0].text);return JSON.parse(r.content[0].text);};
 const map=await call('get_design_map',{url:args.url});
 assert.equal(map.view,'map');assert.equal(map.nodes.length,4);assert.match(map.observation,/^[a-f0-9]{64}$/);
 for(const n of map.nodes){assert.equal(n.layout,undefined);assert.equal(n.style,undefined);assert.ok(n.geometry);}
 const scope={url:args.url,observation:map.observation,revision:map.freshness.revision};
 const vars=path.join(s.dir,'variables.css');await writeFile(vars,':root { --mimir-space-sm: 8px; }');
 const mapped=await call('get_design_context',{...scope,depth:0,variablesFile:vars});
 assert.equal(mapped.nodes[0].layout.css.gap,'var(--mimir-space-sm)');assert.equal(mapped.nodes[0].layout.resolvedValues.gap,'8px');assert.equal(mapped.nodes[0].layout.cssText,undefined);
 assert.deepEqual(mapped.nodes[0].layout.resolvedValues,{gap:'8px'});assert.equal(mapped.nodes[0].style.css,undefined);assert.equal(mapped.nodes[0].layout.colors,undefined);
 const bounded=await call('get_design_context',{...scope,maxBytes:4096});assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=4096);
 const batch={...scope,nodeIds:['1:2','1:4'],depth:0,maxNodes:1};
 const a=await call('get_design_context',batch);assert.equal(a.traversal.eligibleRecords,2);assert.equal(a.nodes.length,1);assert.ok(a.traversal.continuation);
 const b=await call('get_design_context',{...batch,continuation:a.traversal.continuation});
 assert.deepEqual(new Set([...a.nodes,...b.nodes].map(n=>n.id)),new Set(batch.nodeIds));assert.equal(b.traversal.continuation,null);
 for(const n of [...a.nodes,...b.nodes]){assert.equal(n.properties,undefined);assert.equal(n.layout.cssText,undefined);assert.equal(n.layout.note,undefined);assert.equal(n.style.css,undefined);assert.equal(n.style.provenance,undefined);}
 const detail=await call('get_design_context',{...scope,nodeIds:['1:2'],depth:0,fields:['layout']});assert.equal(detail.nodes.length,1);assert.ok(detail.nodes[0].layout);assert.equal(detail.nodes[0].style,undefined);
 const missing=await call('get_design_context',{...scope,nodeIds:['1:999'],depth:0});assert.deepEqual(missing.traversal.missingNodeIds,['1:999']);assert.equal(missing.truncated,true);assert.equal(missing.traversal.complete,false);
 for(const changed of [{fields:['text']},{nodeIds:['1:3']},{revision:99},{observation:'0'.repeat(64)}]){
 const r=await s.client.callTool({name:'get_design_context',arguments:{...batch,continuation:a.traversal.continuation,...changed}});assert.equal(r.isError,true);
 }
 await sender.delta(bytes(message({type:'NODE_CHANGES',nodeChanges:[{guid:g(2),name:'Changed'}]},4)));
 const stale=await s.client.callTool({name:'get_design_context',arguments:{...scope,nodeIds:['1:2'],depth:0}});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/revision/);
 const refreshed=await call('get_design_map',{url:args.url});assert.equal(refreshed.freshness.revision,1);assert.equal(refreshed.nodes.find(n=>n.id==='1:2').name,'Changed');
});


test('screenshot and asset export receive root-first ancestors',native,async t=>{
 const requests=[];
 const s=await setup(t,(method,params)=>{requests.push({method,params});return {...mockBrowser(method,{...params,nodeId:"1:1"}),nodeId:params.nodeId};});
 const nodes=[{guid:g(9),phase:'CREATED',type:'CANVAS'},...[1,2,3,4].map((id,i)=>({guid:g(id),phase:'CREATED',type:'FRAME',name:`Level ${id}`,parentIndex:{guid:g(i===0?9:id-1),position:'0'}}))];
 const sender=await capture(s,'nested',nodes);t.after(()=>sender.cancel());
 await s.client.callTool({name:'get_screenshot',arguments:{nodeId:'1:4'}});
 await s.client.callTool({name:'export_assets',arguments:{nodeIds:['1:4'],format:'PNG'}});
 assert.equal(requests.length,2);
 for(const request of requests){
  assert.deepEqual(request.params.ancestors,['1:1','1:2','1:3']);
  assert.equal(request.params.nodeId,'1:4');
  assert.equal(new URL(request.params.url).searchParams.get("node-id").replaceAll("-",":"),"1:4");
 }
});
