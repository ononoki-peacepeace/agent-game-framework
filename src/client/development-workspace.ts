export interface DevelopmentWorkspaceState {
  version:1; active_task_id:string|null; dev_open:boolean; advanced_open:boolean; drafts:Record<string,string>; updated_at:string;
}
const prefix='agf:development-workspace:';
const blank=():DevelopmentWorkspaceState=>({version:1,active_task_id:null,dev_open:false,advanced_open:false,drafts:{},updated_at:new Date(0).toISOString()});
type StorageLike=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=()=>typeof localStorage==='undefined'?null:localStorage;
export function loadDevelopmentWorkspace(gameId:string,storage:StorageLike|null=browserStorage()):DevelopmentWorkspaceState{
 try{const raw=storage?.getItem(prefix+gameId);if(!raw)return blank();const parsed=JSON.parse(raw) as Partial<DevelopmentWorkspaceState>;return {version:1,active_task_id:typeof parsed.active_task_id==='string'?parsed.active_task_id:null,dev_open:parsed.dev_open===true,advanced_open:parsed.advanced_open===true,drafts:parsed.drafts&&typeof parsed.drafts==='object'?parsed.drafts:{},updated_at:typeof parsed.updated_at==='string'?parsed.updated_at:blank().updated_at};}catch{return blank();}
}
export function saveDevelopmentWorkspace(gameId:string,update:Partial<DevelopmentWorkspaceState>,storage:StorageLike|null=browserStorage()){
 const next={...loadDevelopmentWorkspace(gameId,storage),...update,version:1 as const,updated_at:new Date().toISOString()};
 try{storage?.setItem(prefix+gameId,JSON.stringify(next));}catch{/* Storage quota/privacy mode: keep the live React state. */}
 return next;
}
export const draftSlot=(taskId?:string|null)=>taskId||'__new__';
export function saveDevelopmentDraft(gameId:string,taskId:string|null|undefined,text:string,storage:StorageLike|null=browserStorage()){
 const current=loadDevelopmentWorkspace(gameId,storage),drafts={...current.drafts,[draftSlot(taskId)]:text};
 return saveDevelopmentWorkspace(gameId,{drafts},storage);
}
