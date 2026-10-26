import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { installDownloadCapture, readDownloadCapture } from '../extension/download.js';

for (const zipped of [false, true]) test(`native export captures ${zipped ? 'ZIP' : 'SVG'}, restores click and disposes results`, async () => {
  let clicks = 0, fetched = 0;
  class Anchor { click() { clicks++; } }
  const original = Anchor.prototype.click;
  const listeners = new Map();
  const context = vm.createContext({ location: { origin: 'https://www.figma.com', pathname: '/design/file/Test' },
    HTMLAnchorElement: Anchor, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    setTimeout, clearTimeout, Uint8Array, TextDecoder, AbortController, DataView, Blob, DecompressionStream,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: async url => { fetched++; assert.equal(url, 'blob:https://www.figma.com/export'); return new Response(zipped ? zipSvg() : '<svg xmlns="http://www.w3.org/2000/svg"/>'); } });
  const install = vm.runInContext(`(${installDownloadCapture.toString()})`, context);
  const read = vm.runInContext(`(${readDownloadCapture.toString()})`, context);
  install('request', 'file');
  try {
    const ordinary = Object.assign(new Anchor(), { href: 'https://example.com/file.svg', download: 'file.svg' });
    ordinary.click(); assert.equal(clicks, 1); assert.equal(fetched, 0);
    const png = Object.assign(new Anchor(), { href: 'blob:https://www.figma.com/png', download: 'file.png' });
    png.click(); assert.equal(clicks, 2); assert.equal(fetched, 0);
    const svg = Object.assign(new Anchor(), { href: 'blob:https://www.figma.com/export', download: zipped ? 'file.zip' : 'Vector.svg' });
    svg.click(); assert.equal(clicks, 2); assert.equal(fetched, 1);
    assert.equal(Anchor.prototype.click, original);
    assert.match(read('other', 'file').error, /expired/);
    for (let i = 0; i < 100 && !context.__turboFigmaNativeDownload?.result && !context.__turboFigmaNativeDownload?.error; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const result = read('request', 'file');
    assert.match(Buffer.from(result.data, 'base64').toString(), /<svg/);
    assert.equal(listeners.size, 0);
    assert.match(read('request', 'file').error, /expired/);
  } finally { read('request', 'file', true); }
});

function zipSvg() {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const data = deflateRawSync(svg), name = Buffer.from('16/Vector.svg');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(svg.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

for(const bad of [false,true]) test(`PNG native capture validates and scales without clipboard (invalid=${bad})`,async()=>{
 class Anchor {click(){throw Error('Unexpected download');}}
 const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
 bytes.writeUInt32BE(bad?20000:4000,16);bytes.writeUInt32BE(1000,20);
 let decoded=0,closed=0;const canvas={getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/png;base64,cG5n'};
 const context=vm.createContext({location:{origin:'https://www.figma.com',pathname:'/design/file/Test'},HTMLAnchorElement:Anchor,
 window:{addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout,Uint8Array,TextDecoder,AbortController,DataView,Blob,DecompressionStream,
 fetch:async()=>new Response(bytes),document:{createElement:()=>canvas},createImageBitmap:async()=>{decoded++;return {close:()=>closed++};}});
 const install=vm.runInContext(`(${installDownloadCapture.toString()})`,context),read=vm.runInContext(`(${readDownloadCapture.toString()})`,context);
 install('request','file','PNG',1);
 try{
  Object.assign(new Anchor(),{href:'blob:https://www.figma.com/export',download:'Banner.png'}).click();
  for(let i=0;i<100&&!context.__turboFigmaNativeDownload?.result&&!context.__turboFigmaNativeDownload?.error;i++)await new Promise(r=>setTimeout(r,5));
  const result=read('request','file');
  if(bad){assert.match(result.error,/16 megapixels/);assert.equal(decoded,0);}
  else{assert.equal(result.data,'cG5n');assert.equal(result.scale,0.512);assert.equal(result.scaleBasis,'native-export');assert.equal(canvas.width,2048);assert.equal(canvas.height,512);assert.equal(closed,1);}
 }finally{read('request','file',true);}
});
