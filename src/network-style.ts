/** Conservative visual projection. No asset downloads, variable resolution or font-name heuristics. */
type Value = Record<string, any>;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const unit = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
const number = (v: number) => String(Math.abs(v) < 1e15 ? Math.round(v * 1e6) / 1e6 : v);
const pick = (v: Value, keys: readonly string[]) => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k,v[k]]));
export const styleFields = ['styleID','effects','blendMode','rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius',
  'rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius','rectangleCornerRadiiIndependent','cornerSmoothing',
  'borderStrokeWeightsIndependent','borderTopWeight','borderRightWeight','borderBottomWeight','borderLeftWeight',
  'dashPattern','strokeCap','strokeJoin','textCase','textDecoration','fontVariations','fontVariantSlashedZero',
  'paragraphSpacing','paragraphIndent','derivedTextData'] as const;
/** Applied by both decoders: typography needs metadata, not glyph paths or font digests. */
export function keepStyleField(type: string, field: string): boolean {
  if (type === 'DerivedTextData') return field === 'fontMetaData';
  if (type === 'TextData') return ['characters','characterStyleIDs','styleOverrideTable','fontMetaData','lines'].includes(field);
  if (type === 'FontMetaData') return ['key','fontWeight','fontStyle'].includes(field);
  return true;
}
const textFields = ['fontName','fontSize','lineHeight','letterSpacing','textAlignHorizontal','textAlignVertical',
  'textCase','textDecoration','fontVariations','fontVariantSlashedZero','paragraphSpacing','paragraphIndent','fillPaints'] as const;
const rgba = (c: Value, opacity = 1) => c && ['r','g','b','a'].every(k=>unit(c[k])) && unit(opacity)
  ? `rgba(${number(c.r*255)}, ${number(c.g*255)}, ${number(c.b*255)}, ${number(c.a*opacity)})` : undefined;
const cssString = (s: string) => '"' + s.replace(/["\\\n\r\f\0]/g,c=>'\\'+c.charCodeAt(0).toString(16)+' ') + '"';
function paints(values: unknown, path: string, unresolved: string[]): Value[] | null {
  if (!Array.isArray(values)) return null;
  if (values.length > 128) { unresolved.push(`${path}.limit`); return null; }
  return values.map((p,i) => {
    const out: Value = pick(p,['type','visible','opacity','blendMode']);
    if (p.color) out.color = pick(p.color,['r','g','b','a']);
    if (p.stops?.length > 128) unresolved.push(`${path}[${i}].stopsLimit`);
    else if (p.stops) out.stops = p.stops.map((s:Value)=>({position:s.position,color:pick(s.color??{},['r','g','b','a'])}));
    if (p.transform) out.transform = pick(p.transform,['m00','m01','m02','m10','m11','m12']);
    const color = p.type === 'SOLID' && p.blendMode === 'NORMAL' && unit(p.opacity) ? rgba(p.color,p.opacity) : undefined;
    if (color) out.cssColor = color;
    if (p.visible !== false && (!color || p.visible !== true)) unresolved.push(`${path}[${i}].css`);
    if (Object.keys(p).some(k=>k.endsWith('Var'))) out.variableBindingUnresolved = true;
    return out;
  });
}
function singleColor(p: Value[] | null) {
  const active = p?.filter(p=>p.visible !== false);
  return active?.length === 1 && active[0].visible === true ? active[0].cssColor as string | undefined : undefined;
}
function typography(n: Value, metadata: Value[], unresolved: string[]) {
  const source = pick(n,textFields.filter(k=>k!=='fillPaints' && k!=='fontVariations')), css: Record<string,string> = {};
  const font = n.fontName;
  if (typeof font?.family === 'string') css['font-family'] = cssString(font.family);
  else unresolved.push('font.family');
  const matches = metadata.filter(m=>m.key?.family === font?.family && m.key?.style === font?.style);
  const meta = matches.length && matches.every(m=>m.fontWeight === matches[0].fontWeight && m.fontStyle === matches[0].fontStyle) ? matches[0] : undefined;
  if (Number.isInteger(meta?.fontWeight) && meta!.fontWeight >= 1 && meta!.fontWeight <= 1000) css['font-weight'] = String(meta!.fontWeight);
  else unresolved.push('font.weight');
  if (meta?.fontStyle === 'NORMAL' || meta?.fontStyle === 'ITALIC') css['font-style'] = meta.fontStyle === 'ITALIC' ? 'italic' : 'normal';
  else unresolved.push('font.style');
  if (nonnegative(n.fontSize)) css['font-size'] = `${number(n.fontSize)}px`; else unresolved.push('font.size');
  for (const [key,field] of [['line-height','lineHeight'],['letter-spacing','letterSpacing']]) {
    const v=n[field];
    if (finite(v?.value) && (field !== 'lineHeight' || v.value >= 0) && ['PIXELS','PERCENT'].includes(v.units)) css[key]=v.units==='PIXELS'?`${number(v.value)}px`:field==='letterSpacing'?`${number(v.value/100)}em`:`${number(v.value)}%`;
    else unresolved.push(field);
  }
  for (const [field,key,values] of [
    ['textAlignHorizontal','text-align',{LEFT:'left',CENTER:'center',RIGHT:'right',JUSTIFIED:'justify'}],
    ['textCase','text-transform',{ORIGINAL:'none',UPPER:'uppercase',LOWER:'lowercase',TITLE:'capitalize'}],
    ['textDecoration','text-decoration-line',{NONE:'none',UNDERLINE:'underline',STRIKETHROUGH:'line-through'}],
  ] as const) if (n[field] !== undefined) {
    if (Object.hasOwn(values,n[field])) css[key]=(values as Record<string,string>)[n[field]];
    else unresolved.push(field);
  }
  if (n.fontVariantSlashedZero === true) css['font-variant-numeric']='slashed-zero';
  if (n.fontVariations?.length) unresolved.push('font.variations');
  if (n.paragraphSpacing || n.paragraphIndent) unresolved.push('paragraph.layout');
  const fills=paints(n.fillPaints,'fills',unresolved), color=singleColor(fills);
  if (color) css.color=color;
  else if (fills?.some(p=>p.visible!==false)) unresolved.push('fills.composition');
  return {source,css,fills};
}
function textStyle(n: Value) {
  const unresolved: string[] = [], data=n.textData;
  const characters=typeof data==='string'?data:data?.characters;
  const rawMetadata=n.derivedTextData?.fontMetaData ?? data?.fontMetaData ?? [];
  const metadata=rawMetadata.length<=256?rawMetadata:[];
  if(rawMetadata.length>256)unresolved.push('font.metadataLimit');
  if(data?.lines?.some((line:Value)=>line.lineType!=='PLAIN'||line.indentationLevel>0))unresolved.push('paragraph.listLayout');
  const base=typography(n,metadata,unresolved);
  const result: Value = {base,ranges:[],rangeUnit:'utf-16',unresolved};
  if (typeof characters !== 'string') {unresolved.push('text.characters');return result;}
  const ids=data?.characterStyleIDs;
  const table=new Map<number,Value>();
  if (data?.styleOverrideTable?.length>1024) {unresolved.push('text.styleTableLimit');return result;}
  for (const entry of data?.styleOverrideTable ?? []) {
    if (!Number.isSafeInteger(entry.styleID) || entry.styleID <= 0 || table.has(entry.styleID)) {unresolved.push('text.invalidStyleTable');return result;}
    table.set(entry.styleID,entry);
  }
  if (ids !== undefined && (!Array.isArray(ids) || ids.length !== characters.length || ids.some(v=>!Number.isSafeInteger(v)||v<0||(v!==0&&!table.has(v))))) {
    unresolved.push('text.invalidStyleIndices');return result;
  }
  const normalized=new Map<number,Value>();
  let start=0, rangeBytes=0;
  while (start<characters.length) {
    const id=ids?.[start]??0;let end=start+1;
    while(end<characters.length&&(ids?.[end]??0)===id) end++;
    // A style boundary within a surrogate pair is invalid, not a partial glyph.
    if (end<characters.length && /[\uD800-\uDBFF]/.test(characters[end-1]) && /[\uDC00-\uDFFF]/.test(characters[end])) {result.ranges=[];unresolved.push('text.splitSurrogate');return result;}
    if (result.ranges.length>=1024) {result.ranges=[];unresolved.push('text.rangeLimit');return result;}
    if(!normalized.has(id)) {
      const issues: string[]=[];
      const style=id===0?base:typography({...n,...pick(table.get(id)!,textFields)},metadata,issues);
      normalized.set(id,{...style,unresolved:id===0?[...unresolved]:issues});
    }
    rangeBytes += Buffer.byteLength(JSON.stringify(normalized.get(id))) + 64;
    if(rangeBytes>100000) {result.ranges=[];unresolved.push('text.rangeByteLimit');return result;}
    result.ranges.push({start,end,styleId:id,...normalized.get(id)});start=end;
  }
  result.mixed=new Set((result.ranges as Value[]).map(r=>r.styleId)).size>1;
  return result;
}
export function networkStyle(n: Value) {
  const css: Record<string,string>={}, unresolved: string[]=[];
  const fills=paints(n.fillPaints,'fills',unresolved), strokes=paints(n.strokePaints,'strokes',unresolved);
  const source: Value=pick(n,['opacity','blendMode','cornerRadius','cornerSmoothing','rectangleCornerRadiiIndependent',
    'rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius',
    'strokeWeight','strokeAlign','strokeCap','strokeJoin','dashPattern','borderStrokeWeightsIndependent','borderTopWeight','borderRightWeight','borderBottomWeight','borderLeftWeight']);
  if (unit(n.opacity)) css.opacity=number(n.opacity); else unresolved.push('opacity');
  if (n.blendMode && !['NORMAL','PASS_THROUGH'].includes(n.blendMode)) unresolved.push('blendMode');
  const color=singleColor(fills);
  if(n.type!=='TEXT' && color && ['FRAME','SYMBOL','INSTANCE','RECTANGLE','ROUNDED_RECTANGLE'].includes(n.type)) css['background-color']=color;
  else if(n.type!=='TEXT'&&fills?.some(p=>p.visible!==false)) unresolved.push('fills.composition');
  const corners=['rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomRightCornerRadius','rectangleBottomLeftCornerRadius'];
  if (!['FRAME','SYMBOL','INSTANCE','RECTANGLE','ROUNDED_RECTANGLE'].includes(n.type)) {
    if(n.cornerRadius!==undefined||n.rectangleCornerRadiiIndependent)unresolved.push('corners.geometry');
  } else if (n.cornerSmoothing) unresolved.push('corners.smoothing');
  else if(n.rectangleCornerRadiiIndependent===true) {
    if(corners.every(k=>nonnegative(n[k]))) css['border-radius']=corners.map(k=>`${number(n[k])}px`).join(' ');
    else unresolved.push('corners.values');
  } else if(nonnegative(n.cornerRadius)) css['border-radius']=`${number(n.cornerRadius)}px`;
  if(strokes?.some(p=>p.visible!==false)) unresolved.push('strokes.geometry'); // Figma inside/center/outside is not CSS border geometry.
  if(n.effects?.length>128)unresolved.push('effects.limit');
  const effects=Array.isArray(n.effects)&&n.effects.length<=128?n.effects.map((e:Value,i:number)=>{
    const value=pick(e,['type','visible','blendMode','radius','spread','showShadowBehindNode','blurOpType']);
    if(e.color)value.color=pick(e.color,['r','g','b','a']);
    if(e.offset)value.offset=pick(e.offset,['x','y']);
    // Preserve verified design parameters; shadow/blur raster semantics need separate parity before CSS mapping.
    if(e.visible!==false)unresolved.push(`effects[${i}].css`);
    return value;
  }):null;
  const text=n.type==='TEXT'?textStyle(n):undefined;
  if(text) {
    // Only uniform properties can be promoted to node CSS. Mixed runs keep their own CSS.
    const ranges=text.ranges as Value[];
    if(ranges.length)for(const [key,value]of Object.entries(ranges[0].css)) if(ranges.every(r=>r.css[key]===value))css[key]=value as string;
    unresolved.push(...text.unresolved.map((s:string)=>'text.'+s));
  }
  return {css,source,fills,strokes,effects,...(text?{text}:{}),unresolved:[...new Set(unresolved)],complete:false,
    provenance:'captured-wire; numeric colors retain float precision; variables and unsupported CSS compositions remain unresolved'};
}
