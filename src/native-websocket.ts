import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rustBinary, rustMode } from './network-rust.js';

const LIMIT = 13 * 1024 * 1024;
export function nativeWebSocketEnabled() {
  return process.platform !== 'win32' && rustMode() === 'rust' && existsSync(process.env.FIGMA_RUST_BINARY ?? rustBinary);
}
class NativeSocket extends EventEmitter {
  readyState = 1;
  constructor(readonly id: number, private owner: NativeWebSocketServer) { super(); }
  send(data: string, callback?: (error?: Error) => void) {
    if (this.readyState !== 1) { callback?.(new Error('Socket is closed')); return; }
    try { this.owner.command({op:'send',id:this.id,data}); callback?.(); }
    catch (error) { callback?.(error as Error); this.terminate(); }
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    this.readyState = 2; this.owner.command({op:'close',id:this.id,code,reason});
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 2; this.owner.command({op:'terminate',id:this.id});
  }
  closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.emit('close', code, Buffer.from(reason));
  }
}
/** Compatibility surface for Bridge; Rust owns TCP/WebSocket framing and socket limits. */
export class NativeWebSocketServer extends EventEmitter {
  readonly clients = new Set<NativeSocket>();
  private sockets = new Map<number, NativeSocket>();
  private child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private port = 0;
  private stopped = false;
  private startup: NodeJS.Timeout;
  private diagnostic = '';
  private closed: Promise<void>;
  private kill = () => { this.child.kill('SIGKILL'); };
  constructor(options: {port: number}) {
    super();
    this.child = spawn(process.env.FIGMA_RUST_BINARY ?? rustBinary, ['--websocket'], {stdio:['pipe','pipe','pipe'],windowsHide:true});
    process.once('exit',this.kill);
    this.startup=setTimeout(()=>this.fail(new Error('Native WebSocket startup timed out')),10000);
    this.child.on('error',error => this.fail(error)); this.child.stdin.on('error',error => this.fail(error));
    this.child.stderr.on('data',(b: Buffer) => { if (this.diagnostic.length+b.length>65536) this.fail(new Error('Native WebSocket diagnostic limit exceeded')); else this.diagnostic+=b.toString(); });
    this.child.stdout.on('data',(b: Buffer) => {
      try {
        if (this.buffer.length+b.length>LIMIT+65536) throw new Error('Native WebSocket buffer limit exceeded');
        this.buffer=Buffer.concat([this.buffer,b]);
        while (this.buffer.length>=4) {
          const n=this.buffer.readUInt32LE(); if (n>LIMIT) throw new Error('Native WebSocket packet limit exceeded');
          if(this.buffer.length<4+n) break;
          const event=JSON.parse(this.buffer.subarray(4,4+n).toString());this.buffer=this.buffer.subarray(4+n);this.receive(event);
        }
      } catch(error) { this.fail(error as Error); }
    });
    this.closed=new Promise(resolve => this.child.once('close',code => {
      this.stopped=true;clearTimeout(this.startup);process.off('exit',this.kill);
      for(const socket of this.clients)socket.closed(1006,'');this.clients.clear();this.sockets.clear();
      if(code!==0&&code!==null)this.emit('error',new Error(this.diagnostic.trim()||`Native WebSocket exited (${code})`));
      resolve();
    }));
    this.command({port:options.port});
  }
  private fail(error: Error) { this.emit('error',error);this.kill(); }
  private receive(event: any) {
    if(event.event==='listening'){clearTimeout(this.startup);this.port=event.port;this.emit('listening');return;}
    if(event.event==='connection'){
      const socket=new NativeSocket(event.id,this);this.sockets.set(event.id,socket);this.clients.add(socket);this.emit('connection',socket);return;
    }
    const socket=this.sockets.get(event.id);if(!socket)return;
    if(event.event==='closing'){socket.readyState=2;return;}
    if(event.event==='message')socket.emit('message',Buffer.from(event.data));
    else if(event.event==='close'){socket.closed(event.code,event.reason);this.sockets.delete(event.id);this.clients.delete(socket);}
  }
  command(value: unknown) {
    if(this.stopped)return;
    const b=Buffer.from(JSON.stringify(value));
    if(b.length>LIMIT||this.child.stdin.writableLength+b.length>2*LIMIT){this.fail(new Error('Native WebSocket write budget exceeded'));return;}
    const header=Buffer.alloc(4);header.writeUInt32LE(b.length);this.child.stdin.write(header);this.child.stdin.write(b);
  }
  address() { return {port:this.port}; }
  close(callback: () => void) { this.kill();void this.closed.then(callback); }
}
