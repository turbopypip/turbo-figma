// Usage: node scripts/check-network-layout.mjs CAPTURE_JSON UI_JSON ROOT_NODE_ID [context|debug]
// UI_JSON: a saved UI result, or {pages:[...], sameStateEvidence:"..."}.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseLayout } from '../extension/layout.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readNetworkSnapshot } from '../dist/network-reader.js';
import { compareLayoutPages } from '../dist/network-layout-parity.js';
const [captureFile, uiFile, rootId, format = 'context'] = process.argv.slice(2);
if (!['context','debug'].includes(format)) throw new Error('Expected context or debug format');
if (!captureFile || !uiFile || !/^\d+:\d+$/.test(rootId)) throw new Error('Expected CAPTURE_JSON UI_JSON ROOT_NODE_ID');
const uiBytes = await readFile(uiFile), ui = JSON.parse(uiBytes);
// The reader validates capture metadata. Do not materialize the entire capture to read its URL.
const first = ui.pages?.[0] ?? ui.context ?? ui;
const fileKey = first.fileKey ?? first.context?.fileKey;
if (!/^[a-zA-Z0-9]+$/.test(fileKey ?? '')) throw new Error('UI baseline must identify fileKey');
const url = `https://www.figma.com/design/${fileKey}/File?node-id=${rootId.replace(':','-')}`;
const pages = []; let continuation;
const seen = new Set();
do {
  const result = await readNetworkSnapshot({format,captureFile:resolve(captureFile),url,depth:50,maxNodes:100,offset:0,includeHidden:false,continuation});
  pages.push(result);
  continuation = result.traversal.continuation;
  if (continuation && seen.has(continuation)) throw new Error('Repeated continuation');
  if (continuation) seen.add(continuation);
  if (pages.length > 2000) throw new Error('Acceptance page limit exceeded');
} while (continuation);
const baselinePages=(ui.pages??[ui]).map(raw=>{const p=raw.context??raw;return {...p,nodes:p.nodes?.map(n=>({...n,layout:n.layout??parseLayout(n.properties)}))};});
const comparison = compareLayoutPages(baselinePages, pages, {sameStateEvidence:ui.sameStateEvidence,alignInstanceIds:ui.alignInstanceIds===true});
const report = {date:new Date().toISOString(), baselineSha256:createHash('sha256').update(uiBytes).digest('hex'),
  source:'saved inspector baseline vs replayed wire snapshot',format,networkPages:pages.length,...comparison};
const directory = new URL('../.cache/figma-network/layout-checks/', import.meta.url);
await mkdir(directory,{recursive:true});
const target = new URL(`${rootId.replace(':','-')}-${format}-parity.json`,directory);
await writeFile(target,JSON.stringify(report,null,2));
console.log(JSON.stringify({accepted:report.accepted,uiNodes:report.uiNodes,networkNodes:report.networkNodes,
  issueCounts:report.issues.reduce((out,i)=>(out[i.kind]=(out[i.kind]??0)+1,out),{}),report:target.pathname},null,2));
if (!report.accepted) process.exitCode=1;
