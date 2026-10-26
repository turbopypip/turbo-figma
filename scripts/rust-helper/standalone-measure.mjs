// Diagnostic comparison of the actual MCP servers; synthetic browser transport, real captured bytes.
import {readFile,writeFile,mkdtemp,rm,mkdir,cp,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {pair} from '../../tests/helpers.mjs';
import {createCaptureSender} from '../../extension/network-transfer.js';
import {rustBinary} from '../../dist/network-rust.js';
const corpus=path.resolve('.cache/figma-network/rust-corpus-real');
const probe=JSON.parse(await readFile(path.join(corpus,'probe.json')));
const records=probe.events.filter(e=>e.kind==='ws-received').map((e,eventSequence)=>Buffer.from(JSON.stringify({version:1,kind:'ws-received',session:'real',requestId:'real',eventSequence,opcode:2,payload:e.payload})+'\n'));
const results=[];
for(let run=0;run<3;run++)for(const backend of run%2?['rust','node']:['node','rust']){
 const dir=await mkdtemp(path.join(tmpdir(),'figma-native-measure-'));let client,ws,sender,timer;
 try{
  const install=path.join(dir,'install');await mkdir(install);await cp(path.resolve('dist'),path.join(install,'dist'),{recursive:true});await cp('package.json',path.join(install,'package.json'));await symlink(path.resolve('node_modules'),path.join(install,'node_modules'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const secret='m'.repeat(64);const config=path.join(dir,'config.json');await writeFile(config,JSON.stringify({secret,port,assetDirectory:path.join(dir,'assets'),variablesFile:path.join(corpus,'profile-ui-kit.variables.scss')}));
  const transport=new StdioClientTransport({command:backend==='rust'?rustBinary:process.execPath,args:backend==='rust'?['--server',config,install]:[path.join(install,'dist/index.js')],env:{...process.env,FIGMA_NETWORK_BACKEND:'node',FIGMA_KILO_CONFIG:config},stderr:'pipe'});let stderr='';transport.stderr.on('data',b=>stderr+=b);client=new Client({name:'measure',version:'1'});await client.connect(transport);if(backend==='rust'&&!stderr.includes('standalone'))throw Error('Native server not selected');
  ws=await pair(port,secret,undefined,'corpus');sender=createCaptureSender(ws,{fileKey:'corpus',sessionId:'benchmark',generation:1});await sender.begin();let parts=0;
  for(const record of records)for(let offset=0;offset<record.length;offset+=256*1024){await sender.append(record.subarray(offset,offset+256*1024));parts++;}
  await sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:parts,droppedParts:0,sequenceComplete:true});
  let peak=0;const sample=()=>{try{peak=Math.max(peak,Number(execFileSync('/bin/ps',['-o','rss=','-p',String(transport.pid)],{encoding:'utf8'}).trim())*1024);}catch{}};sample();timer=setInterval(sample,50);
  for(const [scenario,id] of [['component','3215:21227'],['section','3215:21204']]){
   const pages=async()=>{const start=performance.now();let continuation,pages=0,nodes=0,firstMs;do{const response=await client.callTool({name:'get_design_context',arguments:{url:`https://www.figma.com/design/corpus/File?node-id=${id.replace(':','-')}`,depth:12,maxNodes:200,maxBytes:24000,...(continuation?{continuation}:{})}});if(response.isError)throw Error(response.content[0].text);const value=JSON.parse(response.content[0].text);firstMs??=performance.now()-start;continuation=value.traversal.continuation;pages++;nodes+=value.nodes.length;if(pages>100)throw Error('Too many pages');}while(continuation);return {firstMs,totalMs:performance.now()-start,pages,nodes};};
   const cold=await pages(),warm=await pages();sample();results.push({run,backend,scenario,cold,warm,sampledServerRssBytes:peak});
  }
 }finally{clearInterval(timer);sender?.cancel();ws?.terminate();await client?.close();await rm(dir,{recursive:true,force:true});}
}
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];const summary=[];for(const scenario of ['component','section'])for(const backend of ['node','rust']){const rows=results.filter(r=>r.scenario===scenario&&r.backend===backend);summary.push({scenario,backend,coldAllMs:median(rows.map(r=>r.cold.totalMs)),warmAllMs:median(rows.map(r=>r.warm.totalMs)),pages:rows[0].warm.pages,nodes:rows[0].warm.nodes,maxSampledServerRssBytes:Math.max(...rows.map(r=>r.sampledServerRssBytes))});}
const report={date:'2026-10-26',platform:process.platform,arch:process.arch,method:'Three alternating runs of actual MCP servers, captured initial input via simulated extension, all pages with UI-kit. Cold starts after capture and before index construction. RSS sampled every 50 ms for server only; excludes real browser/extension, client and capture ingestion peaks. CPU not measured; no cross-platform or total RAM acceptance.',binarySha256:createHash('sha256').update(await readFile(rustBinary)).digest('hex'),summary,results};await writeFile(process.argv[2]??'docs/rust-standalone-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
