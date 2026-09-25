import {assert,type SavePackage,type WorldPackage} from '../core/schema.js';
import {calendarDay} from './calendar.js';
import {scheduleWindowFromText,windowDurationLabel,windowRange,type ScheduleWindow} from './schema.js';
import {observe} from '../observability/index.js';
import {availableModules} from '../modules/index.js';

export interface InstalledWorld {world:WorldPackage;legacy_maps:WorldPackage['map'][]}
export function legacyPublic(save:SavePackage):Record<string,any>|null {
 const marker='【LEGACY_PUBLIC_CANON_REV43】',text=save.definition.prompt_profile.engine_policy;
 if(!text.includes(marker))return null;
 try{return JSON.parse(text.slice(text.indexOf(marker)+marker.length).trim());}catch{return null;}
}

// Structural comparisons must not depend on key order: a save may reach the same state through several paths.
function canonical(value:unknown):string{
 return JSON.stringify(sortKeys(value));
}
function sortKeys(value:unknown):unknown{
 if(Array.isArray(value))return value.map(sortKeys);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,entry])=>[key,sortKeys(entry)]));
 return value;
}
const acceptedStatuses=new Set(['accepted','attending_active','joined_active','in_progress','interested_accepted']);
const finishedStatuses=new Set(['completed','attended','passed_by_player','declined','declined_due_to_schedule_conflict','cancelled','failed','expired','resolved']);
type LegacyEntry={status?:string;task?:string;title?:string;summary?:string;event_time?:string;time_cost?:string;announced_date?:string};

function playerOf(save:SavePackage){return save.entities.find(e=>e.id===save.player_state.entity_id);}
function entryFor(save:SavePackage,id:string,canon:Record<string,any>|null):LegacyEntry{
 const components=(playerOf(save)?.components??{}) as Record<string,{entries?:Record<string,LegacyEntry>}|undefined>;
 const fromComponents=components.opportunities?.entries?.[id] ?? components.quests?.entries?.[id] ?? null;
 const fromCanon=(canon?.opportunities?.[id] ?? null) as LegacyEntry|null;
 // The structured record owns the status; the legacy canon supplies the description the player already saw.
 return {...(fromCanon??{}),...(fromComponents??{})};
}
// The legacy save recorded the player's condition; migrating it is a structural repair, not new canon.
function deriveConditionValues(save:SavePackage):{hp:number;stamina:number;stress:number}|null{
 const legacy=(legacyPublic(save)?.character?.condition ?? null) as Record<string,unknown>|null;
 const value=(key:string)=>legacy&&typeof legacy[key]==='number'?Number(legacy[key]):null;
 const hp=value('hp'),stamina=value('stamina'),stress=value('stress');
 if(hp!==null&&stamina!==null&&stress!==null&&[hp,stamina,stress].every(number=>number>=0&&number<=100))return {hp:Math.trunc(hp),stamina:Math.trunc(stamina),stress:Math.trunc(stress)};
 const description=String(playerOf(save)?.components.identity?.description??'');
 const read=(label:string)=>Number(description.match(new RegExp(`${label}\\s*(\\d+)(?:\\s*/\\s*\\d+)?`,'i'))?.[1]??NaN);
 const textHp=read('HP'),textStamina=read('体力'),textStress=read('压力');
 if([textHp,textStamina,textStress].every(number=>Number.isFinite(number)&&number>=0&&number<=100))return {hp:Math.trunc(textHp),stamina:Math.trunc(textStamina),stress:Math.trunc(textStress)};
 return null;
}
function componentStatus(save:SavePackage,id:string):string|undefined{
 const components=(playerOf(save)?.components??{}) as Record<string,{entries?:Record<string,{status?:string}>}|undefined>;
 return components.opportunities?.entries?.[id]?.status ?? components.quests?.entries?.[id]?.status;
}
function cleanLabel(entry:LegacyEntry,id:string){
 const raw=String(entry.task ?? entry.title ?? entry.summary ?? id).replace(/（[^）]*(?:待确认|时刻待确认)[^）]*）/g,'').trim();
 return (raw||id).slice(0,150);
}
function timeText(entry:LegacyEntry){return [entry.event_time,entry.announced_date,entry.time_cost].filter(value=>typeof value==='string'&&value).join(' ');}

// Cheap check: which normalisations are still required for this save? Runs on every read, so it must not clone or parse canon.
export function migrationReasons(save:SavePackage,installed:InstalledWorld[]):string[]{
 const reasons:string[]=[];
 const pack=installed.find(p=>p.world.meta.id===save.definition.meta.id);
 if(!save.routine_meta)reasons.push('missing-routine-meta');
 if(!save.calendar && !save.definition.calendar)reasons.push('missing-calendar');
 if(pack&&canonical(save.definition.map)!==canonical(pack.world.map))reasons.push('installed-map-v1');
 if(pack&&!save.routine_meta?.migration_ids.includes('installed-map-v1'))reasons.push('installed-map-v1-marker');
 if(pack&&!save.definition.routine_rules&&pack.world.routine_rules)reasons.push('installed-routine-rules');
 if(!save.routine_meta?.migration_ids.includes('legacy-accepted-tasks-v1'))reasons.push('legacy-accepted-tasks-v1');
 if(!save.routine_meta?.migration_ids.includes('module-metadata-v1'))reasons.push('module-metadata-v1');
 if(!save.routine_meta?.migration_ids.includes('accepted-commitments-v2'))reasons.push('accepted-commitments-v2');
 const player=playerOf(save);
 if(save.definition.enabled_modules.includes('routine')&&player&&!player.components.condition&&!save.routine_meta?.migration_ids.includes('player-condition-v1'))reasons.push('player-condition-v1');
 for(const entity of save.entities){
  const routine=entity.components.routine as Record<string,unknown>|undefined;
  if(routine&&(routine.status===undefined||routine.enabled===undefined||routine.supplements===undefined)){reasons.push('routine-state-v1');break;}
 }
 return [...new Set(reasons)];
}

export function migrateInstalledWorld(save:SavePackage,installed:InstalledWorld[]) {
 assert(save?.schema_version===1 && save.definition?.meta && save.runtime?.time && save.entities,'存档格式或版本无效，未进行迁移');
 const reasons=migrationReasons(save,installed);
 if(!reasons.length)return {save,changed:false};
 const before=canonical(save),started=performance.now();
 observe('debug','migration.started',{module:'migration',revision:save.state_revision,metadata:{world:save.definition.meta.id,reasons}});
 applyMigrations(save,installed);
 const changed=canonical(save)!==before;
 if(changed)observe('info','migration.completed',{module:'migration',duration_ms:performance.now()-started,revision:save.state_revision,metadata:{world:save.definition.meta.id,reasons,changed,migration_ids:save.routine_meta?.migration_ids??[],calendar:!!save.calendar}});
 return {save,changed};
}

// Deterministic, structural normalisation only. Gameplay canon (relationships, money, skills, inventory,
// story, task outcomes) is never rewritten here.
function applyMigrations(save:SavePackage,installed:InstalledWorld[]){
 const pack=installed.find(p=>p.world.meta.id===save.definition.meta.id);
 save.modules??={};
 if(pack){
   const same=canonical(save.definition.map)===canonical(pack.world.map);
   if(!same){assert(pack.legacy_maps.some(m=>canonical(m)===canonical(save.definition.map)),'当前地图与已安装世界版本不兼容，已停止导入；需要检查静态地图差异');save.definition.map=structuredClone(pack.world.map);}
   if(!save.definition.routine_rules && pack.world.routine_rules)save.definition.routine_rules=structuredClone(pack.world.routine_rules);
   if(!save.definition.calendar && pack.world.calendar)save.definition.calendar=structuredClone(pack.world.calendar);
 }
 save.calendar??=save.definition.calendar ? structuredClone(save.definition.calendar) : undefined;
 save.routine_meta??={version:1,calendar_issue:null,scheduled_tasks:[],migration_ids:[]};
 save.routine_meta.calendar_issue=save.calendar?null:'缺少可信的日历锚点。请确认当前日期、星期及月长后再运行生活模式；不会猜测或回算时间。';
 if(pack && !save.routine_meta.migration_ids.includes('installed-map-v1'))save.routine_meta.migration_ids.push('installed-map-v1');
 importLegacyAcceptedTasks(save);
 normaliseAcceptedCommitments(save);
 if(!save.routine_meta!.migration_ids.includes('accepted-commitments-v2'))save.routine_meta!.migration_ids.push('accepted-commitments-v2');
 if(!save.routine_meta!.migration_ids.includes('module-metadata-v1')){
   // Deterministic derivation only: a save that owns map data keeps (or regains) the map capability.
   // Nothing about characters, money, skills, inventory, story, time or AI history is touched here.
   if((save.definition.map?.locations?.length??0)>0 && !save.definition.enabled_modules.includes('map')) save.definition.enabled_modules.push('map');
   for(const module of availableModules){
     const enabled=save.definition.enabled_modules.includes(module.id);
     if(enabled && !save.module_versions[module.id]) save.module_versions[module.id]=module.version;
     // Only enabled modules are (re)installed here; a dormant or removed record is left exactly as it is.
     if(enabled) save.modules[module.id]={installed:true,enabled:true,version:save.module_versions[module.id]??module.version,state_version:module.manifest?.state_schema_version??'v1'};
   }

   for(const id of save.definition.enabled_modules){
     const module=availableModules.find(entry=>entry.id===id);
     if(module) continue;
     // A module the framework no longer ships (for example an extension-provided module) stays recorded as dormant.
     save.modules[id]={installed:true,enabled:true,version:save.module_versions[id]??'0.0.0',state_version:'unknown'};
   }
   save.routine_meta!.migration_ids.push('module-metadata-v1');
 }
 if(!save.routine_meta!.migration_ids.includes('player-condition-v1')){
   // Derive the player's condition from the save's own history, once. Nothing is invented when it is unknown.
   const values=deriveConditionValues(save);
   if(values){
     const current=playerOf(save),initial=save.definition.entities.find(entity=>entity.id===save.player_state.entity_id);
     if(current)current.components.condition={...values};
     if(initial)initial.components.condition={...values};
   }
   save.routine_meta!.migration_ids.push('player-condition-v1');
 }
 normaliseRoutineState(save);

}

// Only explicit accepted commitments become schedule constraints, never old opportunities or declined invitations.
function importLegacyAcceptedTasks(save:SavePackage){
 if(save.routine_meta!.migration_ids.includes('legacy-accepted-tasks-v1'))return;
 const canon=legacyPublic(save);
 if(save.calendar && canon)for(const [id,v] of Object.entries(canon.opportunities??{}) as [string,LegacyEntry][]){
   if(v.status!=='accepted' || save.routine_meta!.scheduled_tasks.some(t=>t.id===id))continue;
   const match=String(v.event_time??'').match(/(\d+)月(\d+)日/);
   assert(match,'已接受任务缺少可确定日期，无法开始生活模拟');
   const day=calendarDay(save.calendar,Number(match[1]),Number(match[2]));
   save.routine_meta!.scheduled_tasks.push({id,label:cleanLabel(v,id),at:day*save.definition.ruleset.minutes_per_day,window:scheduleWindowFromText(String(v.event_time??'')),status:'accepted',source:'legacy public canonical accepted opportunity',resolved:false});
 }
 save.routine_meta!.migration_ids.push('legacy-accepted-tasks-v1');
}

// The authoritative status of a commitment lives in quests/opportunities. The schedule only mirrors it, so a
// task is a hard constraint exactly while the world still considers it accepted.
function normaliseAcceptedCommitments(save:SavePackage){
 const minutesPerDay=save.definition.ruleset.minutes_per_day;
 for(const task of save.routine_meta!.scheduled_tasks){
  const entry=entryFor(save,task.id,legacyPublic(save)),status=entry.status;
  const window:ScheduleWindow=task.window==='exact'?scheduleWindowFromText(timeText(entry)||task.label):task.window;
  const day=Math.floor(task.at/minutesPerDay),range=windowRange(window,day,minutesPerDay);
  task.window=window;
  task.at=window==='exact'?task.at:range.start;
  task.end_at=range.end;
  const wording=String(entry.time_cost??'').trim();
  task.duration_label=/半天|小时|分钟|天/.test(wording)?wording.slice(0,60):windowDurationLabel[window];

  task.label=cleanLabel(entry,task.id);
  if(status&&acceptedStatuses.has(status)){task.status='accepted';task.resolved=false;}
  else if(status&&finishedStatuses.has(status)){task.status=status==='cancelled'?'cancelled':'completed';task.resolved=true;}
 }
}

// Routine components written before the explicit state machine keep their behaviour and gain the new fields.
function normaliseRoutineState(save:SavePackage){
 for(const entity of save.entities){
  const routine=entity.components.routine as Record<string,unknown>|undefined;
  if(!routine)continue;
  const enabled=routine.enabled===undefined?routine.active===true:routine.enabled===true;
  routine.enabled=enabled;
  if(routine.status===undefined)routine.status=routine.interrupted===true?'interrupted':enabled?(routine.active===true?'armed':'saved'):'saved';
  routine.supplements??=[];
  routine.pattern_revision??=routine.plan?1:0;
  routine.plan_revision??=(routine.plan as {source_revision?:number}|undefined)?.source_revision??0;
  routine.armed_reason??=null;
 }
}
