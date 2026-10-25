import { safeId } from './network.js';
import { instanceScale, scaleNode } from './network-scale.js';
type Node = Record<string, any>;
type Scope = { overrides: Node[]; derived: Node[]; scale?: number };
export type InstanceContext = { scopes: Scope[]; prefix: string; symbols: string[]; properties?: Record<string,Node> };
const pathOf = (n: Node) => (n.guidPath?.guids ?? []).map(safeId) as string[];
const patch = (base: Node, changes: Node[]) => {
  const result = {...base};
  for (const change of changes) for (const [key,value] of Object.entries(change)) {
    if (['guid','guidPath','parentIndex','phase','overrideKey'].includes(key)) continue;
    if (key === 'componentPropAssignments' && Array.isArray(value) && value.length) {
      const assignments = new Map((result[key] ?? []).map((p:Node)=>[safeId(p.defID),p]));
      for (const p of value) assignments.set(safeId(p.defID),p);
      result[key] = [...assignments.values()];
    } else result[key] = value;
  }
  return result;
};
/** Resolve only the selected branch, using bounded address reads of component definitions. */
export function instanceNode(node: Node, context?: InstanceContext) {
  if (!context) return node;
  const key = safeId(node.overrideKey ?? node.guid);
  let effective = node;
  // Inner instance patches first; outer instance patches have final precedence.
  for (const scope of context.scopes) {
    effective = patch(effective, scope.overrides.filter(n=>{const p=pathOf(n);return p.length===1&&p[0]===key;}));
    // Overrides are in the unscaled scope; derived values are already rendered.
    effective = scaleNode(effective, scope.scale ?? 1);
    effective = patch(effective, scope.derived.filter(n=>{const p=pathOf(n);return p.length===1&&p[0]===key;}));
  }
  for (const ref of effective.componentPropRefs ?? []) {
    if (ref.isDeleted) continue;
    const assigned = context.properties?.[safeId(ref.defID)];
    if (!assigned) { effective = {...effective,instanceUnresolved:true,instanceError:'Component property definition or assignment absent'}; continue; }
    const v = assigned.varValue?.value ?? assigned.value ?? assigned.initialValue;
    if (ref.componentPropNodeField === 'VISIBLE' && typeof v?.boolValue === 'boolean') effective = {...effective,visible:v.boolValue};
    else if (ref.componentPropNodeField === 'TEXT_DATA' && (typeof v?.textValue === 'string' || typeof v?.textDataValue?.characters === 'string' || typeof v?.textValue?.characters === 'string')) effective = {...effective,textData:v.textDataValue ?? v.textValue};
    else if (ref.componentPropNodeField === 'OVERRIDDEN_SYMBOL_ID' && (v?.symbolIdValue?.guid ?? v?.guidValue)) effective = {...effective,overriddenSymbolID:v.symbolIdValue?.guid ?? v.guidValue};
    else effective = {...effective,instanceUnresolved:true,instanceError:'Unsupported component property binding'};
  }
  const factor = context.scopes.reduce((value, scope) => instanceScale(value * (scope.scale ?? 1)), 1);
  return factor === 1 ? effective : {...effective, instanceScaleFactor:factor};
}
export function enterInstance(node: Node, id: string, read: (id:string)=>Node | undefined, context?: InstanceContext) {
  const scale = instanceScale(node.symbolData?.uniformScaleFactor);
  const inheritedScale = (context?.scopes ?? []).reduce((value, scope) => instanceScale(value * (scope.scale ?? 1)), 1);
  const symbol = node.overriddenSymbolID ?? node.symbolData?.symbolID;
  if (!symbol) return {error:'Component reference absent'} as const;
  const symbolId = safeId(symbol), master = read(symbolId);
  if (!master || master.type !== 'SYMBOL') return {error:'Component definition absent'} as const;
  if (context?.symbols.includes(symbolId) || (context?.symbols.length ?? 0) >= 32) throw new Error('Component cycle or nesting limit exceeded');
  const scopes: Scope[] = [{overrides:node.symbolData?.symbolOverrides ?? [],derived:node.derivedSymbolData ?? [],scale}];
  const key = safeId(node.overrideKey ?? node.guid);
  const scopeTo = (records: Node[]) => records.flatMap(n=>{
    const p=pathOf(n);
    return p.length>1&&p[0]===key ? [{...n,guidPath:{guids:n.guidPath.guids.slice(1)}}] : [];
  });
  for (const outer of context?.scopes ?? []) scopes.push({overrides:scopeTo(outer.overrides),derived:scopeTo(outer.derived),scale:outer.scale});
  if (Buffer.byteLength(JSON.stringify(scopes)) > 1024*1024) throw new Error('Instance override context limit exceeded');
  const structural = scopes.some(scope=>[...scope.overrides,...scope.derived].some(n=>n.parentIndex !== undefined || (n.phase !== undefined && !['CREATED','UPDATED'].includes(n.phase))));
  if (structural) return {error:'Structural instance overrides are not supported'} as const;
  const properties: Record<string,Node> = {};
  // Variant definitions can delegate their defaults to their component set.
  // Keep local IDs as keys: child references use those, not the set's IDs.
  const definitions=master.componentPropDefs ?? [];
  const parent=definitions.some((d:Node)=>d.parentPropDefId)&&master.parentIndex?.guid
    ? read(safeId(master.parentIndex.guid)) : undefined;
  const assignments=new Map((node.componentPropAssignments ?? []).map((a:Node)=>[safeId(a.defID),a]));
  for (const d of definitions) {
    if (d.isDeleted) continue;
    const parentId=d.parentPropDefId ? safeId(d.parentPropDefId) : undefined;
    const inherited=parentId ? parent?.componentPropDefs?.find((p:Node)=>safeId(p.id)===parentId&&!p.isDeleted) : undefined;
    const value=parentId&&assignments.has(parentId) ? assignments.get(parentId) : d.varValue || d.initialValue ? d : inherited;
    if (value) properties[safeId(d.id)] = value as Node;
  }
  for (const a of node.componentPropAssignments ?? []) properties[safeId(a.defID)] = a;
  // Instance fields (including its position and size) are already rendered.
  // Only absent properties inherited from the master need the combined scale.
  const totalScale = instanceScale(scale * inheritedScale);
  const effective: Node = {...scaleNode(master, totalScale),...node,...(totalScale !== 1 || node.instanceScaleFactor !== undefined ? {instanceScaleFactor:totalScale} : {}),layoutInheritance:{componentId:symbolId},component:{definitionId:symbolId,status:'expanded',source:'captured-component',scaleFactor:scale,inheritedScaleFactor:inheritedScale,complete:false}};
  if (node.overriddenSymbolID && node.symbolData?.symbolID) {
    const original = read(safeId(node.symbolData.symbolID));
    if (original?.name === node.name && master.name !== undefined) effective.name = master.name;
  }
  if (!node.instanceError) delete effective.instanceUnresolved;
  return {masterId:symbolId,effective,context:{scopes,prefix:id.startsWith('I')?id:`I${id}`,symbols:[...(context?.symbols??[]),symbolId],properties}};
}
