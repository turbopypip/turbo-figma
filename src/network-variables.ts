import { mapContextVariables } from './variables.js';

type Value = Record<string, any>;
/** Captured references only. Never resolve a GUID using an unrelated UI-kit value. */
export function nativeVariableBindings(node: Value) {
  const references: Value[] = [], unresolved: string[] = [];
  const add = (path: string, data: Value) => {
    if (references.length >= 128) { if (!unresolved.includes('referenceLimit')) unresolved.push('referenceLimit'); return; }
    const guid = data?.value?.alias?.guid;
    const id = guid && [guid.sessionID,guid.localID].every(v=>Number.isSafeInteger(v)&&v>=0) ? `${guid.sessionID}:${guid.localID}` : undefined;
    references.push({path, dataType:data?.dataType ?? 'unknown', ...(id?{variableId:id}:{}),
      status:'unresolved', reason:id?'Variable definition and active mode are not resolved.':'Unsupported or external variable reference.'});
  };
  const scan = (value: Value, prefix: string) => {
    const entries = value.variableConsumptionMap?.entries;
    if (Array.isArray(entries)) {
      if (entries.length>128) unresolved.push(`${prefix}consumptionLimit`);
      for (const e of entries.slice(0,128)) add(`${prefix}${e.variableField ?? `nodeField:${e.nodeField ?? 'unknown'}`}`,e.variableData);
    }
    for (const field of ['fillPaints','strokePaints','effects']) {
      const items=value[field]; if (!Array.isArray(items)) continue;
      if(items.length>128)unresolved.push(`${prefix}${field}.limit`);
      items.slice(0,128).forEach((p:Value,i:number)=>{
        for(const [key,data] of Object.entries(p)) if(key.endsWith('Var')) add(`${prefix}${field}[${i}].${key}`,data as Value);
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
    note:'Captured references are independent of UI-kit value matching. Missing references do not prove absence of native bindings; definitions, modes and unsupported expressions are not resolved.'};
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
