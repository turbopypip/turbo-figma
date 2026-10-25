// Saved-capture replay; raw references stay in the managed cache.
import {readNetworkSnapshot,releaseNetworkSelection} from '../dist/network-reader.js';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const [capture,url]=process.argv.slice(2);
if(!capture||!url)throw new Error('Expected CAPTURE_JSON SELECTION_URL');
const params={format:'debug',captureFile:resolve(capture),url,depth:50,maxNodes:100,maxBytes:150000,offset:0,includeHidden:false};
let continuation;const pages=[];
try {
 do {const r=await readNetworkSnapshot({...params,continuation});pages.push(r);continuation=r.traversal.continuation;}while(continuation);
 const nodes=pages.flatMap(p=>p.nodes),refs=nodes.flatMap(n=>n.style?.nativeBindings?.references??[]),reasons={};
 for(const r of refs)if(r.status!=='resolved')reasons[r.reason]=(reasons[r.reason]??0)+1;
 let valueChecks=0;const valueIssues=[];
 const cssFields={STACK_SPACING:'gap',STACK_PADDING_LEFT:'padding-left',STACK_PADDING_RIGHT:'padding-right'};
 const styleFields={RECTANGLE_TOP_LEFT_CORNER_RADIUS:'rectangleTopLeftCornerRadius',RECTANGLE_TOP_RIGHT_CORNER_RADIUS:'rectangleTopRightCornerRadius',RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS:'rectangleBottomLeftCornerRadius',RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS:'rectangleBottomRightCornerRadius'};
 for(const n of nodes)for(const ref of n.style?.nativeBindings?.references??[]) {
  if(ref.status!=='resolved')continue;
  let original;
  const paint=/^fillPaints\[(\d+)\]\.colorVar$/.exec(ref.path);
  if(paint)original=n.style.fills?.[Number(paint[1])]?.color;
  else if(cssFields[ref.path]) {const css=n.layout.css[cssFields[ref.path]];if(typeof css==='string'&&/^-?[\d.]+px$/.test(css))original=parseFloat(css);}
  else if(styleFields[ref.path])original=n.style.source[styleFields[ref.path]];
  if(original===undefined)continue;
  valueChecks++;
  if(JSON.stringify(original)!==JSON.stringify(ref.value))valueIssues.push({nodeId:n.id,path:ref.path,original,value:ref.value});
 }
 const summary={valueChecks,valueMismatches:valueIssues.length,source:'saved capture; not a fresh UI comparison',nodes:nodes.length,pages:pages.length,omittedNodes:nodes.filter(n=>n.propertiesOmitted).length,
  references:refs.length,definitionsResolved:refs.filter(r=>r.definitionStatus==='resolved').length,fallbackDifferences:refs.filter(r=>r.capturedValueCheck==='different-fallback').length,resolved:refs.filter(r=>r.status==='resolved').length,reasons,
  knownModes:refs.filter(r=>r.modeId).length,modeIndependent:refs.filter(r=>r.modeIndependent).length,
  maxResponseBytes:Math.max(...pages.map(p=>Buffer.byteLength(JSON.stringify(p)))),maxDependencyReads:Math.max(...pages.map(p=>p.nativeVariables.dependencyReads))};
 const directory=new URL('../.cache/figma-network/native-variable-checks/',import.meta.url);await mkdir(directory,{recursive:true});
 await writeFile(new URL('replay.json',directory),JSON.stringify({pages,valueIssues}));await writeFile(new URL('summary.json',directory),JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary,null,2));if(summary.omittedNodes||summary.valueMismatches)process.exitCode=1;
}finally{await releaseNetworkSelection();}
