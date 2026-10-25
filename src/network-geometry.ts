type Node = Record<string,any>;
export type Matrix = {a:number;b:number;c:number;d:number;tx:number;ty:number};
export type GeometryContext = {canvas:Matrix|null;frame:Matrix|null;frameId:string|null;isFrame:boolean;id:string};
const finite = (n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const identity:Matrix={a:1,b:0,c:0,d:1,tx:0,ty:0};
export function matrix(t:any):Matrix|null {
 return t&&['m00','m01','m02','m10','m11','m12'].every(k=>finite(t[k])) ? {a:t.m00,b:t.m10,c:t.m01,d:t.m11,tx:t.m02,ty:t.m12}:null;
}
export function compose(p:Matrix|null,t:Matrix|null):Matrix|null {
 if(!p||!t)return null;
 const r={a:p.a*t.a+p.c*t.b,b:p.b*t.a+p.d*t.b,c:p.a*t.c+p.c*t.d,d:p.b*t.c+p.d*t.d,tx:p.a*t.tx+p.c*t.ty+p.tx,ty:p.b*t.tx+p.d*t.ty+p.ty};
 return Object.values(r).every(finite)?r:null;
}
export function geometryContext(n:Node,id:string,parent?:GeometryContext):GeometryContext {
 const local=matrix(n.transform),isFrame=['FRAME','INSTANCE','SYMBOL'].includes(n.type) && n.resizeToFit !== true;
 const canvas=n.type==='CANVAS'?identity:compose(parent?.canvas??null,local);
 const frame=parent?.isFrame?local:compose(parent?.frame??null,local);
 return {canvas,frame,frameId:parent?.isFrame?parent.id:parent?.frameId??null,isFrame,id};
}
