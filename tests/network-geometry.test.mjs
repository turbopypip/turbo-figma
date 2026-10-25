import test from 'node:test';import assert from 'node:assert/strict';
import {geometryContext,compose} from '../dist/network-geometry.js';
import {networkLayout} from '../dist/network-layout.js';
const t=(x,y)=>({m00:1,m01:0,m02:x,m10:0,m11:1,m12:y});
test('canvas composition and inspector frame bounds handle groups, rotation, and separate coordinate systems',()=>{
 const canvas=geometryContext({type:'CANVAS'},'0:1');
 const frame=geometryContext({type:'FRAME',transform:t(100,200)},'1:1',canvas);
 const group=geometryContext({type:'FRAME',resizeToFit:true,transform:t(1,2)},'1:2',frame);
 const node={type:'VECTOR',size:{x:4,y:8},transform:{m00:0,m01:1,m02:3,m10:-1,m11:0,m12:10}};
 const geometry=geometryContext(node,'1:3',group),layout=networkLayout(node,undefined,undefined,geometry);
 assert.deepEqual(layout.geometry.absolutePosition,{x:104,y:212,space:'canvas'});
 assert.equal(layout.inspector.Left,'4px');assert.equal(layout.inspector.Top,'8px');assert.equal(layout.inspector.Rotation,'90°');
 assert.equal(layout.geometry.framePosition.frameId,'1:1');
 assert.ok(!layout.unavailable.includes('geometry.absolutePosition'));
 assert.equal(compose(null,geometry.canvas),null);
 assert.equal(compose({a:1e308,b:0,c:0,d:1,tx:0,ty:0},{a:1e308,b:0,c:0,d:1,tx:0,ty:0}),null);
});
