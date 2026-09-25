import {z} from 'zod';
const key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(x=>!['constructor','prototype','__proto__'].includes(x));
const minute=z.number().int().min(0).max(1439);
export const calendarSchema=z.strictObject({version:z.literal(1),anchor_day:z.number().int().min(0),anchor_month:z.number().int().min(1).max(12),anchor_date:z.number().int().min(1).max(31),anchor_weekday:z.number().int().min(1).max(7),month_lengths:z.array(z.number().int().min(28).max(31)).length(12),source:z.string().min(1).max(300)});
export const ruleEffectSchema=z.strictObject({op:z.enum(['wallet_delta','skill_xp','attribute_delta','relationship_delta','condition_delta']),key,target_id:key.nullable(),delta:z.number().int().min(-100).max(100),reason:z.string().min(4).max(500)});
export const activityRuleSchema=z.strictObject({id:key,label:z.string().min(1).max(120),kind:z.enum(['sleep','hygiene','meal','course','training','work','study','wait','social','event']),duration:z.number().int().min(1).max(1440),location_id:key.nullable(),mode:z.enum(['local','ai']),effects:z.array(ruleEffectSchema).max(16),source:z.string().min(1).max(500)});
export const routineRulesSchema=z.strictObject({version:z.literal(1),activities:z.array(activityRuleSchema).max(100)});
export const routinePlanSchema=z.strictObject({
  version:z.literal(1),
  blocks:z.array(z.strictObject({id:key,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),start_minute:minute,activity_id:key,candidate_ids:z.array(key).max(12).default([])})).max(70),
  interrupt_policy:z.array(z.string().min(1).max(200)).max(10),
  // Deterministic completion of details the player left vague (world rules, dayparts, travel time).
  applied_assumptions:z.array(z.string().min(2).max(200)).max(16).default([]),
  source_revision:z.number().int().min(0).default(0),
  clarification:z.string().max(1000).nullable(),
});

// Schedule windows: a commitment such as "3月6日周六上午" is a legal constraint without an exact clock.
export const scheduleWindowSchema=z.enum(['morning','afternoon','evening','after_school','half_day','exact']);
export type ScheduleWindow=z.infer<typeof scheduleWindowSchema>;
export const windowStartMinute:Record<ScheduleWindow,number>={morning:480,afternoon:780,evening:1080,after_school:960,half_day:540,exact:0};
export const windowEndMinute:Record<ScheduleWindow,number>={morning:720,afternoon:1020,evening:1260,after_school:1200,half_day:900,exact:60};
export const windowLabel:Record<ScheduleWindow,string>={morning:'上午',afternoon:'下午',evening:'晚上',after_school:'放学后',half_day:'约半天',exact:'当天'};
export const windowDurationLabel:Record<ScheduleWindow,string>={morning:'约4小时',afternoon:'约4小时',evening:'约3小时',after_school:'约4小时',half_day:'约半天',exact:'约1小时'};
export function windowRange(window:ScheduleWindow,day:number,minutesPerDay:number){
  const base=day*minutesPerDay;
  if(window==='exact')return {start:base,end:base+windowEndMinute.exact};
  return {start:base+windowStartMinute[window],end:base+windowEndMinute[window]};
}
export function scheduleWindowFromText(text:string):ScheduleWindow{
  const value=text.trim();
  if(/放学|课后/.test(value))return 'after_school';
  // The time of day decides the window; "约半天" is only a duration wording and stays as the duration label.
  if(/上午|早上|早晨|清晨/.test(value))return 'morning';
  if(/中午|下午|午后/.test(value))return 'afternoon';
  if(/晚上|傍晚|夜间|夜裏|夜里|今晚/.test(value))return 'evening';
  if(/半天|半日/.test(value))return 'half_day';
  return 'exact';

}

export const scheduledTaskSchema=z.strictObject({
  id:key,
  label:z.string().min(1).max(150),
  at:z.number().int().min(0),
  window:scheduleWindowSchema.default('exact'),
  end_at:z.number().int().min(0).optional(),
  duration_label:z.string().min(1).max(60).optional(),
  status:z.enum(['accepted','completed','cancelled']).default('accepted'),
  source:z.string().min(1).max(300),
  resolved:z.boolean().default(false),
});
export const routineMetaSchema=z.strictObject({version:z.literal(1),calendar_issue:z.string().max(1000).nullable(),scheduled_tasks:z.array(scheduledTaskSchema).max(100),migration_ids:z.array(z.string()).max(30)});
export type RoutinePlan=z.infer<typeof routinePlanSchema>;
export type ActivityRule=z.infer<typeof activityRuleSchema>;
export type Calendar=z.infer<typeof calendarSchema>;
export type ScheduledTask=z.infer<typeof scheduledTaskSchema>;

// Day 1 = 1月1日 周一, non-leap Gregorian month lengths. Used as the deterministic anchor for new worlds,
// so a normal new player never has to confirm a calendar years later.
export function defaultCalendar(source='framework default calendar anchor：第1天为1月1日周一，采用非闰年公历月长'):Calendar{
  return {version:1,anchor_day:1,anchor_month:1,anchor_date:1,anchor_weekday:1,month_lengths:[31,28,31,30,31,30,31,31,30,31,30,31],source};
}
