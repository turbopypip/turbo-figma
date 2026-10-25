// Compare a captured UI baseline and network context pages. Inputs may contain
// private design data; write the detailed output only into the ignored cache.
// Usage: node scripts/compare-network-ui.mjs ui-pages.json network-pages.json output.json
import fs from 'node:fs';
const [uiFile,networkFile,outputFile]=process.argv.slice(2);
if(!uiFile||!networkFile||!outputFile)throw Error('Supply UI pages, network pages and output JSON paths');
const up=JSON.parse(fs.readFileSync(uiFile)),np=JSON.parse(fs.readFileSync(networkFile));
const ui=[...new Map(up.flatMap(p=>p.nodes).map(n=>[n.id,n])).values()],net=np.flatMap(p=>p.nodes),aliases=new Map();
const issues=[],skipped=[],counts={};const add=(i,field,expected,actual)=>{if(typeof expected==='string'&&typeof actual==='string'&&/^-?[\d.]+px$/.test(expected)&&/^-?[\d.]+px$/.test(actual)){expected=parseFloat(expected);actual=parseFloat(actual);}counts[field]=(counts[field]??0)+1;if(typeof expected==='number'&&typeof actual==='number'?Math.abs(expected-actual)>.011:expected!==actual)issues.push({nodeId:net[i]?.id,uiId:ui[i]?.id,field,expected,actual:actual??null});};
let structure=ui.length===net.length;
for(let i=0;i<ui.length;i++){const u=ui[i],n=net[i];if(!n||u.name!==n.name||u.level-ui[0].level!==n.depth||(!n.id.startsWith('I')&&u.id!==n.id)){structure=false;issues.push({kind:'structure',i,ui:u.name,network:n?.name});}if(n)aliases.set(u.id,n.id);}
for(let i=1;i<ui.length;i++)if((aliases.get(ui[i].parentId)??ui[i].parentId)!==net[i]?.parentId){structure=false;issues.push({kind:'parent',i});}
if(structure)for(let i=0;i<ui.length;i++){
 const u=ui[i],n=net[i],css={...n.layout?.resolvedValues,...n.style?.resolvedValues,...n.style?.text?.base?.css,...n.style?.text?.base?.resolvedValues};
 for(const section of u.properties??[]){
  if(section.section==='content-inspection-panel')add(i,'text',section.text.replace(/^Content\n/,''),n.text);
  for(const f of section.fields??[]){const v=f.value;const dim=/^(?:Hug \(|Fill \()?(-?[\d.]+)px\)?$/.exec(v);
   if(['Width','Height'].includes(f.name)&&dim){add(i,f.name,+dim[1],n.layout.geometry?.size?.[f.name.toLowerCase()]);continue;}
   const keys={Font:'font-family',Weight:'font-weight',Size:'font-size','Line height':'line-height','Letter spacing':'letter-spacing','Horizontal alignment':'text-align'};
   if(section.section==='typography-inspection-panel'&&keys[f.name]){const key=keys[f.name];let actual=css[key];if(key==='font-family')actual=actual?.replace(/^"|"$/g,'');add(i,key,key==='text-align'?v.toLowerCase():v,actual);continue;}
   if(f.name==='Style'&&section.section==='typography-inspection-panel'){add(i,'font-name-style',v,n.style?.text?.base?.source?.fontName?.style);continue;}
   skipped.push({nodeId:n.id,field:f.name,value:v});
  }
 }
 const colors=u.layout?.colors?.map(c=>c.value)??[];
 const available=new Set([...(n.style?.fills??[]),...(n.style?.strokes??[]),...(n.style?.text?.base?.fills??[]),...(n.style?.text?.ranges??[]).flatMap(r=>r.fills??[])].map(c=>c.paintColor??c.cssColor));
 const channels=s=>/^rgba\(([^)]+)\)$/.exec(s??'')?.[1].split(',').map(Number);
 for(const color of colors){const a=channels(color);const matched=[...available].some(c=>{const b=channels(c);return a&&b&&a.length===4&&b.length===4&&a.every((v,k)=>Math.abs(v-b[k])<=(k===3?.005:.51));});add(i,'color',color,matched?color:[...available].filter(Boolean).join(' | '));}
}
const report={uiPages:up.length,uiNodes:ui.length,networkNodes:net.length,uiComplete:up.at(-1)?.traversal.complete,structureMatched:structure,checks:counts,checkCount:Object.values(counts).reduce((a,b)=>a+b,0),issueCount:issues.length,issues,skippedFieldCount:skipped.length,skipped};
fs.writeFileSync(outputFile,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,issues:issues.slice(0,8),skipped:undefined}));

if(!structure||issues.length)process.exitCode=1;
