/** Public design context. Wire records stay in the decoder/index, never in this allowlist. */
type Value = Record<string, any>;
const cssLabels: Record<string,string> = {
  gap:'Gap','row-gap':'Vertical gap','column-gap':'Horizontal gap',
  'padding-top':'Padding—Top','padding-right':'Padding—Right','padding-bottom':'Padding—Bottom','padding-left':'Padding—Left',
  'min-width':'Min width','max-width':'Max width','min-height':'Min height','max-height':'Max height',
  'justify-content':'Justify','align-items':'Align',
};
export function designContextNode(node: Value): Value {
  const result: Value = {id:node.id,parentId:node.parentId,depth:node.depth,name:node.name,type:node.type};
  if (typeof node.visible === 'boolean') result.hidden = !node.visible;
  if (typeof node.opacity === 'number' && Number.isFinite(node.opacity)) result.opacity = node.opacity;
  const text = typeof node.textData === 'string' ? node.textData : node.textData?.characters;
  if (typeof text === 'string') result.text = text;
  if (node.component) result.component = node.component;
  if (node.instanceUnresolved) { result.instanceUnresolved = true; result.instanceError = node.instanceError; }
  if (!node.layout) return {...result,propertiesOmitted:node.propertiesOmitted ?? 'Layout unavailable'};
  if (node.style) result.style = {...node.style,nativeBindings:node.style.nativeBindings?{
    complete:node.style.nativeBindings.complete,
    unresolved:node.style.nativeBindings.unresolved,
    references:node.style.nativeBindings.references.map((r:Value)=>({path:r.path,status:r.status,...(r.reason?{reason:r.reason}: {})}))
  }:undefined};
  const l = node.layout, source: Value = {}, sizing: Value = {}, hints: Value[] = [];
  if (l.autoLayout.direction === 'row' || l.autoLayout.direction === 'column') source.Flow = l.autoLayout.direction === 'row' ? 'Horizontal' : 'Vertical';
  for (const axis of ['width','height']) {
    const rule = l.sizing[axis], mode = rule.mode ?? 'unknown';
    const measured = typeof rule.measured === 'number' && Number.isFinite(rule.measured) ? `${rule.measured}px` : null;
    sizing[axis] = {mode,measured};
    if (measured !== null) source[axis === 'width' ? 'Width' : 'Height'] = mode === 'unknown' ? measured : `${mode[0].toUpperCase()+mode.slice(1)} (${measured})`;
    if (mode === 'fill' || mode === 'hug') hints.push({property:axis,value:mode,reason:mode === 'fill' ? 'Size depends on the parent layout; measured size is not fixed CSS.' : 'Size follows content; measured size is not fixed CSS.'});
  }
  for (const [css,label] of Object.entries(cssLabels)) if (l.css[css] !== undefined) source[label] = l.css[css];
  Object.assign(source,l.inspector);
  const unresolved = (l.unavailable as string[]).map(property=>({property,reason:'Not available as a verified layout value in this snapshot.'}));
  if (node.instanceUnresolved) unresolved.push({property:'children',reason:node.instanceError ?? 'Component could not be resolved.'});
  result.properties = [{section:'properties-inspection-panel',fields:Object.entries(source).map(([name,value])=>({name,value}))}];
  const css = {...l.css,...node.style?.css};
  result.layout = {css,cssText:Object.entries(css).map(([k,v])=>`${k}: ${v};`).join('\n'),sizing,source,unresolved,hints,complete:false,
    geometry:l.geometry,measuredCss:l.measuredCss,constraints:l.constraints,
    note:'Values come from a captured snapshot. source contains normalized design values, not UI observations. Visual styles and text ranges are in style; unsupported mappings are explicit. UI-kit value matches, when enabled, preserve original CSS in resolvedValues and are independent of native Figma bindings.'};
  return result;
}
