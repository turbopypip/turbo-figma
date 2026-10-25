// Replay against saved inspector observations. Raw baselines and results stay in the managed cache.
// Usage: node scripts/check-network-style.mjs CAPTURE_JSON BASELINE_JSON [context|debug]
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readNetworkSnapshot,releaseNetworkSelection} from '../dist/network-reader.js';
const [capture,baselineFile,format='context']=process.argv.slice(2);
if(!capture||!baselineFile||!['context','debug'].includes(format))throw new Error('Expected CAPTURE_JSON BASELINE_JSON [context|debug]');
const raw=await readFile(baselineFile), baseline=JSON.parse(raw);
if(!/^[a-zA-Z0-9]+$/.test(baseline.fileKey)||!baseline.observationEvidence||!baseline.cases?.length)throw new Error('Baseline requires fileKey, observationEvidence and nonempty cases');
let checks=0,pages=0;const issues=[],bytes=[];
try {
 for(const sample of baseline.cases) {
  if(!/^\d+:\d+$/.test(sample.nodeId)||!sample.checks?.length)throw new Error('Invalid baseline case');
  const result=await readNetworkSnapshot({captureFile:resolve(capture),format,url:`https://www.figma.com/design/${baseline.fileKey}/File?node-id=${sample.nodeId.replace(':','-')}`,depth:0,maxNodes:1,offset:0,includeHidden:false,maxBytes:150000});
  pages++;bytes.push(Buffer.byteLength(JSON.stringify(result)));
  const node=result.nodes.find(n=>n.id===sample.nodeId);
  if(!node||node.propertiesOmitted||node.instanceUnresolved)issues.push({nodeId:sample.nodeId,reason:'Missing, omitted or unresolved node'});
  for(const check of sample.checks) {
   if(!Array.isArray(check.path)||!check.path.length||!Object.hasOwn(check,'expected')||check.path.some(k=>['__proto__','constructor','prototype'].includes(String(k))))throw new Error('Invalid check');
   const actual=check.path.reduce((v,k)=>v?.[k],node);checks++;
   const ok=typeof actual==='number'&&typeof check.expected==='number'?Math.abs(actual-check.expected)<=(check.tolerance??0):JSON.stringify(actual)===JSON.stringify(check.expected);
   if(!ok)issues.push({nodeId:sample.nodeId,path:check.path,expected:check.expected,actual:actual??null});
  }
 }
} finally { await releaseNetworkSelection(); }
const report={accepted:!issues.length,date:new Date().toISOString(),format,baselineSha256:createHash('sha256').update(raw).digest('hex'),observationEvidence:baseline.observationEvidence,cases:baseline.cases.length,checks,pages,maxResponseBytes:Math.max(...bytes),issues};
const directory=new URL('../.cache/figma-network/style-checks/',import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL(`acceptance-${format}.json`,directory),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));if(issues.length)process.exitCode=1;
