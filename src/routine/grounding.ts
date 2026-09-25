import {assert,type SavePackage} from '../core/schema.js';
import {legacyPublic} from './migration.js';
// Descriptions are truncated in AI context: migrated canon documents are player history, not prompt payload.
const descriptionLimit=240;
export function groundingContext(save:SavePackage){
 const canon=legacyPublic(save),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
 const tasks={...((player.components.quests?.entries??{}) as Record<string,unknown>),...(canon?.opportunities??{})};
 return {entity_ids:save.entities.map(e=>e.id),task_ids:Object.keys(tasks),activity_ids:(save.definition.routine_rules?.activities??[]).map(a=>a.id),
   facts:save.entities.map(e=>({id:e.id,name:e.components.identity?.name??'对象',description:String(e.components.identity?.description??'').slice(0,descriptionLimit),location:e.components.location?.location_id??null})),
   tasks,player:{id:player.id,components:Object.fromEntries(Object.entries(player.components).filter(([k])=>!['routine','character_card'].includes(k)))},
   time:save.runtime.time,locations:save.definition.map?.locations??[],routes:save.definition.map?.routes??[]};
}
export function validateReferences(save:SavePackage,refs:{entity_ids:string[];task_ids:string[];activity_ids:string[]}){
 const context=groundingContext(save);
 assert(refs.entity_ids.every(id=>context.entity_ids.includes(id)),'AI 引用了不存在的人物或物品，结果未提交');
 assert(refs.task_ids.every(id=>context.task_ids.includes(id)),'AI 引用了不存在的任务，结果未提交');
 assert(refs.activity_ids.every(id=>context.activity_ids.includes(id)),'AI 引用了不存在的活动或项目，结果未提交');
}
