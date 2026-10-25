import {createHash} from 'node:crypto';
import {readSync,writeSync,ftruncateSync} from 'node:fs';
const SLOTS=32768, WIDTH=56;
/** Disk-only asset key/version -> GUID index. Duplicates fail closed, never pick a version. */
export class VariableAssetIndex {
  constructor(private fd:number){ftruncateSync(fd,SLOTS*WIDTH);}
  private slot(type:string,key:string,version:string|null) {
    if(key.length>4096||(version?.length??0)>256)throw new Error('Variable asset identity limit exceeded');
    const digest=createHash('sha256').update(JSON.stringify([type,key,version])).digest();
    const start=digest.readUInt32LE(0)%SLOTS;
    for(let i=0;i<4096;i++) {
      const offset=((start+i)%SLOTS)*WIDTH,buffer=Buffer.alloc(WIDTH);
      if(readSync(this.fd,buffer,0,WIDTH,offset)!==WIDTH)throw new Error('Truncated variable asset index');
      if(!buffer[48]||buffer.subarray(0,32).equals(digest))return {offset,buffer,digest};
    }
    throw new Error('Variable asset index capacity exceeded');
  }
  add(n:Record<string,any>) {
    if(!['VARIABLE','VARIABLE_SET'].includes(n.type)||typeof n.key!=='string')return;
    for(const version of [null,...(typeof n.version==='string'?[n.version]:[])]) {
      const s=this.slot(n.type,n.key,version);
      if(s.buffer[48]) {
        if(s.buffer.readDoubleLE(32)!==n.guid.sessionID||s.buffer.readDoubleLE(40)!==n.guid.localID)s.buffer[48]=2;
      } else {s.digest.copy(s.buffer);s.buffer.writeDoubleLE(n.guid.sessionID,32);s.buffer.writeDoubleLE(n.guid.localID,40);s.buffer[48]=1;}
      if(writeSync(this.fd,s.buffer,0,WIDTH,s.offset)!==WIDTH)throw new Error('Incomplete variable asset index write');
    }
  }
  get(type:string,ref:Record<string,any>):string|undefined {
    if(typeof ref?.key!=='string')return;
    const {buffer}=this.slot(type,ref.key,typeof ref.version==='string'?ref.version:null);
    return buffer[48]===1?`${buffer.readDoubleLE(32)}:${buffer.readDoubleLE(40)}`:undefined;
  }
}
