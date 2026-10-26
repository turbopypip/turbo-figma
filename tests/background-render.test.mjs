import test from 'node:test';
import assert from 'node:assert/strict';
import {withBackgroundRendering} from '../extension/background-render.js';
for(const attached of [false,true]) for(const fail of [false,true]) test(`background rendering restores state: attached=${attached} failed=${fail}`,async()=>{
 const calls=[];
 const chrome={debugger:{attach:async()=>calls.push('attach'),detach:async()=>calls.push('detach'),sendCommand:async(target,method,p)=>{assert.deepEqual(target,{tabId:7});assert.equal(method,'Emulation.setFocusEmulationEnabled');calls.push(p.enabled);}}};
 const run=()=>withBackgroundRendering(chrome,7,attached,async()=>{calls.push('work');if(fail)throw Error('failed');return 42;});
 if(fail)await assert.rejects(run,/failed/);else assert.equal(await run(),42);
 assert.deepEqual(calls,attached?['work']:['attach',true,'work',false,'detach']);
});
test('failed debugger attachment does not reset somebody else’s session',async()=>{
 let resets=0;
 const chrome={debugger:{attach:async()=>{throw Error('occupied');},sendCommand:async()=>resets++,detach:async()=>resets++}};
 await assert.rejects(()=>withBackgroundRendering(chrome,7,false,()=>{}),/occupied/);
 assert.equal(resets,0);
});
