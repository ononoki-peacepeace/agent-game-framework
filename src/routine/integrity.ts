import {assert,type SavePackage} from '../core/schema.js';
import {routinePlanSchema} from './schema.js';
export function validateRoutineIntegrity(save:SavePackage){
 if(save.calendar){assert(save.definition.ruleset.minutes_per_day===1440,'当前日历仅支持24小时制');assert(save.calendar.anchor_date<=save.calendar.month_lengths[save.calendar.anchor_month-1],'日历锚点日期无效');}
 const rules=save.definition.routine_rules?.activities??[];assert(new Set(rules.map(r=>r.id)).size===rules.length,'日程活动ID重复');
 const ids=new Set([...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations].map(l=>l.id));
 for(const rule of rules){assert(!rule.location_id||ids.has(rule.location_id),'活动引用未知地点');}
 for(const e of save.entities){const raw=e.components.routine?.plan;if(!raw)continue;const plan=routinePlanSchema.parse(raw);const seen=new Set<string>();
 for(const b of plan.blocks){assert(!seen.has(b.id),'计划活动ID重复');seen.add(b.id);assert(new Set(b.weekdays).size===b.weekdays.length,'计划星期重复');assert(rules.some(r=>r.id===b.activity_id),'计划引用不存在的活动');assert(b.candidate_ids.every(id=>save.entities.some(e=>e.id===id&&e.components.character)),'计划引用不存在的人物');}
 for(let day=0;day<14;day++){const slots=plan.blocks.filter(b=>b.weekdays.includes(day%7+1)).map(b=>({start:day*1440+b.start_minute,end:day*1440+b.start_minute+rules.find(r=>r.id===b.activity_id)!.duration}));
 const previous=plan.blocks.filter(b=>b.weekdays.includes((day+6)%7+1)).map(b=>({start:(day-1)*1440+b.start_minute,end:(day-1)*1440+b.start_minute+rules.find(r=>r.id===b.activity_id)!.duration}));
 const ordered=[...previous,...slots].sort((a,b)=>a.start-b.start);for(let i=1;i<ordered.length;i++)assert(ordered[i].start>=ordered[i-1].end,'固定计划存在重叠，需要澄清');}
 }
}
