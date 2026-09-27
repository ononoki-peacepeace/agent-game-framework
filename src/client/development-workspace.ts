export interface StoredSystemReply {
  category:string; tool_id:string|null; needs_confirmation:boolean; message:string;
  title?:string|null; clarification?:string|null; workflow?:string|null; pending_field?:string|null; expression?:'model'|'template';
}
export interface DevelopmentWorkspaceState {
  version:1; active_task_id:string|null; dev_open:boolean; advanced_open:boolean; drafts:Record<string,string>; updated_at:string;
  /** The System composer draft and last reply survive a tab switch, so a running request is never lost. */
  system_draft:string; system_reply:StoredSystemReply|null; hidden_task_ids:string[]; show_hidden_tasks:boolean; only_active:boolean;
}
const prefix='agf:development-workspace:';
const blank=():DevelopmentWorkspaceState=>({version:1,active_task_id:null,dev_open:false,advanced_open:false,drafts:{},updated_at:new Date(0).toISOString(),system_draft:'',system_reply:null,hidden_task_ids:[],show_hidden_tasks:false,only_active:false});
type StorageLike=Pick<Storage,'getItem'|'setItem'>;
const browserStorage=()=>typeof localStorage==='undefined'?null:localStorage;
export function loadDevelopmentWorkspace(gameId:string,storage:StorageLike|null=browserStorage()):DevelopmentWorkspaceState{
 try{const raw=storage?.getItem(prefix+gameId);if(!raw)return blank();const parsed=JSON.parse(raw) as Partial<DevelopmentWorkspaceState>;return {version:1,active_task_id:typeof parsed.active_task_id==='string'?parsed.active_task_id:null,dev_open:parsed.dev_open===true,advanced_open:parsed.advanced_open===true,drafts:parsed.drafts&&typeof parsed.drafts==='object'?parsed.drafts:{},updated_at:typeof parsed.updated_at==='string'?parsed.updated_at:blank().updated_at,system_draft:typeof parsed.system_draft==='string'?parsed.system_draft:'',system_reply:parsed.system_reply&&typeof parsed.system_reply==='object'?parsed.system_reply:null,hidden_task_ids:Array.isArray(parsed.hidden_task_ids)?parsed.hidden_task_ids.filter((id):id is string=>typeof id==='string'):[],show_hidden_tasks:parsed.show_hidden_tasks===true,only_active:parsed.only_active===true};}catch{return blank();}
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
export function saveSystemDraft(gameId:string,text:string,storage:StorageLike|null=browserStorage()){return saveDevelopmentWorkspace(gameId,{system_draft:text},storage);}
export function saveSystemReply(gameId:string,reply:StoredSystemReply|null,storage:StorageLike|null=browserStorage()){return saveDevelopmentWorkspace(gameId,{system_reply:reply},storage);}
