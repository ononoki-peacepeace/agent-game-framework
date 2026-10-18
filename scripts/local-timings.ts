// Isolated diagnostic instrumentation only; never loaded by the game runtime.
import {AsyncLocalStorage} from 'node:async_hooks';
type Frame={id:number;parent:number|null;name:string;start:number;end?:number};
export class LocalTimings{
 private context=new AsyncLocalStorage<Frame>();private frames:Frame[]=[];private restores:(()=>void)[]=[];
 private start(name:string){const frame:Frame={id:this.frames.length,parent:this.context.getStore()?.id??null,name,start:performance.now()};this.frames.push(frame);return frame;}
 sync<T>(name:string,run:()=>T):T{const frame=this.start(name);try{return this.context.run(frame,run);}finally{frame.end=performance.now();}}
 async async<T>(name:string,run:()=>Promise<T>):Promise<T>{const frame=this.start(name);try{return await this.context.run(frame,run);}finally{frame.end=performance.now();}}
 wrap(owner:any,key:string,name:string,async=false){const original=owner[key],self=this;
  owner[key]=function(...args:any[]){if(!self.context.getStore())return original.apply(this,args);
   return async?self.async(name,()=>original.apply(this,args)):self.sync(name,()=>original.apply(this,args));};
  this.restores.push(()=>{owner[key]=original;});
 }
 restore(){for(const restore of this.restores.reverse())restore();}
 report(){
  const root=this.frames.find(frame=>frame.name==='http.handler');if(!root)return null;
  const end=root.end??performance.now(),totals=new Map<string,{calls:number;inclusive_ms:number;exclusive_ms:number}>();
  for(const frame of this.frames){if(frame.start>end)continue;const finish=Math.min(frame.end??end,end),duration=finish-frame.start;
   const children=this.frames.filter(child=>child.parent===frame.id&&child.start<finish).map(child=>[child.start,Math.min(child.end??end,finish)]).sort((a,b)=>a[0]-b[0]);
   let covered=0,last=frame.start;for(const [from,to] of children){covered+=Math.max(0,to-Math.max(last,from));last=Math.max(last,to);}
   const row=totals.get(frame.name)??{calls:0,inclusive_ms:0,exclusive_ms:0};row.calls++;row.inclusive_ms+=duration;row.exclusive_ms+=Math.max(0,duration-covered);totals.set(frame.name,row);
  }
  return {http_ms:Math.round(end-root.start),rows:[...totals].map(([name,row])=>({name,calls:row.calls,inclusive_ms:Math.round(row.inclusive_ms),exclusive_ms:Math.round(row.exclusive_ms)})).sort((a,b)=>b.exclusive_ms-a.exclusive_ms),
   tree:this.frames.map(frame=>({id:frame.id,parent:frame.parent,name:frame.name,start_ms:Math.round(frame.start-root.start),end_ms:Math.round(Math.min(frame.end??end,end)-root.start)}))};
 }
}
