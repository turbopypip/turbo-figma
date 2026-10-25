type Value=Record<string,any>;
export type ModeContext=Map<string,{modeId:string;sourceNodeId:string;order?:number}>;
export type VariableReader={node:(id:string)=>Value|undefined;asset:(type:string,ref:Value)=>string|undefined};
const id=(g:any):string|undefined=>g&&[g.sessionID,g.localID].every(v=>Number.isSafeInteger(v)&&v>=0)?`${g.sessionID}:${g.localID}`:undefined;
const refKey=(ref:Value)=>id(ref?.guid)?`g:${id(ref.guid)}`:typeof ref?.assetRef?.key==='string'?`a:${JSON.stringify([ref.assetRef.key,ref.assetRef.version??null])}`:undefined;
export function inheritVariableModes(parent:ModeContext,node:Value,nodeId:string):ModeContext {
  const entries=node.variableModeBySetMap?.entries;
  if(!Array.isArray(entries))return parent;
  if(entries.length>128)throw new Error('Variable mode context limit exceeded');
  const result=new Map(parent);
  const order=Math.max(0,...[...parent.values()].map(v=>v.order??0))+1;
  for(const e of entries) {
    const key=refKey(e.variableSetID),modeId=id(e.variableModeID);
    if(key)result.set(key,{modeId:modeId??'invalid',sourceNodeId:nodeId,order});
  }
  if(result.size>128)throw new Error('Inherited variable mode context limit exceeded');
  return result;
}
const literal=(data:Value):unknown=>{
  const value=data?.value;
  switch(data?.dataType) {
    case 'FLOAT':return typeof value?.floatValue==='number'&&Number.isFinite(value.floatValue)?value.floatValue:undefined;
    case 'BOOLEAN':return typeof value?.boolValue==='boolean'?value.boolValue:undefined;
    case 'STRING':return typeof value?.textValue==='string'&&value.textValue.length<=4096?value.textValue:undefined;
    case 'COLOR':return value?.colorValue&&['r','g','b','a'].every(k=>typeof value.colorValue[k]==='number'&&value.colorValue[k]>=0&&value.colorValue[k]<=1)?Object.fromEntries(['r','g','b','a'].map(k=>[k,value.colorValue[k]])):undefined;
  }
};
/** Resolve only captured definitions. No network access, value matching or guessed active modes. */
export function resolveNativeVariable(data:Value,modes:ModeContext,read:VariableReader):Value {
  let operations=0;
  const locate=(ref:Value,type:string)=>{
    const local=id(ref?.guid),target=local??read.asset(type,ref?.assetRef);
    const node=target?read.node(target):undefined;
    return node?.type===type?{id:target!,node}:undefined;
  };
  const resolve=(data:Value,seen:Set<string>,depth:number,activeModes:ModeContext):Value=>{
    if(++operations>128||depth>16)return {status:'unresolved',reason:'Variable alias resolution limit exceeded'};
    if(data?.dataType!=='ALIAS') {
      const value=literal(data);
      return value!==undefined?{status:'resolved',dataType:data.dataType,value,chain:[]}:{status:'unresolved',reason:'Unsupported or missing variable value',dataType:data?.dataType??'unknown'};
    }
    const found=locate(data.value?.alias,'VARIABLE');
    if(!found)return {status:'unresolved',reason:'Variable definition absent, version mismatch or ambiguous asset key'};
    const {id:variableId,node}=found;
    const base:Value={variableId,name:typeof node.name==='string'?node.name.slice(0,4096):null,dataType:node.variableResolvedType};
    if(seen.has(variableId))return {...base,status:'unresolved',reason:'Variable alias cycle'};
    const next=new Set(seen);next.add(variableId);
    if(node.backingVariableId||node.overriddenVariableId)return {...base,status:'unresolved',reason:'Extended variable definitions are not supported'};
    const set=locate(node.variableSetID,'VARIABLE_SET');
    if(!set)return {...base,status:'unresolved',reason:'Variable collection absent, version mismatch or ambiguous asset key'};
    const raw=set.node.variableSetModes;
    if(!Array.isArray(raw)||!raw.length||raw.length>32)return {...base,status:'unresolved',reason:'Variable collection modes absent or over limit'};
    if(set.node.backingVariableSetId||raw.some(m=>m.parentVariableSetId||m.parentModeId))return {...base,status:'unresolved',reason:'Extended collection mode inheritance is not supported'};
    const modeIds=raw.map(m=>id(m.id));
    if(modeIds.some(v=>!v)||new Set(modeIds).size!==raw.length)return {...base,status:'unresolved',reason:'Invalid or duplicate collection mode IDs'};
    const collection={id:set.id,name:typeof set.node.name==='string'?set.node.name.slice(0,4096):null};
    const entries=node.variableDataValues?.entries;
    if(!Array.isArray(entries)||entries.length>32)return {...base,collection,status:'unresolved',reason:'Variable mode values absent or over limit'};
    const values=new Map<string,Value>();
    for(const entry of entries){const mode=id(entry.modeID);if(!mode||values.has(mode))return {...base,collection,status:'unresolved',reason:'Invalid or duplicate variable mode value'};values.set(mode,entry.variableData);}
    const keys=[`g:${set.id}`,refKey(node.variableSetID),refKey({assetRef:{key:set.node.key,version:set.node.version}}),refKey({assetRef:{key:set.node.key}})].filter((v):v is string=>!!v);
    const candidates=keys.map(k=>activeModes.get(k)).filter((v):v is {modeId:string;sourceNodeId:string;order?:number}=>!!v);
    const nearest=Math.max(0,...candidates.map(v=>v.order??0));
    const explicit=candidates.filter(v=>(v.order??0)===nearest);
    const conflict=new Set(explicit.map(v=>v.modeId)).size>1;
    const selected=conflict?undefined:explicit[0]?.modeId??(raw.length===1?modeIds[0]:undefined);
    const modeValues:Value[]=raw.map(m=>{
      const perMode=new Map(activeModes);
      for(const key of keys)perMode.set(key,{modeId:id(m.id)!,sourceNodeId:'collection-mode-value',order:nearest+1});
      const resolved=values.has(id(m.id)!)?resolve(values.get(id(m.id)!)!,next,depth+1,perMode):{status:'unresolved',reason:'Value absent for collection mode'};
      return {...resolved,...(resolved.name?{variableName:resolved.name}:{}),id:id(m.id)!,name:typeof m.name==='string'?m.name.slice(0,4096):null};
    });
    const chosen=modeValues.find(m=>m.id===selected);
    const chainEntry={variableId,name:base.name,collection,...(chosen?{modeId:chosen.id,modeName:chosen.name}: {})};
    const common=modeValues.every(v=>v.status==='resolved'&&JSON.stringify(v.value)===JSON.stringify(modeValues[0].value)&&v.dataType===modeValues[0].dataType);
    const effective=chosen??(!selected&&!conflict&&common?modeValues[0]:undefined);
    if(effective?.status==='resolved'&&node.variableResolvedType&&node.variableResolvedType!==effective.dataType)
      return {...base,collection,modes:modeValues,status:'unresolved',reason:'Resolved value type does not match variable definition'};
    return {...base,collection,modeSelection:conflict?'conflicting':explicit.length?'explicit-or-inherited':raw.length===1?'single-mode':'unknown',
      ...(explicit[0]?{modeSourceNodeId:explicit[0].sourceNodeId}:{}),...(chosen?{modeId:chosen.id,modeName:chosen.name}:{}),modes:modeValues,
      ...(effective?.status==='resolved'?{status:'resolved',value:effective.value,dataType:effective.dataType,modeIndependent:!chosen,chain:[chainEntry,...(chosen?effective.chain??[]:[])]}:
        {status:'unresolved',reason:chosen?.reason??(selected?'Selected mode absent from collection':'Active mode is not established'),chain:[chainEntry]})};
  };
  const result=resolve(data,new Set(),0,modes);
  return Buffer.byteLength(JSON.stringify(result))<=32768?result:{status:'unresolved',reason:'Variable resolution output limit exceeded'};
}
