// Test client for the actual Rust MCP process; no server implementation here.
import {existsSync} from 'node:fs';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
export const rustBinary=process.env.TURBO_FIGMA_BINARY ?? fileURLToPath(new URL(`../target/release/turbo-figma${process.platform==='win32'?'.exe':''}`,import.meta.url));
if(!existsSync(rustBinary)) throw Error('Rust binary required: run npm run build');
export async function createNativeServer(secret='s'.repeat(64),port=0){
  if(!port){const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});port=probe.address().port;await new Promise(resolve=>probe.close(resolve));}
  const dir=await mkdtemp(path.join(os.tmpdir(),'figma-rust-test-'));
  const config=path.join(dir,'config.json');
  await writeFile(config,JSON.stringify({secret,port,assetDirectory:path.join(dir,'assets')}));
  const transport=new StdioClientTransport({command:rustBinary,args:['--server',config,dir],stderr:'pipe'});
  transport.stderr.on('data',()=>{});
  const client=new Client({name:'rust-integration-test',version:'1'});
  try{await client.connect(transport);}catch(error){await transport.close();await rm(dir,{recursive:true,force:true});throw error;}
  return {dir,port,client,transport,async status(){const result=await client.callTool({name:'get_connection_status',arguments:{}});if(result.isError)throw Error(result.content[0].text);return JSON.parse(result.content[0].text);},async close(){await client.close();await rm(dir,{recursive:true,force:true});}};
}
