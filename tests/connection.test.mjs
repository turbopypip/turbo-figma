import { t, popupSource } from './i18n-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../extension/connection.js';
import { createStatusBadge } from '../extension/badge.js';
const secret = 'a'.repeat(64);
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
async function fixture(pairing, session, overrides={}) {
  const sockets=[], timers=new Map(), intervals=new Map(), states=[];
  let next=0, requests=0;
  const local={pairing}, stored={connection:session};
  const area=data=>({get:async()=>data,set:async value=>Object.assign(data,value),remove:async key=>delete data[key]});
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
    send(data){this.sent.push(JSON.parse(data));}
    open(){this.readyState=1;this.onopen();}
    close(code=1000){this.readyState=3;this.onclose?.({code});}
    message(msg){return this.onmessage({data:JSON.stringify(msg)});}
  }
  const chrome={debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async()=>{}},storage:{local:area(local),session:area(stored)},alarms:{create:async()=>{},clear:async()=>{}},
    tabs:{get:async id=>({id,url:'https://www.figma.com/design/test/name'})},
    scripting:{executeScript:async()=>{requests++;return [{result:{result:{ok:true}}}];}}};
  const clock={setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{intervals.set(++next,{fn,delay});return next;},clearInterval:id=>intervals.delete(id)};
  const controller=createConnection(chrome,{WebSocket:Socket,timers:clock,onState:s=>states.push(s),createCollector:()=>undefined,...overrides});
  await controller.ready;
  return {controller,chrome,states,local,stored,sockets,timers,intervals,get requests(){return requests;},
    connect:()=>controller.control({action:'connect',tabId:7,port:3055,secret}),
    tick:()=>{const [id,{fn}]=timers.entries().next().value;timers.delete(id);fn();}};
}
const target={tabId:7,fileKey:'test',wanted:true};
test('authentication saves key; session restore retains target and has no popup dependency',async()=>{
  const f=await fixture();await f.connect();assert.equal(f.local.pairing,undefined);
  const ws=f.sockets[0];ws.open();assert.equal(ws.sent[0].fileKey,'test');await ws.message({type:'ready'});await flush();
  assert.equal(f.local.pairing.secret,secret);
  assert.equal((await f.controller.control({action:'status'})).state,'connected');
  assert.equal([...f.intervals.values()][0].delay,20000);[...f.intervals.values()][0].fn();
  assert.deepEqual(ws.sent.at(-1),{type:'ping'});
  const restored=await fixture(f.local.pairing,f.stored.connection);assert.equal(restored.sockets.length,1);
  assert.equal(JSON.stringify(f.stored).includes(secret),false);
});
test('outage retries with capped backoff; alarm wakes reconnect without replaying requests',async()=>{
  const f=await fixture({port:3055,secret},target);const ws=f.sockets[0];ws.open();await ws.message({type:'ready'});
  await ws.message({type:'request',id:'1',method:'get_selection'});assert.equal(f.requests,0);assert.match(ws.sent.at(-1).error,/Unsupported/);
  ws.close(1006);assert.equal(f.intervals.size,0);
  assert.equal([...f.timers.values()][0].delay,1000);
  for(let i=0;i<8;i++){f.tick();f.sockets.at(-1).close(1006);}
  assert.equal([...f.timers.values()][0].delay,30000);
  await f.controller.wake();assert.equal(f.timers.size,0);assert.equal(f.requests,0);
});
test('disconnect retains key; forget wins queued save and prevents restoration',async()=>{
  const f=await fixture({port:3055,secret},target);const ws=f.sockets[0];ws.open();void ws.message({type:'ready'});
  await f.controller.control({action:'disconnect'});assert.equal(f.local.pairing.secret,secret);
  assert.equal(f.stored.connection.wanted,false);assert.equal(f.intervals.size,0);
  await f.controller.control({action:'connect',tabId:7,port:3055,secret:''});assert.equal(f.sockets.length,2);
  f.sockets[1].open();void f.sockets[1].message({type:'ready'});
  await f.controller.control({action:'forget'});assert.equal(f.local.pairing,undefined);
  assert.equal((await fixture(f.local.pairing,f.stored.connection)).sockets.length,0);
});
test('auth rejection stops retry; stale socket ignored; closed target disconnects',async()=>{
  const f=await fixture({port:3055,secret},target);const old=f.sockets[0];old.open();await f.connect();
  await old.message({type:'request',id:'stale',method:'get_selection'});assert.equal(f.requests,0);
  f.sockets.at(-1).close(1008);await flush();assert.equal(f.states.at(-1),'error');assert.equal(f.stored.connection.wanted,false);
  await f.controller.wake();assert.equal(f.sockets.length,2);
  await f.connect();await f.controller.tabChanged(7,{},undefined);assert.equal(f.states.at(-1),'disconnected');
});
test('badge text, color and tooltip track serialized final state',async()=>{
  const values={};const action=Object.fromEntries(['setBadgeBackgroundColor','setBadgeText','setTitle'].map(key=>[key,async v=>{values[key]=v;}]));
  const show=createStatusBadge({action});show('connected');show('busy');await show('error');
  assert.equal(values.setBadgeText.text,'!');assert.equal(values.setBadgeBackgroundColor.color,'#b63030');assert.match(values.setTitle.title,/отклонено/);
  await show('stale');assert.match(values.setTitle.title,/снимок устарел/);assert.doesNotMatch(values.setTitle.title,/ключ/);
  await show('disconnected');assert.equal(values.setBadgeText.text,'OFF');
});
test('real WebSocket bridge restarts and background reconnects without replay',async()=>{
  const {WebSocket}=await import('ws');const {createNativeServer}=await import('./native-server.mjs');
  let bridge=await createNativeServer(secret);const port=bridge.port;
  const f=await fixture({port,secret},target,{WebSocket,timers:globalThis});
  const wait=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,20));}};
  try {
    await wait(()=>f.states.at(-1)==='connected');assert.equal((await bridge.status()).connected,true);
    process.kill(bridge.transport.pid,'SIGKILL');await bridge.close();await wait(()=>f.states.at(-1)==='connecting');
    bridge=await createNativeServer(secret,port);await wait(()=>f.states.at(-1)==='connected');
    assert.equal(f.requests,0);assert.equal((await bridge.status()).connected,true);
    assert.equal((await bridge.status()).readReady,false);
    assert.equal((await bridge.status()).nextAction,'reload_and_capture');
  } finally {await f.controller.control({action:'disconnect'});await bridge.close();}
});
test('popup close only stops UI refresh; information goes directly to README',async()=>{
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const source=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../extension/popup.html',import.meta.url),'utf8');
  const elements=Object.fromEntries(['status','target','connect','secret','port','submit','disconnect','forget','saved-secret','secret-field','change-secret','cache-status','cache-info','cache-clear'].map(id=>[id,{value:'',addEventListener(){}}]));
  const sent=[];let close,cleared=false;
  vm.runInNewContext(popupSource(source),{t,localizeDocument:()=>{},document:{getElementById:id=>elements[id]},window:{addEventListener:(name,fn)=>{close=fn;}},
    setInterval:()=>1,clearInterval:()=>{cleared=true;},
    chrome:{tabs:{query:async()=>[{id:7,url:'https://www.figma.com/design/test/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({})}},runtime:{sendMessage:async msg=>{sent.push(msg);return {state:'connected',message:'Подключено'};}}}});
  await flush();assert.equal(elements['secret-field'].hidden,false);assert.equal(elements.secret.required,true);close();assert.equal(cleared,true);assert.deepEqual(sent.map(m=>m.action),['status','cache-info']);
  assert.match(html,/href="https:\/\/github.com\/turbopypip\/turbo-figma#readme" target="_blank"/);
});
test('one secret entry pairs different Figma tabs and files, including after browser restart', async()=>{
  const {WebSocket}=await import('ws');
  const {createNativeServer}=await import('./native-server.mjs');
  const bridge=await createNativeServer(secret);
  const port=bridge.port;
  const f=await fixture(undefined,undefined,{WebSocket,timers:globalThis});
  const targets=new Map([[7,'first'],[8,'second'],[9,'first']]);
  f.chrome.tabs.get=async id=>({id,url:`https://www.figma.com/design/${targets.get(id)}/name`});
  const visited=[];
  f.chrome.scripting.executeScript=async options=>{
    visited.push(options.target.tabId);
    assert.equal(options.args[2],targets.get(options.target.tabId));
    return [{result:{result:{tabId:options.target.tabId}}}];
  };
  const waitConnected=async controller=>{
    const deadline=Date.now()+3000;
    while((await controller.control({action:'status'})).state!=='connected'){
      if(Date.now()>deadline)throw Error('Pairing did not complete');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await flush();
  };
  let restarted;
  try {
    for(const [index,tabId] of [7,8,9,7,8].entries()) {
      const result=await f.controller.control({action:'connect',tabId,port,secret:index===0?secret:''});
      assert.equal(result.error,undefined);
      await waitConnected(f.controller);
      assert.equal(f.local.pairing.secret,secret);
      assert.equal((await bridge.status()).connected,true);
      assert.equal((await f.controller.control({action:'status'})).fileKey,targets.get(tabId));
    }
    assert.deepEqual(visited,[]);
    await f.controller.tabChanged(8,{},undefined);
    // Browser restart clears session storage but retains the local pairing.
    restarted=await fixture(f.local.pairing,undefined,{WebSocket,timers:globalThis});
    assert.equal(restarted.states.at(-1),'disconnected');
    const result=await restarted.controller.control({action:'connect',tabId:10,port,secret:''});
    assert.equal(result.error,undefined);
    await waitConnected(restarted.controller);
    assert.equal((await bridge.status()).connected,true);
  } finally {
    await f.controller.control({action:'disconnect'});
    await restarted?.controller.control({action:'disconnect'});
    await bridge.close();
  }
});

test('a new popup on another Figma tab submits an empty secret and the saved port',async()=>{
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const source=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
  const elements=Object.fromEntries(['status','target','connect','secret','port','submit','disconnect','forget','saved-secret','secret-field','change-secret','cache-status','cache-info','cache-clear'].map(id=>[id,{value:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}}]));
  const sent=[];
  vm.runInNewContext(popupSource(source),{t,localizeDocument:()=>{},Date,Number,document:{getElementById:id=>elements[id]},window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},
    chrome:{tabs:{query:async()=>[{id:8,url:'https://www.figma.com/design/second/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({pairing:{port:4055,secret}})}},runtime:{sendMessage:async msg=>{sent.push(msg);return {state:'connected',tabId:7,message:'Подключено'};}}}});
  await flush();
  assert.equal(elements['secret-field'].hidden,true);
  assert.equal(elements['saved-secret'].hidden,false);
  assert.equal(elements.secret.required,false);
  assert.equal(elements.secret.value,'');
  assert.equal(elements.port.value,4055);
  elements.connect.listeners.submit({preventDefault(){}});await flush();
  const message=sent.at(-1);
  assert.equal(message.action,'connect');assert.equal(message.tabId,8);assert.equal(message.port,4055);assert.equal(message.secret,'');
});
test('cache commands correlate results, surface errors and never replay on reconnect', async () => {
  const f = await fixture({port:3055,secret}, target);
  const ws = f.sockets[0]; ws.open(); await ws.message({type:'ready'});
  const pending = f.controller.control({action:'cache-clear'}); await flush();
  const request = ws.sent.at(-1);
  assert.equal(request.type,'cache-control'); assert.equal(request.action,'cache-clear');
  await ws.message({type:'cache-result',id:'old',result:{bytes:0}});
  assert.match((await f.controller.control({action:'cache-clear'})).error,/Дождись/);
  await ws.message({type:'cache-result',id:request.id,result:{bytes:0,removedBytes:123,removedGenerations:1}});
  assert.equal((await pending).cache.removedGenerations,1);
  const failed = f.controller.control({action:'cache-info'}); await flush();
  await ws.message({type:'cache-result',id:ws.sent.at(-1).id,error:'Disk inaccessible'});
  assert.equal((await failed).error,'Disk inaccessible');
  const disconnected = f.controller.control({action:'cache-clear'}); await flush(); ws.close(1006);
  assert.match((await disconnected).error,/неизвестен/);
  f.tick(); const next=f.sockets.at(-1); next.open(); await next.message({type:'ready'});
  assert.deepEqual(next.sent.map(m=>m.type),['auth']);
  const timeout = f.controller.control({action:'cache-clear'}); await flush(); f.tick();
  assert.match((await timeout).error,/неизвестен/);
  await f.controller.control({action:'disconnect'});
  assert.match((await f.controller.control({action:'cache-clear'})).error,/подключи/);
});
test('popup cache button sends one explicit clear command and keeps cache feedback separate', async () => {
  const {readFile}=await import('node:fs/promises'); const vm=await import('node:vm');
  const source=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
  const elements = new Map();
  const element = id => {
    if(!elements.has(id)) elements.set(id,{value:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}});
    return elements.get(id);
  };
  const sent=[];
  vm.runInNewContext(popupSource(source),{t,localizeDocument:()=>{},document:{getElementById:element},window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},
    chrome:{tabs:{query:async()=>[{id:7,url:'https://www.figma.com/design/test/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({})}},
      runtime:{sendMessage:async msg=>{sent.push(msg);return msg.action==='status'?{state:'connected',message:'Подключено'}:
        {cache:{bytes:0,removedBytes:1024,removedGenerations:2,protectedEntries:1}};}}}});
  await flush(); assert.equal(element('cache-clear').disabled,false);
  await element('cache-clear').listeners.click();
  assert.deepEqual(sent.map(m=>m.action),['status','cache-info','cache-clear']);
  assert.match(element('cache-status').textContent,/Кеш: 0.00 МиБ/);
  assert.match(element('cache-status').title,/сохранены/);
  assert.equal(element('status').textContent,'Подключено');
});

for (const method of ['get_screenshot', 'export_asset']) test(`${method} exports natively and never activates a tab or window`, async () => {
 const f=await fixture({port:3055,secret},target), calls=[], commands=[];
 f.chrome.windows={update:async()=>{throw Error('Must not focus window');}};
 f.chrome.tabs.update=async()=>{throw Error('Must not activate/navigate tab');};
 f.chrome.debugger.sendCommand=async(target,method,args)=>commands.push([method,args.enabled]);
 let failures=1;
 f.chrome.scripting.executeScript=async({func,args})=>{
  if(func.name==='installDownloadCapture') return [{result:null}];
  if(func.name==='readDownloadCapture') return [{result:args[2]?null:{data:'png',scale:1,scaleBasis:'native-export'}}];
  calls.push(args[0]);
  if(args[0]==='prepare_export' && failures-->0) return [{result:{error:'Export unavailable'}}];
  return [{result:{result:{id:'1:1',name:'Banner'}}}];
 };
 const ws=f.sockets[0];ws.open();await ws.message({type:'ready'});
 const params={url:'https://www.figma.com/design/test/name?node-id=1-1',nodeId:'1:1',format:'PNG',ancestors:['0:1']};
 await ws.message({type:'request',id:'failure',method,params});
 assert.match(ws.sent.at(-1).error,/Export unavailable/);
 await ws.message({type:'request',id:'retry',method,params});
 assert.equal(ws.sent.at(-1).error,undefined);
 assert.equal(ws.sent.at(-1).result.scaleBasis,'native-export');
 assert.ok(!calls.includes('begin_export') && !calls.includes('read_export'));
 assert.deepEqual(commands.map(c=>c[1]),[true,false,true,false]);
});

test('explicit connect captures after auth, survives popup close, and disconnect stops capture', async () => {
  const starts=[]; let stops=0;
  const collector={status:{state:'idle'},start:async args=>starts.push(args),stop:async()=>{stops++;}};
  const f=await fixture(undefined,undefined,{createCollector:()=>collector});
  await f.connect(); assert.equal(starts.length,0);
  const ws=f.sockets[0]; ws.open(); await ws.message({type:'ready'});
  assert.equal(starts.length,1); assert.equal(starts[0].reload,true); assert.equal(starts[0].tabId,7);
  await ws.message({type:'ready'}); assert.equal(starts.length,1);
  ws.close(1006); f.tick(); const next=f.sockets.at(-1); next.open(); await next.message({type:'ready'});
  assert.equal(starts.length,1); // automatic reconnect must not reload a working tab
  assert.match((await f.controller.control({action:'status'})).message,/Подключить/);
  const before=stops; await f.controller.control({action:'disconnect'}); assert.equal(stops,before+1);
});
test('disconnect while authentication capture is checking the tab prevents reload', async () => {
  const starts=[];
  const f=await fixture(undefined,undefined,{createCollector:()=>({status:{state:'idle'},start:async args=>starts.push(args),stop:async()=>{}})});
  await f.connect(); const ws=f.sockets[0]; ws.open();
  let release; f.chrome.tabs.get=()=>new Promise(resolve=>{release=resolve;});
  const ready=ws.message({type:'ready'}); await flush();
  await f.controller.control({action:'disconnect'});
  release({id:7,url:'https://www.figma.com/design/test/name'}); await ready;
  assert.equal(starts.length,0);
});

test('cache size refresh waits for capture and preserves size while MCP is busy', async () => {
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:'',addEventListener(){}});return elements.get(id);};
  let refresh,now=20000,state={state:'connected',capture:{state:'capturing'}};const sent=[];
  vm.runInNewContext(popupSource(await readFile('extension/popup.js','utf8')),{t,localizeDocument:()=>{},
    Date:{now:()=>now},document:{getElementById:element},window:{addEventListener(){}},setInterval:fn=>{refresh=fn;},clearInterval(){},
    chrome:{tabs:{query:async()=>[{id:7,url:'https://www.figma.com/design/test/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({})}},
    runtime:{sendMessage:async msg=>{sent.push(msg.action);return msg.action==='status'?state:{cache:{bytes:1048576}};}}}});
  await flush();assert.deepEqual(sent,['status']);assert.match(element('cache-status').textContent,/после загрузки/);
  state={state:'connected',capture:{state:'ready'}};await refresh();assert.deepEqual(sent,['status','status','cache-info']);
  assert.equal(element('cache-status').textContent,'Кеш: 1.00 МиБ.');
  now+=11000;state={state:'busy',busy:true,capture:{state:'ready'}};await refresh();
  assert.equal(sent.at(-1),'status');assert.equal(element('cache-status').textContent,'Кеш: 1.00 МиБ.');
  state={state:'connected',capture:{state:'ready'}};await refresh();assert.equal(sent.at(-1),'cache-info');
});

for (const method of ['get_screenshot','export_asset']) test(`${method} forwards ancestor path without navigating`, async () => {
 const f=await fixture({port:3055,secret},target), calls=[], updates=[];
 f.chrome.windows={update:async()=>{}};
 f.chrome.tabs.update=async(id,options)=>updates.push(options);
 f.chrome.scripting.executeScript=async({args:[action,params]})=>{
  calls.push({action,params});
  return action==='select_node' ? [{result:{result:{id:'1:1'}}}] : [{result:{error:'stop before copy',nativeCopyStarted:false}}];
 };
 const ws=f.sockets[0];ws.open();await ws.message({type:'ready'});
 await ws.message({type:'request',id:'path',method,params:{url:'https://www.figma.com/design/test/name?node-id=1-1',nodeId:'1:1',format:'PNG',ancestors:['0:1','0:2']}});
 assert.deepEqual(calls[0],{action:'select_node',params:{nodeId:'1:1',ancestors:['0:1','0:2']}});
 assert.equal(calls[1].action,'prepare_export');
 assert.ok(updates.every(o=>!o.url));
});
