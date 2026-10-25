import test from 'node:test';
import assert from 'node:assert/strict';
import {InitialSnapshotInspector} from '../dist/network-initial.js';
import {initialRecords,encodeRecord} from './wire-fixture.mjs';

test('initial evidence requires schema, ordered join, node records and end; arbitrary part boundaries work',()=>{
  const inspector=new InitialSnapshotInspector();const records=initialRecords();
  for(const record of records.slice(0,-1)) {
    const bytes=encodeRecord(record);for(let i=0;i<bytes.length;i+=7)inspector.push(bytes.subarray(i,i+7));
    assert.equal(inspector.progress.initialComplete,false);assert.throws(()=>inspector.evidence(1),/incomplete/);
  }
  const last=encodeRecord(records.at(-1));inspector.push(last.subarray(0,-1));assert.equal(inspector.progress.initialComplete,false);
  inspector.push(last.subarray(-1));assert.equal(inspector.progress.initialComplete,true);assert.equal(inspector.evidence(4).receivedParts,4);
});
for(const [name,mutate] of [
  ['missing schema',r=>r.slice(1).map((v,eventSequence)=>({...v,eventSequence}))],
  ['lost event',r=>[r[0],r[2],r[3]]],
  ['repeated event',r=>[r[0],r[0]]],
  ['foreign stream',r=>r.map((v,i)=>i===2?{...v,session:'other'}:v)],
  ['truncated wire',r=>[{...r[0],payload:Buffer.from('fig-wire').toString('base64')}]],
  ['invalid base64',r=>[{...r[0],payload:r[0].payload+'!'}]],
  ['text payload',r=>[{...r[0],opcode:1}]],
  ['after join end',r=>[...r,{...r[2],eventSequence:4}]],
])test(`initial inspector rejects ${name}`,()=>{
  const inspector=new InitialSnapshotInspector();assert.throws(()=>mutate(initialRecords()).forEach(r=>inspector.push(encodeRecord(r))));
});
for(const [name,messages] of [
  ['end before start',[{type:'JOIN_END'}]],
  ['empty initial load',[{type:'JOIN_START'},{type:'JOIN_END'}]],
  ['repeated start',[{type:'JOIN_START'},{type:'JOIN_START'}]],
  ['non-created node',[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:[{phase:'UPDATED'}]}]],
])test(`initial inspector rejects ${name}`,()=>{
  const inspector=new InitialSnapshotInspector();assert.throws(()=>initialRecords({messages}).forEach(r=>inspector.push(encodeRecord(r))));
});

test('nested override records are not mistaken for top-level initial nodes',()=>{
  const inspector=new InitialSnapshotInspector();
  const records=initialRecords({messages:[{type:'JOIN_START'},
    {type:'NODE_CHANGES',nodeChanges:[{phase:'CREATED',overrides:[{phase:'UPDATED'},{name:'override'}]}]}, {type:'JOIN_END'}]});
  for(const record of records)inspector.push(encodeRecord(record));
  assert.equal(inspector.progress.initialComplete,true);
});
