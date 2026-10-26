import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {nativeCommand} from '../dist/native-command.js';
import {rustBinary} from '../dist/network-rust.js';
import {parseVariables,variablesFingerprint} from '../dist/variables.js';
import {mapNetworkNodeVariables} from '../dist/network-variables.js';
const native={skip:existsSync(rustBinary)?false:'Release helper not built'};
test('Rust UI-kit parser, aliases, fingerprints and exact CSS matching agree with Node',native,async()=>{
 const sources=[`:root {--base:32px;--mimir-space-a:var(--base);--mimir-space-b:32px;--dup:1px;--dup:2px;--cycle:var(--cycle);}`,`:root {--sapphire-normal:var(--sapphire-100);--gos-znak-test:#2355d7;--sapphire-100:#2355d7;--another-blue:#2355d7;--white:#fff;--alpha:rgb(255 255 255 / 40%);--mimir-font-inter:'Inter', sans-serif;--mimir-space-m:16px;--mimir-space-xl:24px;--mimir-size-text-l:16px;--mimir-control-radius:4px;--mimir-control-border-width:1px;}`,`/* before */ :root { --a: 1px; }\n // ignored\n:root {--b:var(--a);}`, ':root{}'];
 const css={width:'32.0px','font-size':'16px','line-height':'150%',color:'rgba(35, 85, 215, 1)',fill:'rgba(255,255,255,0.4)',stroke:'rgba(35,85,215,0.8)','font-family':'"Inter", sans-serif',padding:'16px 24px / 4px','border-radius':'4px','border-width':'1px','box-shadow':'0 0 2px #2355d7','z-index':'1050'};
 // Native JSON transport produces lexically ordered CSS keys; compare the same input representation.
 const ordered=Object.fromEntries(Object.entries(css).sort(([a],[b])=>a<b?-1:1));
 for(const source of sources){const vars=parseVariables(source);const parsed=await nativeCommand('--uikit',{op:'parse',source});assert.deepEqual(parsed.entries,[...vars]);assert.equal(parsed.fingerprint,variablesFingerprint(vars));const node={id:'1:1',layout:{css:ordered},style:{css:ordered,text:{base:{css:ordered},ranges:[{css:ordered}]}}};const expected=mapNetworkNodeVariables(node,vars);const result=await nativeCommand('--uikit',{op:'map',variables:parsed,nodes:[node]});assert.deepEqual(result[0],expected);}
 for(const source of ['@use "x"; :root {}', '@media (dark) {:root {--a:1px;}}'])await assert.rejects(nativeCommand('--uikit',{op:'parse',source}),/flat/);
});
test('native tool discovery resource stays aligned with the fallback contract',async()=>{
 const {readFile}=await import('node:fs/promises');const {createServer}=await import('../dist/server.js');const {NativeToolRegistry}=await import('../dist/native-mcp.js');const {nodeFields}=await import('../dist/network.js');const registry=new NativeToolRegistry();createServer({}, {}, undefined,undefined,undefined,false,registry.factory);assert.deepEqual(JSON.parse(await readFile('rust/helper/resources/tools.json','utf8')),{info:registry.info,instructions:registry.instructions,tools:registry.tools});assert.deepEqual(JSON.parse(await readFile('rust/helper/resources/fields.json','utf8')),[...nodeFields]);
});
