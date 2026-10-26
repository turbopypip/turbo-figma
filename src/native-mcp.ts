import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { rustBinary } from './network-rust.js';

export type ServerFactory = (...args: ConstructorParameters<typeof McpServer>) => McpServer;
export class NativeToolRegistry {
  info: unknown;
  instructions?: string;
  tools: unknown[] = [];
  private handlers = new Map<string, {schema: z.ZodType; handler: (args: any, ctx: any) => unknown}>();
  factory: ServerFactory = (info, options) => {
    this.info=info; this.instructions=options?.instructions;
    return {registerTool:(name: string, definition: any, handler: any) => {
      this.tools.push({name,description:definition.description,inputSchema:z.toJSONSchema(definition.inputSchema,{io:'input',target:'draft-7'}),annotations:definition.annotations});
      this.handlers.set(name,{schema:definition.inputSchema,handler});
    }} as unknown as McpServer;
  };
  async call(name: string, args: unknown, signal: AbortSignal) {
    try {
      const tool=this.handlers.get(name);if(!tool)throw new Error('Tool not found');
      return await tool.handler(tool.schema.parse(args ?? {}),{mcpReq:{signal}});
    } catch(error) {return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Request failed'}]};}
  }
}
export async function serveNativeMcp(registry: NativeToolRegistry) {
  const directory=await mkdtemp('/tmp/figma-mcp-');const filename=directory+'/ipc';
  const ipc=createServer();let socket:Socket|undefined;const active=new Map<number,AbortController>();let buffer:Buffer=Buffer.alloc(0);
  const LIMIT=13*1024*1024;
  const send=(value:unknown)=>{if(!socket||socket.destroyed)return;const b=Buffer.from(JSON.stringify(value));if(b.length>LIMIT||socket.writableLength+b.length>2*LIMIT){socket.destroy();return;}const h=Buffer.alloc(4);h.writeUInt32LE(b.length);socket.write(h);socket.write(b);};
  const abort=()=>{for(const controller of active.values())controller.abort();active.clear();};
  ipc.on('connection',peer=>{
    if(socket){peer.destroy();return;}socket=peer;
    peer.on('error',()=>{});peer.on('close',abort);
    peer.on('data',(chunk:Buffer)=>{
      try {
        if(buffer.length+chunk.length>LIMIT+65536)throw new Error('Native MCP input limit exceeded');buffer=Buffer.concat([buffer,chunk]);
        while(buffer.length>=4){const n=buffer.readUInt32LE();if(n>65536)throw new Error('Native MCP command limit exceeded');if(buffer.length<n+4)break;
          const q=JSON.parse(buffer.subarray(4,n+4).toString());buffer=buffer.subarray(n+4);
          if(q.kind==='cancel'){active.get(q.id)?.abort();continue;}
          if(q.kind!=='call'||!Number.isSafeInteger(q.id)||active.has(q.id)||active.size>=8)throw new Error('Invalid native MCP command');
          const controller=new AbortController();active.set(q.id,controller);
          void registry.call(q.name,q.arguments,controller.signal).then(result=>send({id:q.id,result})).finally(()=>active.delete(q.id));
        }
      }catch{peer.destroy();}
    });
    send({info:registry.info,instructions:registry.instructions,tools:registry.tools});
  });
  try {await new Promise<void>((resolve,reject)=>{ipc.once('error',reject);ipc.listen(filename,resolve);});}
  catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  const child=spawn(process.env.FIGMA_RUST_BINARY ?? rustBinary,['--mcp',filename],{stdio:['inherit','inherit','pipe'],windowsHide:true});
  let diagnostics='';child.stderr.on('data',(b:Buffer)=>{if(diagnostics.length+b.length<65536)diagnostics+=b.toString();else child.kill('SIGKILL');});
  const kill=()=>{child.kill('SIGKILL');};process.once('exit',kill);
  let failure:Error|undefined;child.on('error',e=>{failure=e;});
  const done=new Promise<void>(resolve=>child.once('close',code=>{
    process.off('exit',kill);abort();socket?.destroy();ipc.close();
    if(code!==0&&code!==null){process.exitCode=1;console.error(diagnostics.trim()||failure?.message||'Native MCP exited');}
    resolve();
  }));
  return {done,async close(){kill();await done;await rm(directory,{recursive:true,force:true});}};
}
