import test from 'node:test';
import assert from 'node:assert/strict';
import { networkLayout } from '../dist/network-layout.js';

test('local geometry preserves transforms and computes rotated parent bounds without inventing absolute coordinates', () => {
 const r=networkLayout({size:{x:100,y:20},transform:{m00:0,m01:-1,m02:30,m10:1,m11:0,m12:40}});
 assert.deepEqual(r.geometry.size,{width:100,height:20});
 assert.deepEqual(r.geometry.position,{x:30,y:40,space:'parent'});
 assert.deepEqual(r.geometry.parentBounds,{x:10,y:40,width:20,height:100,provenance:'computed-from-size-and-transform'});
 assert.ok(r.unavailable.includes('geometry.absolutePosition'));assert.equal(r.sizing.width.mode,null);
 assert.deepEqual(networkLayout({size:{x:-1,y:4},transform:{m00:Infinity}}).geometry.size,null);
 assert.equal(networkLayout({size:{x:1e308,y:1e308},transform:{m00:1e308,m01:0,m02:0,m10:0,m11:1,m12:0}}).geometry.parentBounds,null);
});
test('Auto Layout keeps zero, asymmetric padding and observed space-between semantics; missing fields stay unavailable', () => {
 const n={stackMode:'VERTICAL',stackSpacing:0,stackHorizontalPadding:40,stackVerticalPadding:32,stackPaddingRight:0,stackPaddingBottom:8,
  stackPrimaryAlignItems:'SPACE_EVENLY',stackCounterAlignItems:'CENTER'};
 const r=networkLayout(n);
 assert.deepEqual(r.autoLayout.padding,{top:32,right:0,bottom:8,left:40});assert.equal(r.css.gap,undefined);assert.equal(r.source.stackSpacing,0);assert.equal(r.autoLayout.gap,null);
 assert.equal(networkLayout({stackMode:'HORIZONTAL',stackSpacing:0}).css.gap,'0px');
 assert.equal(r.css['justify-content'],'space-between');assert.equal(r.css['align-items'],'center');
 const missing=networkLayout({stackMode:'HORIZONTAL',stackHorizontalPadding:40});
 assert.equal(missing.autoLayout.padding.right,null);assert.equal(missing.autoLayout.gap,null);
 assert.ok(missing.unavailable.includes('autoLayout.padding.right'));
 assert.equal(networkLayout({stackMode:'GRID'}).css.display,undefined);
 assert.equal(networkLayout({stackMode:'HORIZONTAL',stackPrimaryAlignItems:'UNVERIFIED'}).autoLayout.primaryAlignment,null);
});
test('sizing resolves both parent axes and Fill precedence, rejects absent rules and absolute positioning', () => {
 const n={size:{x:444,y:280},stackMode:'VERTICAL',stackPrimarySizing:'FIXED',stackCounterSizing:'RESIZE_TO_FIT',stackChildAlignSelf:'STRETCH'};
 const r=networkLayout(n,{stackMode:'HORIZONTAL'});
 assert.equal(r.sizing.height.mode,'fill');assert.equal(r.sizing.width.mode,'hug');
 assert.equal(r.css.height,undefined);assert.equal(r.css.width,undefined);
 assert.equal(networkLayout({...n,stackPositioning:'ABSOLUTE'},{stackMode:'HORIZONTAL'}).sizing.height.mode,'fixed');
 assert.equal(networkLayout({...n,stackChildPrimaryGrow:1},{stackMode:'VERTICAL'}).sizing.height.mode,'fill');
 assert.equal(networkLayout({...n,stackChildPrimaryGrow:1},{stackMode:'HORIZONTAL'}).sizing.width.mode,'fill');
 assert.equal(networkLayout({size:{x:444,y:280}}).sizing.width.mode,null);
 assert.equal(networkLayout({...n,stackCounterSizing:'FIXED'}).css.width,'444px');
 assert.deepEqual(r.source.size,n.size);assert.equal(r.complete,false);
});

test('wrap keeps primary and cross gaps distinct, reports overlap instead of invalid negative CSS gap',()=>{
 const r=networkLayout({stackMode:'HORIZONTAL',stackWrap:'WRAP',stackSpacing:-8,stackCounterSpacing:4});
 assert.equal(r.css['flex-wrap'],'wrap');assert.equal(r.css['row-gap'],'4px');
 assert.equal(r.css.gap,undefined);assert.equal(r.css['column-gap'],undefined);
 assert.ok(r.unavailable.includes('autoLayout.negativeSpacingRequiresOverlap'));
 const column=networkLayout({stackMode:'VERTICAL',stackWrap:'WRAP',stackSpacing:8,stackCounterSpacing:4});
 assert.equal(column.css['row-gap'],'8px');assert.equal(column.css['column-gap'],'4px');
 const distributed=networkLayout({stackMode:'HORIZONTAL',stackWrap:'WRAP',stackCounterSpacing:4,stackCounterAlignContent:'SPACE_BETWEEN'});
 assert.equal(distributed.css['align-content'],'space-between');assert.equal(distributed.css['row-gap'],undefined);
});
test('min/max constraints and measured geometry remain separate from layout sizing',()=>{
 const r=networkLayout({size:{x:1824,y:280},transform:{m00:1,m01:0,m02:0,m10:0,m11:1,m12:0},opacity:1,
  minSize:{value:{x:0,y:12}},maxSize:{value:{x:2000,y:Infinity}},horizontalConstraint:'STRETCH'});
 assert.equal(r.copyText,undefined); assert.deepEqual(r.measuredCss,{width:'1824px',height:'280px'});
 assert.equal(r.css.width,undefined);assert.equal(r.css['min-width'],'0px');assert.equal(r.css['max-width'],'2000px');
 assert.equal(r.css['max-height'],undefined);assert.equal(r.constraints.horizontal,'STRETCH');
 assert.equal(networkLayout({}).copyText,undefined);
});
test('verified frame defaults restore Hug primary and Fixed counter without defaulting unknown schemas or instances',async()=>{
 const {VERIFIED_LAYOUT_SCHEMA}=await import('../dist/network-layout.js');
 for(const stackMode of ['HORIZONTAL','VERTICAL']) {
  const n={type:'FRAME',stackMode,size:{x:444,y:280}};
  const r=networkLayout(n,undefined,VERIFIED_LAYOUT_SCHEMA);
  assert.equal(r.sizing[stackMode==='HORIZONTAL'?'width':'height'].mode,'hug');
  assert.equal(r.sizing[stackMode==='HORIZONTAL'?'height':'width'].mode,'fixed');
  assert.equal(networkLayout(n).sizing.width.mode,null);
  assert.equal(networkLayout({...n,type:'INSTANCE'},undefined,VERIFIED_LAYOUT_SCHEMA).sizing.width.mode,null);
  assert.equal(networkLayout({...n,stackPrimarySizing:'UNRECOGNIZED'},undefined,VERIFIED_LAYOUT_SCHEMA).sizing[stackMode==='HORIZONTAL'?'width':'height'].mode,null);
 }
});
