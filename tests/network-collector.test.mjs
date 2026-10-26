import { initialRecords } from './wire-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkCollector, CAPTURE_LIMITS } from '../extension/network-collector.js';
import { TRANSFER_PART_BYTES } from '../extension/network-transfer.js';
const flush = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
function fixture(options = {}) {
  let event, detached;
  const commands=[], parts=[], attaches=[], detaches=[], reloads=[];
  const chrome = {tabs:{reload:async id=>{reloads.push(id);await options.reload?.();}},debugger:{onEvent:{addListener:f=>{event=f;}},onDetach:{addListener:f=>{detached=f;}},
    attach:async source=>{attaches.push(source);await options.attach?.();},
    detach:async source=>{detaches.push(source);await options.detach?.();},
    sendCommand:async (source,method,params)=>{commands.push({source,method,params});await options.command?.(source,method);}}};
  class Socket extends EventTarget { readyState=1; close(){this.readyState=3;this.dispatchEvent(new Event('close'));} }
  const socket = new Socket();
  let cancelled=0, finishes=0;
  const sender = {begin:async()=>{},append:async bytes=>{parts.push(Buffer.from(bytes));return await options.append?.();},
    delta:async bytes=>{if(options.delta)return options.delta(bytes);throw Error('unsupported live update');},
    cancel:()=>{cancelled++;socket.close();},finish:async()=>{finishes++;await options.finish?.();}};
  const collector = createNetworkCollector(chrome,{createSender:()=>sender,...options.collector});
  const emit=(method,params,source={tabId:7})=>event(source,method,params);
  const open=(requestId='target',source={tabId:7},url='wss://www.figma.com/api/multiplayer/test?secret=private')=>emit('Network.webSocketCreated',{requestId,url},source);
  const receive=(payload='YWJj',requestId='target',source={tabId:7},opcode=2)=>emit('Network.webSocketFrameReceived',{requestId,response:{opcode,payloadData:payload}},source);
  return {collector,chrome,socket,commands,parts,attaches,detaches,reloads,emit,open,receive,
    detached:()=>detached({tabId:7},'canceled_by_user'),
    start:(reload=false)=>collector.start({tabId:7,fileKey:'test',socket,reload}),get cancelled(){return cancelled;},get finishes(){return finishes;}};
}

test('collector keeps only incoming selected-file messages including nested workers; no HTTP, URLs or outgoing traffic',async()=>{
  const f=fixture();await f.start();
  for(const [id,url] of [['noise','wss://www.figma.com/api/livegraph'],['other','wss://www.figma.com/api/multiplayer/other'],
    ['foreign','wss://evil.test/api/multiplayer/test'],['font','https://www.figma.com/api/multiplayer/test']]) f.open(id,{tabId:7},url);
  f.open();f.open('elsewhere',{tabId:8});
  for(const id of ['noise','other','foreign','font','elsewhere']) f.receive('ignored',id);
  f.emit('Network.webSocketFrameSent',{requestId:'target',response:{opcode:2,payloadData:'outgoing'}});
  f.emit('Network.responseReceived',{requestId:'target',response:{body:'http'}});
  f.receive('ignored','target',{tabId:8});f.receive('ping','target',{tabId:7},9);
  f.receive();
  f.emit('Target.attachedToTarget',{sessionId:'worker1',targetInfo:{type:'worker'}});
  await flush();
  const worker={tabId:7,sessionId:'worker1'};
  f.open('target',worker);f.receive('d29ya2Vy','target',worker);
  f.emit('Target.attachedToTarget',{sessionId:'nested',targetInfo:{type:'worker'}},worker);await flush();
  f.open('target',{tabId:7,sessionId:'nested'});f.receive('bmVzdGVk','target',{tabId:7,sessionId:'nested'});
  f.receive('unknown','target',{tabId:7,sessionId:'unknown'});
  await flush();
  const serialized=Buffer.concat(f.parts).toString();const records=serialized.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r=>r.payload),['YWJj','d29ya2Vy','bmVzdGVk']);
  assert.deepEqual(records.map(r=>r.session),['main','worker1','nested']);
  assert.equal(serialized.includes('private'),false);
  assert.ok(f.commands.some(c=>c.source.sessionId==='nested'&&c.method==='Network.enable'));
  assert.deepEqual([...new Set(f.commands.map(c=>c.method))],['Network.enable','Page.enable','Target.setAutoAttach']);
  assert.equal(f.collector.status.complete,false);assert.equal(f.finishes,0);
  await f.collector.stop();assert.equal(f.detaches.length,1);
  f.receive('late');await flush();assert.equal(f.parts.length,3);
});

test('records stream across bounded parts and preserve escaped text',async()=>{
  const f=fixture();await f.start();f.open();
  const payload='a'.repeat(TRANSFER_PART_BYTES+10)+'\n😀"\\';
  f.receive(payload,'target',{tabId:7},1);await flush();
  assert.ok(f.parts.length>1);assert.ok(f.parts.every(p=>p.length<=TRANSFER_PART_BYTES));
  assert.equal(JSON.parse(Buffer.concat(f.parts).toString()).payload,payload);
  assert.equal(f.collector.status.events,1);await f.collector.stop();
});

test('slow disk bounds record queue and fails rather than accumulating or publishing a snapshot',async()=>{
  const gate=deferred();const f=fixture({append:()=>gate.promise});await f.start();f.open();
  for(let i=0;i<CAPTURE_LIMITS.records+1;i++)f.receive();
  await flush();assert.equal(f.collector.status.state,'error');assert.match(f.collector.status.message,/Переполнение/);
  assert.equal(f.parts.length,1);assert.equal(f.cancelled,1);assert.equal(f.detaches.length,1);
  gate.resolve();await flush();assert.equal(f.parts.length,1);assert.equal(f.finishes,0);
});

test('queue byte bound applies before full JSON escape expansion',async()=>{
  const f=fixture();await f.start();f.open();f.receive('\u0001'.repeat(3*1024*1024));await flush();
  assert.match(f.collector.status.message,/Переполнение/);assert.equal(f.parts.length,0);assert.equal(f.detaches.length,1);
});

test('oversized incoming payload is rejected before encoding',async()=>{
  const f=fixture();await f.start();f.open();f.receive('x'.repeat(CAPTURE_LIMITS.payloadChars+1));await flush();
  assert.equal(f.parts.length,0);assert.match(f.collector.status.message,/лимит/);assert.equal(f.detaches.length,1);
});

test('cancel during debugger attach detaches late success and does not enable interception',async()=>{
  const gate=deferred();const f=fixture({attach:()=>gate.promise});
  const starting=f.start();const rejected=assert.rejects(starting,/отменён/);await flush();
  const stopping=f.collector.stop();assert.equal(f.collector.active,true);
  gate.resolve();await stopping;await rejected;
  assert.equal(f.detaches.length,1);assert.equal(f.commands.length,0);assert.equal(f.collector.active,false);
});

test('permission denial and worker setup failure are explicit and detach owned targets',async()=>{
  let f=fixture({attach:()=>{throw Error('Permission denied');}});
  await assert.rejects(f.start(),/Permission denied/);assert.equal(f.detaches.length,0);assert.equal(f.collector.status.state,'error');
  f=fixture({command:source=>{if(source.sessionId)throw Error('worker failed');}});await f.start();
  f.emit('Target.attachedToTarget',{sessionId:'worker',targetInfo:{type:'worker'}});await flush();
  assert.match(f.collector.status.message,/worker/);assert.equal(f.detaches.length,1);
});

test('session and socket inventories are bounded',async()=>{
  let f=fixture();await f.start();
  for(let i=0;i<=CAPTURE_LIMITS.sessions;i++)f.emit('Target.attachedToTarget',{sessionId:`w${i}`,targetInfo:{type:'worker'}});
  await flush();assert.equal(f.collector.status.state,'error');assert.equal(f.detaches.length,1);
  f=fixture();await f.start();for(let i=0;i<=CAPTURE_LIMITS.sockets;i++)f.open(`s${i}`);
  await flush();assert.equal(f.collector.status.state,'error');assert.equal(f.detaches.length,1);
});

for(const reason of ['bridge','debugger','multiplayer','worker'])test(`${reason} disconnect stops capture and releases interception`,async()=>{
  const f=fixture();await f.start();f.open();
  if(reason==='bridge')f.socket.close();
  if(reason==='debugger')f.detached();
  if(reason==='multiplayer')f.emit('Network.webSocketClosed',{requestId:'target'});
  if(reason==='worker'){
    f.emit('Target.attachedToTarget',{sessionId:'worker',targetInfo:{type:'worker'}});await flush();
    f.open('child',{tabId:7,sessionId:'worker'});
    f.emit('Target.detachedFromTarget',{sessionId:'worker'});
  }
  await flush();assert.equal(f.collector.status.state,'error');assert.equal(f.collector.active,false);
  assert.equal(f.detaches.length,reason==='debugger'?0:1);assert.equal(f.finishes,0);
});

test('detach failure remains explicit and blocks a second capture until browser confirms detach',async()=>{
  const f=fixture({detach:()=>{throw Error('detach failed');}});await f.start();await f.collector.stop();
  assert.equal(f.collector.active,true);assert.match(f.collector.status.message,/Не удалось снять/);
  await assert.rejects(f.start(),/не остановлен/);f.detached();assert.equal(f.collector.active,false);
});

test('normal detach event during stop preserves terminal status',async()=>{
  let f;f=fixture({detach:()=>f.detached()});await f.start();await f.collector.stop();
  assert.equal(f.collector.active,false);assert.equal(f.collector.status.state,'stopped');
});

test('connection routes capture into disk store and disconnect removes debugger without browser-storage payloads',async t=>{
  const {createConnection}=await import('../extension/connection.js');
  const {createNativeServer}=await import('./native-server.mjs');
  const {WebSocket}=await import('ws');const {readdir,readFile}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const secret='a'.repeat(64);
  const bridge=await createNativeServer(secret);const store={root:join(bridge.dir,'.cache/figma-network')};
  const stored={};let event,detaches=0;
  const chrome={debugger:{onEvent:{addListener:f=>{event=f;}},onDetach:{addListener(){}},
    attach:async()=>{},detach:async()=>{detaches++;},sendCommand:async()=>{}},
    storage:Object.fromEntries(['local','session'].map(name=>[name,{get:async()=>stored[name]||{},set:async value=>{stored[name]={...stored[name],...value};}}])),
    scripting:{executeScript:async()=>[{result:{result:{id:'1:1'}}}]},
    tabs:{get:async id=>({id,url:'https://www.figma.com/design/test/File'}),reload:async()=>{}},alarms:{create:async()=>{},clear:async()=>{}}};
  const connection=createConnection(chrome,{WebSocket});
  t.after(async()=>{await connection.control({action:'disconnect'});await bridge.close();});
  await connection.ready;await connection.control({action:'connect',tabId:7,port:bridge.port,secret});
  const wait=async predicate=>{const until=Date.now()+3000;while(!await predicate()){if(Date.now()>until)throw Error('Timeout');await new Promise(r=>setTimeout(r,5));}};
  await wait(async()=>(await connection.control({action:'status'})).state==='connected');
  assert.match((await connection.control({action:'capture-start',tabId:8})).error,/текущей/);
  assert.equal((await connection.control({action:'capture-reload',tabId:7})).capture.state,'capturing');
  await connection.tabChanged(7,{status:'loading'},{id:7,url:'https://www.figma.com/design/test/File'});
  await connection.tabChanged(7,{status:'loading'},{id:7,url:'https://www.figma.com/design/test/File'});
  assert.equal((await connection.control({action:'status'})).capture.state,'capturing');
  event({tabId:7},'Target.attachedToTarget',{sessionId:'worker',targetInfo:{type:'worker'}});await flush();
  event({tabId:7,sessionId:'worker'},'Network.webSocketCreated',{requestId:'ws',url:'wss://www.figma.com/api/multiplayer/test?token=secret'});
  event({tabId:7,sessionId:'worker'},'Network.webSocketFrameReceived',{requestId:'ws',response:{opcode:2,payloadData:initialRecords()[0].payload}});
  await wait(async()=>(await connection.control({action:'status'})).capture.events===1);
  const [generation]=await readdir(store.root);const data=await readFile(join(store.root,generation,'part-0.bin'),'utf8');
  assert.equal(JSON.parse(data).payload,initialRecords()[0].payload);assert.equal(JSON.parse(data).session,'worker');
  assert.equal(JSON.stringify(stored).includes('cHJpdmF0ZS1wYXlsb2Fk'),false);
  assert.equal((await readdir(join(store.root,generation))).includes('ready.json'),false);
  for(const record of initialRecords().slice(1)) event({tabId:7,sessionId:'worker'},'Network.webSocketFrameReceived',{requestId:'ws',response:{opcode:2,payloadData:record.payload}});
  await wait(async()=>(await connection.control({action:'status'})).capture.state==='ready');
  const manifest=JSON.parse(await readFile(join(store.root,generation,'ready.json'),'utf8'));
  assert.equal(manifest.parts.length,4);
  assert.equal((await connection.control({action:'status'})).capture.complete,true);
  assert.equal(detaches,0);
  assert.equal((await bridge.status()).connected,true);

  await connection.tabChanged(7,{url:'https://www.figma.com/design/other/File'},{id:7,url:'https://www.figma.com/design/other/File'});
  assert.equal(detaches,1);assert.equal((await connection.control({action:'status'})).capture.state,'stale');
});

test('capture popup routes explicit start/stop and describes experimental status and permission',async()=>{
  const vm=await import('node:vm');const {readFile}=await import('node:fs/promises');
  const elements=Object.fromEntries(['capture-start','capture-reload','capture-stop','capture-status'].map(id=>[id,{listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}}]));
  const sent=[];let active=false,clear;
  vm.runInNewContext(await readFile('extension/network-popup.js','utf8'),{
    document:{getElementById:id=>elements[id]},window:{addEventListener:(event,fn)=>{clear=fn;}},setInterval:()=>1,clearInterval(){},
    chrome:{tabs:{query:async()=>[{id:7}]},runtime:{sendMessage:async msg=>{sent.push(msg);if(msg.action==='capture-start')active=true;if(msg.action==='capture-stop')active=false;
      return {state:'connected',tabId:7,capture:{state:active?'capturing':'idle',message:active?'Неполный снимок':'Выключен'}};}}}});
  await flush();assert.equal(elements['capture-start'].disabled,false);
  await elements['capture-start'].listeners.click();assert.equal(sent.find(m=>m.action==='capture-start').tabId,7);
  assert.equal(elements['capture-stop'].disabled,false);assert.equal(elements['capture-status'].textContent,'Неполный снимок');
  await elements['capture-stop'].listeners.click();assert.equal(elements['capture-stop'].disabled,true);clear();
  const html=await readFile('extension/popup.html','utf8');assert.match(html,/Chrome 125\+/);assert.match(html,/разрешение debugger/);assert.match(html,/не перезагружает/);
});

test('recovery reload is explicit; workers resume only after Network and recursive auto attach',async()=>{
  const f=fixture();await f.start(true);assert.deepEqual(f.reloads,[7]);assert.equal(f.collector.navigation({status:'loading'}),true);assert.equal(f.collector.navigation({status:'loading'}),true);
  assert.equal(f.collector.navigation({status:'complete'}),true);assert.equal(f.collector.navigation({status:'loading'}),true);
  assert.equal(f.commands.find(c=>c.method==='Target.setAutoAttach').params.waitForDebuggerOnStart,true);
  f.emit('Target.attachedToTarget',{sessionId:'paused',targetInfo:{type:'worker'}});await flush();
  assert.deepEqual(f.commands.filter(c=>c.source.sessionId==='paused').map(c=>c.method),['Network.enable','Target.setAutoAttach','Runtime.runIfWaitingForDebugger']);
  await f.collector.stop();
  const plain=fixture();await plain.start();assert.equal(plain.reloads.length,0);await plain.collector.stop();
});

test('initial deadline reports recovery instruction and detaches even when stream is absent',async()=>{
  let timeout;const f=fixture({collector:{timers:{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}}}});
  await f.start();timeout();await flush();assert.equal(f.collector.status.state,'error');assert.match(f.collector.status.message,/Перезагрузить/);assert.equal(f.detaches.length,1);
});

test('reload failure and unknown fragmentation do not finish a snapshot',async()=>{
  let f=fixture({reload:()=>{throw Error('reload denied');}});await assert.rejects(f.start(true),/reload denied/);
  assert.equal(f.detaches.length,1);assert.equal(f.finishes,0);
  f=fixture();await f.start();f.open();f.receive('fragment','target',{tabId:7},0);await flush();
  assert.equal(f.collector.status.state,'error');assert.equal(f.finishes,0);
});

test('JOIN_END acknowledgement seals queue; ready waits for finish acknowledgement',async()=>{
  const gate=deferred();const f=fixture({append:async()=>({initial:{initialComplete:true},nextSequence:1}),finish:()=>gate.promise});
  await f.start();f.open();f.receive();await flush();
  assert.equal(f.collector.status.state,'finishing');assert.equal(f.collector.status.complete,false);assert.equal(f.detaches.length,0);
  f.receive('later-live-change');assert.equal(f.parts.length,1);
  gate.resolve();await flush();assert.equal(f.collector.status.state,'stale');assert.equal(f.collector.status.complete,false);assert.equal(f.finishes,1);
});

test('initial timeout releases start caller while pending debugger attach is cleaned up on late success',async()=>{
  const gate=deferred();let timeout;
  const f=fixture({attach:()=>gate.promise,collector:{timers:{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}}}});
  const start=f.start();const rejected=assert.rejects(start,/отменён/);await flush();timeout();await rejected;
  assert.equal(f.collector.status.state,'error');assert.equal(f.detaches.length,0);
  gate.resolve();await flush();assert.equal(f.detaches.length,1);assert.equal(f.collector.active,false);
});

for(const reason of ['incoming','outgoing','bridge','debugger','multiplayer','replacement','worker','stop'])test(`ready observation becomes stale on ${reason}`,async()=>{
 const f=fixture({append:async()=>({initial:{initialComplete:true},nextSequence:1})});
 await f.start(true);
 f.emit('Target.attachedToTarget',{sessionId:'worker',targetInfo:{type:'worker'}});await flush();
 const source={tabId:7,sessionId:'worker'};f.open('target',source);f.receive('initial','target',source);await flush();
 assert.equal(f.collector.status.state,'ready');assert.equal(f.detaches.length,0);
 assert.equal(f.collector.navigation({status:'loading'}),true);
 f.receive('ping','target',source,9);assert.equal(f.collector.status.state,'ready');
 if(reason==='incoming')f.receive('change','target',source);
 if(reason==='outgoing')f.emit('Network.webSocketFrameSent',{requestId:'target',response:{opcode:2,payloadData:'not stored'}},source);
 if(reason==='bridge')f.socket.close();
 if(reason==='debugger')f.detached();
 if(reason==='multiplayer')f.emit('Network.webSocketClosed',{requestId:'target'},source);
 if(reason==='replacement')f.open('new',source);
 if(reason==='worker')f.emit('Target.detachedFromTarget',{sessionId:'worker'});
 if(reason==='stop')await f.collector.stop();
 await flush();assert.equal(f.collector.status.state,'stale');assert.equal(f.collector.status.complete,false);
 assert.equal(f.collector.active,false);assert.equal(f.parts.length,1);
});

test('messages queued behind JOIN_END invalidate instead of being discarded as a ready snapshot',async()=>{
 const gate=deferred();const f=fixture({append:()=>gate.promise});await f.start();f.open();f.receive('join-end');f.receive('change');
 gate.resolve({initial:{initialComplete:true},nextSequence:1});await flush();
 assert.equal(f.collector.status.state,'stale');assert.equal(f.finishes,1);
});

test('live producer bounds its queue while an update is pending',async()=>{
 const gate=deferred();let updates=0;
 const f=fixture({append:async()=>({initial:{initialComplete:true},nextSequence:1}),delta:()=>{updates++;return gate.promise;}});
 await f.start();f.open();f.receive();await flush();assert.equal(f.collector.status.state,'ready');
 f.receive('first');assert.equal(f.collector.status.state,'updating');for(let i=0;i<4;i++) f.receive('queued');await flush();
 assert.equal(f.collector.status.state,'stale');assert.equal(updates,1);
 gate.resolve({revision:1});await flush();assert.equal(f.collector.status.state,'stale');
});

 test('late tab loading preserves ready capture but a top-level document navigation invalidates it',async()=>{
 const f=fixture({append:async()=>({initial:{initialComplete:true},nextSequence:1})});
 await f.start(true);
 f.emit('Page.frameNavigated',{frame:{id:'main',url:'https://www.figma.com/design/test/File'}});
 f.open();f.receive('initial');await flush();
 assert.equal(f.collector.status.state,'ready');
 assert.equal(f.collector.navigation({status:'loading'}),true);
 assert.equal(f.collector.navigation({status:'complete'}),true);
 f.emit('Page.frameNavigated',{frame:{id:'child',parentId:'main'}});
 assert.equal(f.collector.status.state,'ready');
 f.emit('Page.frameNavigated',{frame:{id:'main',url:'https://www.figma.com/design/test/File'}});
 await flush();assert.equal(f.collector.status.state,'stale');assert.equal(f.cancelled,1);
 });

 test('service records queued behind JOIN_END and during commit drain in sequence',async()=>{
 const append=deferred(), finish=deferred(), records=[];
 const f=fixture({append:()=>append.promise,finish:()=>finish.promise,delta:async bytes=>{records.push(JSON.parse(new TextDecoder().decode(bytes)));return {revision:records.length};}});
 await f.start();f.open();f.receive('join');f.receive('before-commit');
 append.resolve({initial:{initialComplete:true},nextSequence:1});await flush();
 assert.equal(f.collector.status.state,'finishing');f.receive('during-commit');
 finish.resolve();await flush();assert.equal(f.collector.status.state,'ready');
 assert.deepEqual(records.map(r=>[r.eventSequence,r.payload]),[[1,'before-commit'],[2,'during-commit']]);
 assert.equal(f.parts.length,1);await f.collector.stop();
 });

 test('back-to-back live frames are acknowledged sequentially without loss',async()=>{
 const gate=deferred(),seen=[];
 const f=fixture({append:async()=>({initial:{initialComplete:true},nextSequence:1}),delta:async bytes=>{seen.push(JSON.parse(new TextDecoder().decode(bytes)).eventSequence);if(seen.length===1)await gate.promise;return {revision:seen.length};}});
 await f.start();f.open();f.receive();await flush();
 f.receive('first');f.receive('second');assert.deepEqual(seen,[1]);
 gate.resolve();await flush();assert.deepEqual(seen,[1,2]);assert.equal(f.collector.status.state,'ready');await f.collector.stop();
 });
