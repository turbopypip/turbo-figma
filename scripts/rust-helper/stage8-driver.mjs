import fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {nodeJob,rustJob} from './stage8-host.mjs';
const [impl,file]=process.argv.slice(2),config=JSON.parse(await readFile(file));
let prefix,nativeMetrics;const fds=new Set(),io={reads:0,readBytes:0,writes:0,writeBytes:0};
const originals=Object.fromEntries(['openSync','closeSync','readSync','writeSync'].map(k=>[k,fs[k]]));
fs.openSync=(name,...args)=>{const fd=originals.openSync(name,...args);if(String(name).startsWith(prefix+'/'))fds.add(fd);return fd;};
fs.closeSync=(fd)=>{fds.delete(fd);return originals.closeSync(fd);};
for(const [key,count,bytes] of [['readSync','reads','readBytes'],['writeSync','writes','writeBytes']])fs[key]=(fd,...args)=>{const n=originals[key](fd,...args);if(fds.has(fd)){io[count]++;io[bytes]+=n;}return n;};
syncBuiltinESMExports();
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=createHash('sha256'),rows=[];let loaded;const cpu=process.cpuUsage(),start=performance.now();
await (impl==='rust'?rustJob:nodeJob)(config,row=>{
 if(impl==='node')row.stats.io={...io};
 row.stats.allocatedScratchBytes=['nodes.bin','index.bin','edges.bin','variable-assets.bin'].reduce((n,f)=>n+fs.statSync(prefix+'/'+f).blocks*512,0);
 if(row.kind==='loaded')loaded=row;
 else {digest.update(JSON.stringify(canonical(row.reply)));rows.push({ms:row.ms,stats:row.stats,metrics:row.metrics,returned:row.reply.result?.nodes?.length,error:row.reply.error});}
},{binary:config.binary,onScratch:s=>prefix=s,onPid:helperPid=>console.log(JSON.stringify({helperPid})),onMetrics:m=>nativeMetrics=m,timeoutMs:120000});
const use=process.cpuUsage(cpu),cpuMs=(use.user+use.system)/1000+(nativeMetrics?.cpuMs??0);
console.log(JSON.stringify({loaded,rows,digest:digest.digest('hex'),wallMs:performance.now()-start,cpuMs,hostMaxRssBytes:process.resourceUsage().maxRSS*1024,nativeMetrics,releasedRssBytes:process.memoryUsage().rss}));
