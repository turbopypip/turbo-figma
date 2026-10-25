import type { GeometryContext } from './network-geometry.js';
type WireNode = Record<string, any>;
export const layoutFields = ['size', 'transform', 'opacity', 'stackMode', 'stackSpacing', 'stackHorizontalPadding',
  'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom', 'stackPrimarySizing', 'stackCounterSizing',
  'stackChildPrimaryGrow', 'stackChildAlignSelf', 'stackPrimaryAlignItems', 'stackCounterAlignItems', 'stackPositioning', 'stackWrap', 'stackCounterSpacing', 'stackCounterAlignContent',
  'minSize', 'maxSize', 'horizontalConstraint', 'verticalConstraint', 'textAutoResize'] as const;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const direction = (v: unknown) => v === 'HORIZONTAL' ? 'row' : v === 'VERTICAL' ? 'column' : undefined;

export const VERIFIED_LAYOUT_SCHEMA = '6518ae0a292d152a65a2a9d82ef27d8fb1f158b28c240d7aec5eb75ea93df288';

/** Conservative projection of observed wire fields. Only schema-scoped, observed frame sizing defaults are restored. */
export function networkLayout(node: WireNode, parent?: WireNode, schemaHash?: string, geometry?: GeometryContext) {
  const source: WireNode = {}, css: Record<string, string> = {}, unavailable: string[] = [];
  for (const key of layoutFields) if (node[key] !== undefined) source[key] = node[key];
  const size = node.size && finite(node.size.x) && finite(node.size.y) && node.size.x >= 0 && node.size.y >= 0
    ? { width: node.size.x, height: node.size.y } : null;
  if (!size) unavailable.push('geometry.size');
  const t = node.transform;
  const transform = t && ['m00','m01','m02','m10','m11','m12'].every(k => finite(t[k]))
    ? { a: t.m00, b: t.m10, c: t.m01, d: t.m11, tx: t.m02, ty: t.m12 } : null;
  if (!transform) unavailable.push('geometry.localTransform');
  let parentBounds = null;
  if (size && transform) {
    const { a,b,c,d,tx,ty } = transform;
    const points = [[0,0],[size.width,0],[0,size.height],[size.width,size.height]].map(([x,y]) => [a*x+c*y+tx,b*x+d*y+ty]);
    const xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs)-Math.min(...xs), height: Math.max(...ys)-Math.min(...ys) };
    if (Object.values(bounds).every(finite)) parentBounds = bounds;
  }
  if (!parentBounds) unavailable.push('geometry.parentBounds');
  const flow = direction(node.stackMode);
  const autoLayout: WireNode = { direction: flow ?? (node.stackMode === 'NONE' ? 'none' : null), gap: null,
    padding: { top: null, right: null, bottom: null, left: null }, primaryAlignment: null, counterAlignment: null };
  if (!autoLayout.direction) unavailable.push('autoLayout.direction');
  if (flow) {
    css.display = 'flex'; css['flex-direction'] = flow;
    if (finite(node.stackSpacing) && node.stackSpacing >= 0) { autoLayout.gap = node.stackSpacing; css.gap = `${node.stackSpacing}px`; }
    else unavailable.push('autoLayout.gap');
    for (const [side, field] of Object.entries({ top: 'stackVerticalPadding', right: 'stackPaddingRight', bottom: 'stackPaddingBottom', left: 'stackHorizontalPadding' })) {
      if (finite(node[field]) && node[field] >= 0) { autoLayout.padding[side] = node[field]; css[`padding-${side}`] = `${node[field]}px`; }
      else unavailable.push(`autoLayout.padding.${side}`);
    }
    // SPACE_EVENLY in this wire schema is observed as space-between in Figma's inspector.
    const primary: Record<string,string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_EVENLY: 'space-between' };
    const counter: Record<string,string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
    autoLayout.primaryAlignment = Object.hasOwn(primary, node.stackPrimaryAlignItems) ? primary[node.stackPrimaryAlignItems] : null;
    autoLayout.counterAlignment = Object.hasOwn(counter, node.stackCounterAlignItems) ? counter[node.stackCounterAlignItems] : null;
    if (autoLayout.primaryAlignment === 'space-between') {
      autoLayout.gap = null; delete css.gap; unavailable.push('autoLayout.effectiveDistributedGap');
    }
    if (autoLayout.primaryAlignment) css['justify-content'] = autoLayout.primaryAlignment;
    else unavailable.push('autoLayout.primaryAlignment');
    if (autoLayout.counterAlignment) css['align-items'] = autoLayout.counterAlignment;
    else unavailable.push('autoLayout.counterAlignment');
  }
  // No inference from a measured width/height alone: Fill depends on the parent's axis.
  const sizing: WireNode = {};
  const parentFlow = direction(parent?.stackMode);
  for (const axis of ['width','height'] as const) {
    const main = flow && (flow === 'row' ? axis === 'width' : axis === 'height');
    const ownField = flow ? (main ? 'stackPrimarySizing' : 'stackCounterSizing') : undefined;
    let ownRule = ownField ? node[ownField] : undefined;
    // Observed defaults only for ordinary frames in the verified schema. Never inherit
    // these into instances: their missing fields may belong to a component master.
    const verifiedDefault = ownRule === undefined && !!flow && (node.type === 'FRAME' || node.layoutInheritance?.componentId) && schemaHash === VERIFIED_LAYOUT_SCHEMA;
    if (verifiedDefault) ownRule = main ? 'RESIZE_TO_FIT' : 'FIXED';
    const parentMain = parentFlow && (parentFlow === 'row' ? axis === 'width' : axis === 'height');
    let mode: string | null = null, evidence: string[] = [];
    if (parentFlow && (node.stackPositioning === undefined || node.stackPositioning === 'AUTO') && (parentMain ? finite(node.stackChildPrimaryGrow) && node.stackChildPrimaryGrow > 0 : node.stackChildAlignSelf === 'STRETCH')) {
      mode = 'fill'; evidence = ['parent.stackMode', parentMain ? 'stackChildPrimaryGrow' : 'stackChildAlignSelf'];
    } else if (ownRule === 'FIXED') { mode = 'fixed'; evidence = [ownField!]; }
    else if (ownRule === 'RESIZE_TO_FIT' || ownRule === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE') { mode = 'hug'; evidence = [ownField!]; }
    if (verifiedDefault && evidence.includes(ownField!)) evidence.push('verified-frame-default:' + VERIFIED_LAYOUT_SCHEMA);
    if (!mode && node.type === 'TEXT' && ['WIDTH_AND_HEIGHT','HEIGHT','NONE','TRUNCATE'].includes(node.textAutoResize)) {
      mode = node.textAutoResize === 'WIDTH_AND_HEIGHT' || (node.textAutoResize === 'HEIGHT' && axis === 'height') ? 'hug' : 'fixed';
      evidence = ['textAutoResize'];
    }
    if (!mode && !flow && ['RECTANGLE','ROUNDED_RECTANGLE','ELLIPSE','LINE','VECTOR','BOOLEAN_OPERATION'].includes(node.type)) { mode='fixed'; evidence=['non-layout-shape']; }
    sizing[axis] = { mode, measured: size?.[axis] ?? null, evidence };
    if (!mode) unavailable.push(`sizing.${axis}`);
    if (mode === 'fixed' && size) css[axis] = `${size[axis]}px`;
    // Fill/Hug are kept as semantic hints, not guessed CSS percentages or flex shorthand.
  }
  if (flow && (node.stackWrap === 'WRAP' || node.stackWrap === 'NO_WRAP')) {
    autoLayout.wrap = node.stackWrap === 'WRAP' ? 'wrap' : 'nowrap';
    css['flex-wrap'] = autoLayout.wrap;
    if (node.stackWrap === 'WRAP') {
      // Main-axis spacing and between-line spacing are distinct in wrapped layouts.
      delete css.gap;
      const mainGap = flow === 'row' ? 'column-gap' : 'row-gap';
      const crossGap = flow === 'row' ? 'row-gap' : 'column-gap';
      if (finite(node.stackSpacing) && node.stackSpacing >= 0 && autoLayout.primaryAlignment !== 'space-between') css[mainGap] = `${node.stackSpacing}px`;
      if (finite(node.stackCounterSpacing) && node.stackCounterSpacing >= 0) css[crossGap] = `${node.stackCounterSpacing}px`;
      else unavailable.push('autoLayout.counterGap');
      if (node.stackCounterAlignContent === 'SPACE_BETWEEN') { css['align-content'] = 'space-between'; delete css[crossGap]; }
    }
  } else unavailable.push('autoLayout.wrap');
  if (finite(node.stackSpacing) && node.stackSpacing < 0) unavailable.push('autoLayout.negativeSpacingRequiresOverlap');
  for (const [field, prefix] of [['minSize','min'],['maxSize','max']]) {
    const value = node[field]?.value;
    for (const [component, axis] of [['x','width'],['y','height']]) {
      if (finite(value?.[component]) && value[component] >= 0) css[`${prefix}-${axis}`] = `${value[component]}px`;
    }
  }
  const constraints = { horizontal: node.horizontalConstraint ?? null, vertical: node.verticalConstraint ?? null };
  if (node.stackMode === 'GRID') unavailable.push('autoLayout.gridTracks');
  if (!geometry?.canvas) unavailable.push('geometry.absolutePosition');
  const inspectorTransform = geometry?.frame ?? transform;
  const angle = inspectorTransform && (inspectorTransform.a !== 0 || inspectorTransform.b !== 0)
    ? (-Math.atan2(inspectorTransform.b, inspectorTransform.a) * 180 / Math.PI + 540) % 360 - 180 : null;
  const cssText = Object.entries(css).map(([key, value]) => `${key}: ${value};`).join('\n');
  let frameBounds = null;
  if (geometry?.frame && size) {
    const t=geometry.frame;
    const points=[[0,0],[size.width,0],[0,size.height],[size.width,size.height]].map(([x,y])=>[t.a*x+t.c*y+t.tx,t.b*x+t.d*y+t.ty]);
    frameBounds={x:Math.min(...points.map(p=>p[0])),y:Math.min(...points.map(p=>p[1]))};
    if (!Object.values(frameBounds).every(finite)) frameBounds=null;
  }
  const inspector = { ...(frameBounds ? {Top:`${frameBounds.y}px`,Left:`${frameBounds.x}px`} : {}), ...(angle !== null ? {Rotation:`${angle}°`} : {}) };
  const measuredCss = size ? {width:`${size.width}px`,height:`${size.height}px`} : {};
  return { cssText, measuredCss, inspector, source, geometry: { size, localTransform: transform, absoluteTransform:geometry?.canvas??null, absolutePosition:geometry?.canvas?{x:geometry.canvas.tx,y:geometry.canvas.ty,space:'canvas'}:null, framePosition:geometry?.frame?{x:geometry.frame.tx,y:geometry.frame.ty,frameId:geometry.frameId}:null, position: transform ? { x: transform.tx, y: transform.ty, space: 'parent' } : null,
    parentBounds: parentBounds ? { ...parentBounds, provenance: 'computed-from-size-and-transform' } : null },
    autoLayout, sizing, constraints, parentDirection: parentFlow ?? null, css, unavailable, complete: false,
    provenance: 'captured-wire; computed bounds and sizing are identified separately; schema-scoped sizing defaults carry evidence' };
}
