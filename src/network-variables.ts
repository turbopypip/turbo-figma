import { mapContextVariables } from './variables.js';

type Value = Record<string, any>;
const fields:Record<string,string>={CORNER_RADIUS:'cornerRadius',STROKE_WEIGHT:'strokeWeight',STACK_SPACING:'stackSpacing',STACK_COUNTER_SPACING:'stackCounterSpacing',
  STACK_PADDING_LEFT:'stackHorizontalPadding',STACK_PADDING_TOP:'stackVerticalPadding',STACK_PADDING_RIGHT:'stackPaddingRight',STACK_PADDING_BOTTOM:'stackPaddingBottom',
  VISIBLE:'visible',OPACITY:'opacity',FONT_SIZE:'fontSize',PARAGRAPH_SPACING:'paragraphSpacing',PARAGRAPH_INDENT:'paragraphIndent',
  RECTANGLE_TOP_LEFT_CORNER_RADIUS:'rectangleTopLeftCornerRadius',RECTANGLE_TOP_RIGHT_CORNER_RADIUS:'rectangleTopRightCornerRadius',
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS:'rectangleBottomLeftCornerRadius',RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS:'rectangleBottomRightCornerRadius',
  BORDER_TOP_WEIGHT:'borderTopWeight',BORDER_BOTTOM_WEIGHT:'borderBottomWeight',BORDER_LEFT_WEIGHT:'borderLeftWeight',BORDER_RIGHT_WEIGHT:'borderRightWeight'};
const capturedField=(node:Value,field:string)=>{
  if(fields[field])return node[fields[field]];
  if(field==='WIDTH'||field==='HEIGHT')return node.size?.[field==='WIDTH'?'x':'y'];
  if(['MIN_WIDTH','MIN_HEIGHT','MAX_WIDTH','MAX_HEIGHT'].includes(field))return node[field.startsWith('MIN_')?'minSize':'maxSize']?.value?.[field.endsWith('WIDTH')?'x':'y'];
  if(field==='FONT_STYLE')return node.fontName?.style;
  if(field==='FONT_FAMILY')return node.fontName?.family;
  if(field==='TEXT_DATA')return typeof node.textData==='string'?node.textData:node.textData?.characters;
  if(field==='LINE_HEIGHT'||field==='LETTER_SPACING') {const value=node[field==='LINE_HEIGHT'?'lineHeight':'letterSpacing'];return value?.units==='PIXELS'?value.value:undefined;}
};
const sameValue=(a:any,b:any):boolean=>{
  if(typeof a==='number'&&typeof b==='number')return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-6;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&['r','g','b','a'].every(k=>k in a&&k in b))return ['r','g','b','a'].every(k=>sameValue(a[k],b[k]));
  return a===b;
};
/** Captured references only. Never resolve a GUID using an unrelated UI-kit value. */
export function nativeVariableBindings(node: Value, resolveVariable?: (data:Value)=>Value) {
  const references: Value[] = [], unresolved: string[] = [];
  let bytes=0;
  const add = (path: string, data: Value, captured?:unknown) => {
    if(bytes>100000)return;
    if (references.length >= 128) { if (!unresolved.includes('referenceLimit')) unresolved.push('referenceLimit'); return; }
    const guid = data?.value?.alias?.guid;
    const id = guid && [guid.sessionID,guid.localID].every(v=>Number.isSafeInteger(v)&&v>=0) ? `${guid.sessionID}:${guid.localID}` : undefined;
    let resolution=resolveVariable?.(data);
    if(resolution?.status==='resolved') {
      resolution={...resolution,definitionStatus:'resolved',capturedValueCheck:captured===undefined?'unavailable':sameValue(captured,resolution.value)?'matched':'conflict'};
      if(captured!==undefined&&!sameValue(captured,resolution.value)) {
        resolution={...resolution,capturedValueCheck:'different-fallback',capturedValue:captured};
      }
    }
    const reference={path,dataType:data?.dataType??'unknown',...(id?{variableId:id}:{}),
      ...(resolution??{status:'unresolved',reason:id?'Variable definition and active mode are not resolved.':'Unsupported or external variable reference.'})};
    bytes+=Buffer.byteLength(JSON.stringify(reference));
    if(bytes>100000){if(!unresolved.includes('referenceByteLimit'))unresolved.push('referenceByteLimit');return;}
    references.push(reference);
  };
  const scan = (value: Value, prefix: string) => {
    const entries = value.variableConsumptionMap?.entries;
    if (Array.isArray(entries)) {
      if (entries.length>128) unresolved.push(`${prefix}consumptionLimit`);
      for (const e of entries.slice(0,128)) add(`${prefix}${e.variableField ?? `nodeField:${e.nodeField ?? 'unknown'}`}`,e.variableData,capturedField(value,e.variableField));
    }
    for (const field of ['fillPaints','strokePaints','effects']) {
      const items=value[field]; if (!Array.isArray(items)) continue;
      if(items.length>128)unresolved.push(`${prefix}${field}.limit`);
      items.slice(0,128).forEach((p:Value,i:number)=>{
        for(const [key,data] of Object.entries(p)) if(key.endsWith('Var')&&key!=='stopsVar') add(`${prefix}${field}[${i}].${key}`,data as Value,p[key.slice(0,-3)]);
        for(const stopField of ['stops','stopsVar']) if(Array.isArray(p[stopField])) {
          if(p[stopField].length>128)unresolved.push(`${prefix}${field}[${i}].${stopField}.limit`);
          p[stopField].slice(0,128).forEach((stop:Value,j:number)=>{if(stop.colorVar)add(`${prefix}${field}[${i}].${stopField}[${j}].colorVar`,stop.colorVar,stop.color);});
        }
      });
    }
  };
  scan(node,'');
  const table=node.textData?.styleOverrideTable;
  if(Array.isArray(table)) {
    if(table.length>128)unresolved.push('textStyleLimit');
    for(const style of table.slice(0,128)) scan(style,`textStyle[${style.styleID}].`);
  }
  return {source:'figma-wire',references,unresolved,complete:false,
    note:'Captured definitions, mode values and alias chains are independent of UI-kit matching. Unknown active modes and unavailable definitions stay explicit. Missing references do not prove absence of bindings.'};
}

/** Project bindings onto a copy before layout, visibility, typography and UI-kit matching. */
export function effectiveVariableNode(node: Value, bindings: ReturnType<typeof nativeVariableBindings>): Value {
  const refs=new Map(bindings.references.map(r=>[r.path,r]));
  const project=(raw:Value,prefix=''):Value=>{
    const out={...raw};
    const assign=(path:string[],ref:Value|undefined,type:string)=>{
      let target=out;
      for(const key of path.slice(0,-1)) target=target[key]={...(target[key]??{})};
      const key=path.at(-1)!;
      // Null intentionally masks inherited text values in mixed-style projection.
      target[key]=ref?.status==='resolved'&&ref.dataType===type?ref.value:null;
      if(ref?.status==='resolved'&&ref.dataType!==type) {
        ref.status='unresolved';ref.reason='Variable type does not match consuming property';
      }
    };
    for(const entry of raw.variableConsumptionMap?.entries??[]) {
      const field=entry.variableField, ref=refs.get(`${prefix}${field??`nodeField:${entry.nodeField??'unknown'}`}`);
      let path:string[]|undefined, type='FLOAT';
      if(fields[field]) {path=[fields[field]];if(field==='VISIBLE')type='BOOLEAN';}
      else if(['WIDTH','HEIGHT','MIN_WIDTH','MIN_HEIGHT','MAX_WIDTH','MAX_HEIGHT'].includes(field))
        path=field.includes('_')?[field.startsWith('MIN_')?'minSize':'maxSize','value',field.endsWith('WIDTH')?'x':'y']:['size',field==='WIDTH'?'x':'y'];
      else if(field==='FONT_FAMILY'||field==='FONT_STYLE') {path=['fontName',field==='FONT_FAMILY'?'family':'style'];type='STRING';}
      else if(field==='TEXT_DATA') {path=typeof raw.textData==='string'?['textData']:['textData','characters'];type='STRING';}
      else if(field==='LINE_HEIGHT'||field==='LETTER_SPACING') {
        const key=field==='LINE_HEIGHT'?'lineHeight':'letterSpacing';
        if(raw[key]?.units==='PIXELS')path=[key,'value'];
        else {out[key]=null;if(ref){ref.status='unresolved';ref.reason='Bound text metric units are not established as pixels';}continue;}
      }
      if(path)assign(path,ref,type);
      else if(ref) {ref.status='unresolved';ref.reason='Unsupported variable consuming field';}
    }
    for(const field of ['fillPaints','strokePaints','effects']) if(Array.isArray(raw[field]))out[field]=raw[field].map((item:Value,i:number)=>{
      const value={...item};
      for(const key of Object.keys(item)) if(key.endsWith('Var')&&key!=='stopsVar') {
        const ref=refs.get(`${prefix}${field}[${i}].${key}`), target=key.slice(0,-3);
        const type=target==='color'?'COLOR':target==='visible'?'BOOLEAN':'FLOAT';
        value[target]=ref?.status==='resolved'&&ref.dataType===type?ref.value:undefined;
      }
      for(const key of ['stops','stopsVar']) if(Array.isArray(item[key]))value[key]=item[key].map((stop:Value,j:number)=>{
        if(!stop.colorVar)return stop;
        const ref=refs.get(`${prefix}${field}[${i}].${key}[${j}].colorVar`);
        return {...stop,color:ref?.status==='resolved'&&ref.dataType==='COLOR'?ref.value:undefined};
      });
      return value;
    });
    return out;
  };
  const result=project(node);
  if(Array.isArray(node.textData?.styleOverrideTable))result.textData={...result.textData,
    styleOverrideTable:node.textData.styleOverrideTable.map((s:Value)=>project(s,`textStyle[${s.styleID}].`))};
  return result;
}

/** Map only proven CSS; raw design values and native references stay intact. */
export function mapNetworkNodeVariables(node: Value, variables: Map<string,string>) {
  let bytes=0;
  const map = (layout: Value) => {
    const mapped=(mapContextVariables({layout},variables,undefined,{maxCandidates:32}) as Value).layout;
    bytes+=Buffer.byteLength(JSON.stringify(mapped));
    if(bytes>100000) throw new Error('Variable mapping byte limit');
    return mapped;
  };
  try {
    const result={...node};
    if(node.layout) result.layout=map(node.layout);
    if(node.style) {
      result.style=map(node.style);
      if(node.style.text) result.style.text={...node.style.text,
        base:map(node.style.text.base),ranges:node.style.text.ranges.map((r:Value)=>map(r))};
    }
    return result;
  } catch(error) {
    if (!(error instanceof Error) || error.message !== 'Variable mapping byte limit') throw error;
    return {id:node.id,parentId:node.parentId,depth:node.depth,type:node.type,propertiesOmitted:'Node properties including variable matches exceed normalization byte limit'};
  }
}
