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
  const chrome={storage:{local:area(local),session:area(stored)},alarms:{create:async()=>{},clear:async()=>{}},
    tabs:{get:async id=>({id,url:'https://www.figma.com/design/test/name'})},
    scripting:{executeScript:async()=>{requests++;return [{result:{result:{ok:true}}}];}}};
  const clock={setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},clearTimeout:id=>timers.delete(id),
    setInterval:(fn,delay)=>{intervals.set(++next,{fn,delay});return next;},clearInterval:id=>intervals.delete(id)};
  const controller=createConnection(chrome,{WebSocket:Socket,timers:clock,onState:s=>states.push(s),...overrides});
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
  await ws.message({type:'request',id:'1',method:'get_selection'});assert.equal(f.requests,1);
  ws.close(1006);assert.equal(f.intervals.size,0);
  assert.equal([...f.timers.values()][0].delay,1000);
  for(let i=0;i<8;i++){f.tick();f.sockets.at(-1).close(1006);}
  assert.equal([...f.timers.values()][0].delay,30000);
  await f.controller.wake();assert.equal(f.timers.size,0);assert.equal(f.requests,1);
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
test('uncertain export survives worker restart until Figma reload',async()=>{
  const f=await fixture({port:3055,secret},{...target,exportUncertain:true});
  const ws=f.sockets[0];ws.open();await ws.message({type:'ready'});
  await ws.message({type:'request',id:'png',method:'get_screenshot'});
  assert.match(ws.sent.at(-1).error,/Previous native copy/);assert.equal(f.requests,0);
  await f.controller.tabChanged(7,{status:'loading'},{id:7,url:'https://www.figma.com/design/test/a'});
  assert.equal(f.stored.connection.exportUncertain,false);
});
test('badge text, color and tooltip track serialized final state',async()=>{
  const values={};const action=Object.fromEntries(['setBadgeBackgroundColor','setBadgeText','setTitle'].map(key=>[key,async v=>{values[key]=v;}]));
  const show=createStatusBadge({action});show('connected');show('busy');await show('error');
  assert.equal(values.setBadgeText.text,'!');assert.equal(values.setBadgeBackgroundColor.color,'#b63030');assert.match(values.setTitle.title,/отклонено/);
  await show('stale');assert.match(values.setTitle.title,/снимок устарел/);assert.doesNotMatch(values.setTitle.title,/ключ/);
  await show('disconnected');assert.equal(values.setBadgeText.text,'OFF');
});
test('real WebSocket bridge restarts and background reconnects without replay',async()=>{
  const {WebSocket}=await import('ws');const {Bridge}=await import('../dist/bridge.js');
  let bridge=new Bridge(secret,0);await bridge.ready;const port=bridge.port;
  const f=await fixture({port,secret},target,{WebSocket,timers:globalThis});
  const wait=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,20));}};
  try {
    await wait(()=>f.states.at(-1)==='connected');assert.deepEqual(await bridge.request('get_selection',{}),{ok:true});
    await bridge.close();await wait(()=>f.states.at(-1)==='connecting');
    bridge=new Bridge(secret,port);await bridge.ready;await wait(()=>f.states.at(-1)==='connected');
    assert.equal(f.requests,1);assert.deepEqual(await bridge.request('get_selection',{}),{ok:true});
  } finally {await f.controller.control({action:'disconnect'});await bridge.close();}
});
test('popup close only stops UI refresh; information goes directly to README',async()=>{
  const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
  const source=await readFile(new URL('../extension/popup.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../extension/popup.html',import.meta.url),'utf8');
  const elements=Object.fromEntries(['status','target','connect','secret','port','submit','disconnect','forget','saved-secret','secret-field','change-secret','cache-status','cache-info','cache-clear'].map(id=>[id,{value:'',addEventListener(){}}]));
  const sent=[];let close,cleared=false;
  vm.runInNewContext(source,{document:{getElementById:id=>elements[id]},window:{addEventListener:(name,fn)=>{close=fn;}},
    setInterval:()=>1,clearInterval:()=>{cleared=true;},
    chrome:{tabs:{query:async()=>[{id:7,url:'https://www.figma.com/design/test/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({})}},runtime:{sendMessage:async msg=>{sent.push(msg);return {state:'connected',message:'Подключено'};}}}});
  await flush();assert.equal(elements['secret-field'].hidden,false);assert.equal(elements.secret.required,true);close();assert.equal(cleared,true);assert.deepEqual(sent.map(m=>m.action),['status']);
  assert.match(html,/href="https:\/\/github.com\/turbopypip\/figma-kilo-mcp#readme" target="_blank"/);
});
test('one secret entry pairs different Figma tabs and files, including after browser restart', async()=>{
  const {WebSocket}=await import('ws');
  const {Bridge}=await import('../dist/bridge.js');
  const bridge=new Bridge(secret,0);await bridge.ready;
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
      assert.deepEqual(await bridge.request('get_selection',{}),{tabId});
      assert.equal((await f.controller.control({action:'status'})).fileKey,targets.get(tabId));
    }
    assert.deepEqual(visited,[7,8,9,7,8]);
    await f.controller.tabChanged(8,{},undefined);
    // Browser restart clears session storage but retains the local pairing.
    restarted=await fixture(f.local.pairing,undefined,{WebSocket,timers:globalThis});
    assert.equal(restarted.states.at(-1),'disconnected');
    const result=await restarted.controller.control({action:'connect',tabId:10,port,secret:''});
    assert.equal(result.error,undefined);
    await waitConnected(restarted.controller);
    assert.deepEqual(await bridge.request('get_selection',{}),{ok:true});
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
  vm.runInNewContext(source,{Date,Number,document:{getElementById:id=>elements[id]},window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},
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
  vm.runInNewContext(source,{document:{getElementById:element},window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},
    chrome:{tabs:{query:async()=>[{id:7,url:'https://www.figma.com/design/test/name'}]},storage:{onChanged:{addListener(){},removeListener(){}},local:{get:async()=>({})}},
      runtime:{sendMessage:async msg=>{sent.push(msg);return msg.action==='status'?{state:'connected',message:'Подключено'}:
        {cache:{bytes:0,removedBytes:1024,removedGenerations:2,protectedEntries:1}};}}}});
  await flush(); assert.equal(element('cache-clear').disabled,false);
  await element('cache-clear').listeners.click();
  assert.deepEqual(sent.map(m=>m.action),['status','cache-clear']);
  assert.match(element('cache-status').textContent,/Удалено 2/);
  assert.match(element('cache-status').textContent,/сохранены/);
  assert.equal(element('status').textContent,'Подключено');
});
