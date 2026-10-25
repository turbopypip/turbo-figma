import assert from 'node:assert/strict';
// Normalize only documented volatile fields at exact public-response paths.
// Arrays, numeric values, errors, IDs, revisions and completeness remain exact.
function normalized(value, allowMarkers) {
 const result=JSON.parse(JSON.stringify(value));
 if(result?.traversal && Object.hasOwn(result.traversal,'continuation')) {
  const token=result.traversal.continuation;
  assert.ok(token===null || (allowMarkers && token==='<continuation>') || (typeof token==='string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)),'Invalid continuation');
  if(token!==null)result.traversal.continuation='<continuation>';
 }
 if(Object.hasOwn(result??{},'capturedAt')) {
  assert.equal(typeof result.capturedAt,'string');
  assert.ok((allowMarkers && result.capturedAt==='<capture-time>') || Number.isFinite(Date.parse(result.capturedAt)),'Invalid capturedAt');
  result.capturedAt='<capture-time>';
 }
 return result;
}
export function normalize(value) {return normalized(value,false);}
export function compare(expected,actual) {assert.deepEqual(normalize(actual),normalized(expected,true));}
export async function collectPages(read,options) {
 const pages=[],ids=new Set();let continuation,offset=options.offset??0;
 for(let i=0;i<10000;i++) {
  const page=await read({...options,...(continuation?{continuation}:{offset})});
  assert.ok(Array.isArray(page.nodes),'Missing nodes');
  for(const n of page.nodes){assert.ok(!ids.has(n.id),`Duplicate node ${n.id}`);ids.add(n.id);}
  pages.push(page);
  const next=page.traversal.nextOffset;
  if(next===null) {
   if(Object.hasOwn(page.traversal,'continuation'))assert.equal(page.traversal.continuation,null);
   assert.equal(ids.size,page.traversal.eligibleRecords);
   return pages;
  }
  assert.ok(Number.isSafeInteger(next)&&next>offset,'Pagination stalled');
  offset=next;continuation=page.traversal.continuation;
 }
 throw Error('Page limit exceeded');
}
