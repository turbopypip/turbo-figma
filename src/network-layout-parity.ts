/** Strict acceptance helper. Never treats an absent observation as a successful comparison. */
type Json = Record<string, any>;
export const layoutCssProperties = new Set(['display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'align-content', 'align-self', 'gap', 'row-gap', 'column-gap', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'position', 'top', 'left',
  'right', 'bottom', 'transform', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row']);
const px = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v :
  typeof v === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(v.replaceAll(',', '')) ? Number(v.replaceAll(',', '').slice(0,-2)) : undefined;
const expandPadding = (css: Json) => {
  const copy = { ...css };
  if (typeof css.padding === 'string') {
    const p = css.padding.trim().split(/\s+/);
    if (p.length >= 1 && p.length <= 4) for (const [i, side] of ['top','right','bottom','left'].entries()) {
      copy[`padding-${side}`] ??= [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]][i];
    }
    delete copy.padding;
  }
  return copy;
};
export function compareLayoutPages(uiPages: Json[], networkPages: Json[], options: { sameStateEvidence?: string; alignInstanceIds?: boolean } = {}) {
  const issues: Json[] = [], baselineCorrections: Json[] = [], identityMappings: Json[] = [];
  const checks: Record<string, number> = {};
  const collect = (pages: Json[], side: string) => {
    const nodes = new Map<string, Json>();
    if (!pages.length) issues.push({side,kind:'missing-pages'});
    let fileKey: string | undefined, rootId: string | undefined;
    let expectedOffset = 0;
    for (const [i, raw] of pages.entries()) {
      const page = raw.context ?? raw;
      const file = page.fileKey, root = page.rootId ?? page.node?.id;
      if (fileKey && file && fileKey !== file || rootId && root && rootId !== root) issues.push({side,page:i,kind:'mixed-selection'});
      fileKey ??= file; rootId ??= root;
      if (!Array.isArray(page.nodes)) { issues.push({side,page:i,kind:'missing-nodes'}); continue; }
      const t = page.traversal;
      if (side === 'network') {
        if (t?.nextOffset != null && t.nextOffset !== expectedOffset + page.nodes.length) issues.push({side,page:i,kind:'noncontiguous-page'});
        expectedOffset += page.nodes.length;
        if (i === pages.length - 1 && t?.eligibleRecords !== undefined && expectedOffset !== t.eligibleRecords) issues.push({side,page:i,kind:'missing-records'});
      }
      if (i > 0) {
        const previous = pages[i-1].context ?? pages[i-1];
        const continuation = side === 'ui' ? previous.traversal?.nextRequest : previous.traversal?.continuation ?? previous.traversal?.nextOffset;
        if (continuation == null) issues.push({side,page:i,kind:'unexpected-page'});
      }
      if (page.captureWarnings?.length || page.ignoredLiveBatches > 0) issues.push({side,page:i,kind:'capture-not-current-or-lossy'});
      if (!t) issues.push({side,page:i,kind:'missing-traversal-evidence'});
      // Context pages flag remaining children until their continuation is consumed.
      // Only that pagination flag is recoverable; depth/property omissions still fail.
      const paginatedContext = side === 'network' && t?.continuation != null && t?.nextOffset != null;
      if ((!paginatedContext && (page.truncated || page.childrenTruncated)) || page.truncations?.length || t?.pendingDepthCount || t?.pendingDepth?.length ||
          t?.pending?.some((p: Json)=>p.reason === 'depth limit')) issues.push({side,page:i,kind:'truncated'});
      if (side === 'ui' && t?.complete !== true && !t?.nextRequest) issues.push({side,page:i,kind:'incomplete-traversal'});
      if (i === pages.length - 1 && (t?.nextRequest || t?.continuation || t?.nextOffset != null)) issues.push({side,page:i,kind:'missing-continuation-page'});
      for (const n of page.nodes) {
        if (!n.id || nodes.has(n.id)) { issues.push({side,kind:'duplicate-or-invalid-node',nodeId:n.id}); continue; }
        nodes.set(n.id, n);
        if (n.propertiesOmitted || n.truncated || !n.layout) issues.push({side,kind:'missing-node-properties',nodeId:n.id});
        if (side === 'network' && n.instanceUnresolved) issues.push({side,kind:'unresolved-instance',nodeId:n.id});
      }
    }
    return {nodes,fileKey,rootId};
  };
  const ui = collect(uiPages, 'ui'), network = collect(networkPages, 'network');
  if (options.alignInstanceIds) {
    const expected=[...ui.nodes.values()], actual=[...network.nodes.values()];
    const aliases=new Map<string,string>();
    let identical=expected.length===actual.length;
    for(let i=0;i<expected.length&&identical;i++) {
      const u=expected[i],n=actual[i];
      if (u.name!==n.name || u.depth!==n.depth || (!n.id.startsWith('I') && u.id!==n.id)) identical=false;
      else aliases.set(u.id,n.id);
    }
    for(let i=0;i<expected.length&&identical;i++) {
      const u=expected[i],n=actual[i];
      if(u.id!==ui.rootId && (aliases.get(u.parentId)??u.parentId)!==n.parentId) identical=false;
    }
    if(!identical) issues.push({kind:'instance-identity-structure-mismatch'});
    else {
      ui.nodes.clear();
      for(const n of expected) {
        const id=aliases.get(n.id)!;
        if(id!==n.id) identityMappings.push({uiNodeId:n.id,networkNodeId:id,method:'complete ordered tree: matching name, depth and parent; session IDs replaced by canonical instance/source path'});
        ui.nodes.set(id,{...n,id,parentId:aliases.get(n.parentId)??n.parentId});
      }
    }
  }
  if (!options.sameStateEvidence?.trim()) issues.push({kind:'same-state-unverified'});
  if (!ui.fileKey || !ui.rootId || !network.fileKey || !network.rootId) issues.push({kind:'missing-selection-evidence'});
  if (ui.fileKey !== network.fileKey || ui.rootId !== network.rootId) issues.push({kind:'selection-mismatch',ui:{fileKey:ui.fileKey,rootId:ui.rootId},network:{fileKey:network.fileKey,rootId:network.rootId}});
  const compare = (nodeId: string, property: string, actual: any, expected: any, numeric = false) => {
    checks[property] = (checks[property] ?? 0) + 1;
    const layout = network.nodes.get(nodeId)?.layout;
    const unavailable = [...(layout?.unavailable ?? []), ...(layout?.unresolved ?? []).map((item:Json)=>item.property)];
    if (unavailable.some((key:string)=>property===key || property.startsWith(key+'.'))) { issues.push({kind:'unavailable-property',nodeId,property,expected}); return; }
    if (actual === undefined || actual === null) { issues.push({kind:'missing-property',nodeId,property,expected}); return; }
    // Figma inspector prints to two decimals; float32 has magnitude-dependent precision.
    const value = property === 'inspector.Rotation' ? (v:unknown)=> typeof v==='string' && /^-?\d+(?:\.\d+)?°$/.test(v) ? Number(v.slice(0,-1)) : undefined : px;
    const a = numeric ? value(actual) : undefined, b = numeric ? value(expected) : undefined;
    const tolerance = a !== undefined && b !== undefined ? 0.005 + Math.max(Math.abs(a),Math.abs(b)) * 2 ** -23 : 0;
    if (a !== undefined && b !== undefined ? Math.abs(a-b) > tolerance : actual !== expected)
      issues.push({kind:'different-property',nodeId,property,actual,expected,...(tolerance ? {tolerance} : {})});
  };
  for (const [id, u] of ui.nodes) {
    const n = network.nodes.get(id);
    if (!n) { issues.push({kind:'missing-node',nodeId:id}); continue; }
    // UI traversal represents the selection root with null parent; the wire retains its external parent.
    if (u.parentId !== undefined && !(id === ui.rootId && u.parentId === null)) compare(id,'parentId',n.parentId,u.parentId);
    const ul = u.layout ?? {}, nl = n.layout ?? {};
    for (const axis of ['width','height']) {
      const expected = ul.sizing?.[axis];
      if (!expected) continue;
      const label=ul.source?.[axis==='width'?'Width':'Height'];
      if (expected.mode==='fixed' && typeof label==='string' && px(label)!==undefined) {
        baselineCorrections.push({nodeId:id,property:`sizing.${axis}.mode`,parserValue:'fixed',inspectorValue:label,reason:'Bare numeric dimension does not expose a resizing mode. Measured dimension is still compared.'});
      } else compare(id,`sizing.${axis}.mode`,nl.sizing?.[axis]?.mode,expected.mode);
      if (expected.measured != null) compare(id,`geometry.size.${axis}`,nl.geometry?.size?.[axis],expected.measured,true);
    }
    const expectedCss = expandPadding({...ul.css,...ul.resolvedValues});
    const actualCss = expandPadding(nl.css ?? {});
    for (const [key,value] of Object.entries(expectedCss)) if (layoutCssProperties.has(key)) {
      const bareDimension = ['width','height'].includes(key) && px(ul.source?.[key==='width'?'Width':'Height'])!==undefined;
      compare(id,`css.${key}`,bareDimension ? nl.measuredCss?.[key] : actualCss[key],value,true);
    }
    // The previous parser retains these inspector geometry fields outside css.
    for (const key of ['Top','Left','Rotation']) if (ul.source?.[key] !== undefined)
      compare(id,`inspector.${key}`,nl.inspector?.[key] ?? nl.source?.[key],ul.source[key],true);
  }
  for (const id of network.nodes.keys()) if (!ui.nodes.has(id)) issues.push({kind:'extra-node',nodeId:id});
  return { accepted: issues.length === 0 && ui.nodes.size > 0, scope: 'all UI layout/CSS properties; visual/text styles belong to TODO 12',
    sameStateEvidence: options.sameStateEvidence ?? null, uiNodes:ui.nodes.size, networkNodes:network.nodes.size, checks, baselineCorrections, identityMappings, issues };
}
