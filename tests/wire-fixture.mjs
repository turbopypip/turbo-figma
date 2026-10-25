import { parseSchema, encodeBinarySchema, compileSchema } from 'kiwi-schema';
const schema = parseSchema(`
enum MessageType { JOIN_START = 0; NODE_CHANGES = 1; JOIN_END = 2; }
enum NodePhase { CREATED = 0; UPDATED = 1; }
message NodeChange { NodePhase phase = 1; string name = 2; NodeChange[] overrides = 3; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; }
`);
const codec = compileSchema(schema);
export function zstd(bytes) {
  const prefix = Buffer.alloc(9); prefix.writeUInt32LE(0xfd2fb528); prefix[4] = 0xa0; prefix.writeUInt32LE(bytes.length, 5);
  const blocks = [];
  for (let offset=0;offset<bytes.length;offset+=131072) {
    const chunk=bytes.subarray(offset,offset+131072),header=Buffer.alloc(3);
    header.writeUIntLE((chunk.length<<3)|(offset+chunk.length===bytes.length?1:0),0,3);blocks.push(header,chunk);
  }
  return Buffer.concat([prefix,...blocks]);
}
export function initialRecords({session='worker',requestId='ws',messages}={}) {
  const header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
  const payloads=[Buffer.concat([header,zstd(encodeBinarySchema(schema))]),
    ...(messages||[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:[{phase:'CREATED',name:'test'}]},{type:'JOIN_END'}])
      .map(message=>zstd(codec.encodeMessage(message)))];
  return payloads.map((payload,eventSequence)=>({version:1,kind:'ws-received',session,requestId,eventSequence,opcode:2,payload:payload.toString('base64')}));
}
export const encodeRecord = record => Buffer.from(JSON.stringify(record)+'\n');
