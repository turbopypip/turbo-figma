import { existsSync } from 'node:fs';
import { rustBinary } from '../dist/network-rust.js';
import {parseSchema,compileSchema,encodeBinarySchema} from 'kiwi-schema';
import { createCaptureSender } from '../extension/network-transfer.js';
import {zstd} from './wire-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, cp, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { NetworkStore } from '../dist/network-store.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { pair, mockBrowser, PNG } from './helpers.mjs';
for (const standalone of [false, ...(existsSync(rustBinary) ? [true] : [])]) test(`real stdio MCP session: discovery, context, image, disk export, EOF cleanup${standalone ? ' (direct Rust binary)' : ''}`,  { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'figma MCP тест '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const secret = 'c'.repeat(64), configPath = path.join(dir, 'config.json');
  await writeFile(path.join(dir,'variables.scss'),':root {}');
  await writeFile(configPath, JSON.stringify({ secret, port, assetDirectory: path.join(dir, 'assets'), variablesFile:path.join(dir,'variables.scss') }));
  // Run a copied installation: startup retention must never touch the developer's cache.
  const installation = path.join(dir, 'installation');
  await mkdir(installation);
  await cp(path.resolve('dist'), path.join(installation, 'dist'), { recursive: true });
  await cp(path.resolve('package.json'), path.join(installation, 'package.json'));
  await symlink(path.resolve('node_modules'), path.join(installation, 'node_modules'), 'junction');
  const cache = await NetworkStore.create(installation);
  const capture = await cache.begin({ fileKey: 'test', sessionId: 'integration', generation: 1 }, { pageId: '1:1', frameId: '1:2' });
  await capture.append(0, Buffer.from('cached frame'));
  await capture.commit({ schemaReceived: true, joinStarted: true, joinEnded: true, receivedParts: 1, droppedParts: 0, sequenceComplete: true });
  const transport = new StdioClientTransport({ command: standalone ? rustBinary : process.execPath, args: standalone ? ['--server',configPath,installation] : [path.join(installation, 'dist', 'index.js')], cwd: dir,
    env: { ...process.env, ...(existsSync(rustBinary) ? { FIGMA_RUST_BINARY: process.env.FIGMA_RUST_BINARY ?? rustBinary } : {}), FIGMA_KILO_CONFIG: configPath }, stderr: 'pipe' });
  let diagnostics = ''; transport.stderr.on('data', chunk => { diagnostics += chunk; });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close()); await client.connect(transport);
  const { tools } = await client.listTools();
  if (existsSync(process.env.FIGMA_RUST_BINARY ?? rustBinary) && (process.env.FIGMA_NETWORK_BACKEND ?? (['darwin', 'win32'].includes(process.platform) ? 'rust' : 'node')) === 'rust') assert.match(diagnostics, /MCP stdio backend: rust/);
  for(const name of ['get_design_context']) assert.equal(tools.find(t=>t.name===name).inputSchema.properties.maxBytes.default,24000);
  assert.deepEqual(tools.map(t => t.name).sort(), ['export_assets', 'get_connection_status', 'get_design_context', 'get_screenshot', 'get_selection']);
  const status = async () => JSON.parse((await client.callTool({name: 'get_connection_status', arguments: {}})).content[0].text);
  assert.equal((await status()).state, 'disconnected');
  assert.equal((await status()).mcp, 'running');
  const absent = await client.callTool({ name: 'get_selection', arguments: {} });
  assert.equal(absent.isError, true); assert.match(absent.content[0].text, /not connected/);
  const invalid = await client.callTool({ name: 'get_design_context', arguments: { depth: 100 } });
  assert.equal(invalid.isError, true);
  let uiReads = 0;
  const ws = await pair(port, secret, (method, params) => {
    assert.equal(params.variablesFile, undefined);
    if (method === 'get_design_context') uiReads++;
    if (method === 'get_selection') throw Error('DOM selection must never be called');
    if (method === 'get_screenshot' && params.nodeId === '1:2') {
      assert.deepEqual(params.ancestors, ['1:1']);
      return mockBrowser(method, {}); // Simulate stale/wrong browser selection.
    }
    const result = mockBrowser(method, params);
    return method === 'get_design_context' ? { ...result, layout: { css: {gap:'32px'} } } : { ...result, fileKey: 'test' };
  }, 'test'); t.after(() => ws.terminate());
  assert.equal((await status()).state, 'connected');
  assert.equal(JSON.stringify(await status()).includes(secret), false);
  const selection = await client.callTool({ name: 'get_selection', arguments: {} });
  assert.equal(selection.isError, true); // No observed snapshot yet; never read mounted rows.
  const rejectedUI = await client.callTool({ name: 'get_design_context', arguments: { source: 'ui' } });
  assert.equal(rejectedUI.isError, true);
  assert.equal(uiReads, 0);
  const variablesFile = path.join(dir, 'variables.scss');
  // Network route uses the same configured file, supports a request override and never calls the UI bridge.
  const schema=parseSchema(`struct GUID { uint sessionID; uint localID; }
    struct Parent { GUID guid; string position; }
    message NodeChange { Parent parentIndex = 6; GUID guid = 1; string phase = 2; string type = 3; float fontSize = 4; string textData = 5; }
    message UserChange { GUID[] selection = 1; }
    message Message { string type = 1; NodeChange[] nodeChanges = 2; UserChange[] userChanges = 3; }`);
  const codec=compileSchema(schema),header=Buffer.alloc(12);header.write('fig-wire');header.writeUInt32LE(1,8);
  const payloads=[Buffer.concat([header,zstd(encodeBinarySchema(schema))]),
    ...[{type:'JOIN_START'},{type:'NODE_CHANGES',nodeChanges:[{guid:{sessionID:1,localID:1},phase:'CREATED',type:'TEXT',fontSize:20,textData:'Text'}, {guid:{sessionID:1,localID:2},phase:'CREATED',type:'TEXT',parentIndex:{guid:{sessionID:1,localID:1},position:'!'},fontSize:20,textData:'Child'}]},{type:'JOIN_END'}].map(m=>zstd(codec.encodeMessage(m)))];
  const captureFile=path.join(dir,'capture.json');
  await writeFile(captureFile,JSON.stringify({version:2,fileUrl:'https://www.figma.com/design/test/File',events:[
    {kind:'ws-open',key:'a',url:'wss://www.figma.com/api/multiplayer/test'},
    ...payloads.map(b=>({kind:'ws-received',key:'a',opcode:2,payload:b.toString('base64')}))]}));
  await writeFile(variablesFile,':root { --mimir-size-text-default:20px; }');
  const networkArgs={captureFile,url:'https://www.figma.com/design/test/File?node-id=1-1'};
  await assert.rejects(client.callTool({name:'get_network_tree',arguments:networkArgs}),/not found/);
  const primaryArgs = { url: networkArgs.url, maxNodes: 1 };
  const uiBefore = uiReads;
  const missing = await client.callTool({name:'get_design_context',arguments:primaryArgs});
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /capture/i);
  const sender = createCaptureSender(ws, {fileKey:'test',sessionId:'primary',generation:1});
  await sender.begin();
  for (const [eventSequence, b] of payloads.entries()) await sender.append(Buffer.from(JSON.stringify({version:1,kind:'ws-received',session:'main',requestId:'1',eventSequence,opcode:2,payload:b.toString('base64')})+'\n'));
  await sender.finish({schemaReceived:true,joinStarted:true,joinEnded:true,receivedParts:payloads.length,droppedParts:0,sequenceComplete:true});
  const unknownSelection = await client.callTool({name:'get_selection',arguments:{}});
  assert.equal(unknownSelection.isError, true);
  await sender.delta(Buffer.from(JSON.stringify({version:1,kind:'ws-sent',session:'main',requestId:'1',eventSequence:4,opcode:2,
    payload:zstd(codec.encodeMessage({type:'USER_CHANGES',userChanges:[{selection:[{sessionID:1,localID:1}]}]})).toString('base64')})+'\n'));
  const observed = await client.callTool({name:'get_selection',arguments:{}});
  assert.equal(observed.isError, undefined, JSON.stringify(observed));
  assert.equal(JSON.parse(observed.content[0].text).nodes[0].id,'1:1');
  const network=await client.callTool({name:'get_design_context',arguments:{url:networkArgs.url}});
  assert.equal(JSON.parse(network.content[0].text).nodes[0].layout.css['font-size'],'var(--mimir-size-text-default)');
  const overrideFile=path.join(dir,'override.scss');await writeFile(overrideFile,':root { --mimir-size-text-override:20px; }');
  const override=await client.callTool({name:'get_design_context',arguments:{url:networkArgs.url,variablesFile:overrideFile}});
  const overrideNode=JSON.parse(override.content[0].text).nodes[0];
  assert.equal(overrideNode.layout.css['font-size'],'var(--mimir-size-text-override)');
  assert.equal(overrideNode.layout.resolvedValues['font-size'],'20px');
  const primary = await client.callTool({name:'get_design_context',arguments:primaryArgs});
  assert.ok(primary.content[0].text.startsWith('{"traversal":'));
  assert.ok(Buffer.byteLength(primary.content[0].text)<=24000);
  assert.equal(primary.isError, undefined, JSON.stringify(primary));
  const first = JSON.parse(primary.content[0].text);
  assert.equal(first.adapter, 'figma-network-snapshot'); assert.equal(first.freshness.status, 'observed');
  assert.equal(first.nodes[0].id, '1:1'); assert.ok(first.traversal.continuation);
  const next = await client.callTool({name:'get_design_context',arguments:{...primaryArgs,continuation:first.traversal.continuation}});
  assert.equal(JSON.parse(next.content[0].text).nodes[0].id, '1:2');
  for (const args of [{nodeId:'1:1'}, {}]) {
    const response = await client.callTool({name:'get_design_context',arguments:args});
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.equal(JSON.parse(response.content[0].text).nodeCount, 2);
  }
  const wrong = await client.callTool({name:'get_design_context',arguments:{url:networkArgs.url.replace('/test/', '/wrong/')}});
  assert.equal(wrong.isError, true);
  assert.equal(uiReads, uiBefore);
  const screenshot = await client.callTool({ name: 'get_screenshot', arguments: {} });
  assert.equal(screenshot.content[0].mimeType, 'image/png'); assert.equal(screenshot.content[0].data, PNG);
  const wrongImage = await client.callTool({name:'get_screenshot', arguments:{nodeId:'1:2'}});
  assert.equal(wrongImage.isError, true);
  assert.match(wrongImage.content[0].text, /selection does not match/);
  const assets = await client.callTool({ name: 'export_assets', arguments: { nodeIds: ['1:1', 'missing'], format: 'SVG' } });
  const result = JSON.parse(assets.content[0].text);
  assert.match(await readFile(result.results[0].path, 'utf8'), /<svg/); assert.match(result.results[1].error, /not mounted/);
  const infoReply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'cache-control', id: 'info', action: 'cache-info' }));
  assert.equal(JSON.parse((await infoReply)[0]).result.generations, 2);
  const clearReply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'cache-control', id: 'clear', action: 'cache-clear' }));
  assert.equal(JSON.parse((await clearReply)[0]).result.removedGenerations, 2);
  assert.equal((await cache.info()).generations, 0);
  assert.match(await readFile(result.results[0].path, 'utf8'), /<svg/);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).secret, secret);
  assert.equal(diagnostics.includes(secret), false);
  const disconnected = once(ws, 'close'); sender.cancel(); await disconnected;
  const stale = await client.callTool({name:'get_design_context',arguments:primaryArgs});
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /STALE/);
  assert.equal(uiReads, uiBefore);
  const pid = transport.pid;
  await client.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const reuse = net.createServer(); await new Promise((resolve, reject) => { reuse.once('error', reject); reuse.listen(port, '127.0.0.1', resolve); });
  await new Promise(r => reuse.close(r));
});
