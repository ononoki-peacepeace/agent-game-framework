import {routinePlanSchema} from '../routine/schema.js';
import { routineResultSchema, routineTime } from '../ai/routine.js';
import { z } from 'zod';
import { assert, id, integer } from '../core/schema.js';
import type { ActionContext, Module } from '../core/registry.js';

export const routineSchema = z.strictObject({
  plan: routinePlanSchema.optional(),
  block_progress:z.strictObject({key:z.string().max(120),minutes:integer.max(1440)}).optional(),
  completed_blocks: z.array(z.string().max(120)).max(300).optional(),
  active: z.boolean(),
  label: z.string().min(1).max(120),
  pattern: z.string().min(1).max(3000),
  // Natural-language source of the plan. Supplements are merged by content, never appended twice.
  supplements: z.array(z.string().min(1).max(1500)).max(20).default([]),
  pattern_revision: integer.max(10000).default(0),
  plan_revision: integer.max(10000).default(0),
  enabled: z.boolean().default(false),
  status: z.enum(['disabled','saved','armed','running','paused','interrupted']).default('saved'),
  armed_reason: z.string().max(300).nullable().default(null),
  activities: z.array(id).max(20).default([]),
  chunk_minutes: integer.min(10).max(1440),
  elapsed_minutes: integer,
  cycles: integer,
  interrupted: z.boolean(),
  last_interrupt: z.string().max(500).nullable(),
  history: z.array(z.strictObject({
    start:routineTime, end:routineTime, summary:z.string().min(1).max(2000),
    activities:routineResultSchema.shape.activities, patches:routineResultSchema.shape.patches,
    random_results:z.array(z.strictObject({id,reason:z.string().max(500),expression:z.string().max(30),rolls:z.array(integer),modifier:z.number().int(),total:z.number().int()})).max(4),
    interrupt:z.boolean(),interrupt_reason:z.string().max(500).nullable(),
  })).max(30).optional(),
  next_arrangement: z.string().max(500).nullable().optional(),
});
type RoutineState = z.infer<typeof routineSchema>;

function readRoutine(ctx: ActionContext) {
  return ctx.store.entity(ctx.action.actor_id).components.routine as RoutineState | undefined;
}
function writeRoutine(ctx: ActionContext, value: RoutineState) { ctx.store.update(ctx.action.actor_id, 'routine', value); }
// Merging supplements is what keeps repeated "补充原计划" submissions from stacking identical text.
function mergeSupplements(existing:string[],incoming:string){
  const list=[...existing];
  const text=incoming.trim().replace(/\s+/g,' ');
  if(text && !list.some(item=>item.trim().replace(/\s+/g,' ')===text))list.push(text);
  return list.slice(-20);
}
function routineSource(routine:RoutineState|null|undefined){
  const pattern=routine?.pattern?.trim()??'';
  const supplements=(routine?.supplements??[]).filter(item=>item.trim());
  return supplements.length?`${pattern}\n补充说明：${supplements.join('\n补充说明：')}`:pattern;
}
export const routineSourceOf=routineSource;

const routineDefaults={active:false,enabled:false,status:'saved',label:'未设置',pattern:'未设置',supplements:[],pattern_revision:0,plan_revision:0,armed_reason:null,activities:[],chunk_minutes:60,elapsed_minutes:0,cycles:0,interrupted:false,last_interrupt:null};
export const routineModule: Module = {
  id: 'routine', version: '0.1.0', requires: ['core'],
  manifest: { api_version:'1', provides:['routine.scheduler','routine.plan'], state_ownership:['components.routine','routine_meta','definition.routine_rules'], state_schema_version:'routine.v1', migration_version:1, supports_enable_disable:true, supports_remove:true, setup(save){const player=save.entities.find(e=>e.id===save.player_state.entity_id),initial=save.definition.entities.find(e=>e.id===save.player_state.entity_id);if(player&&!player.components.routine)player.components.routine=structuredClone(routineDefaults);if(initial&&!initial.components.routine)initial.components.routine=structuredClone(routineDefaults);} },
  components: { condition: { schema:z.strictObject({hp:integer.max(100),stamina:integer.max(100),stress:integer.max(100)}), project:d=>d }, routine: { schema: routineSchema, project: d => d } },
  panels: [{ id: 'routine', label: '生活模式', module: 'routine', order: 120, mobile_group: 'secondary', presentation_type: 'panel' }],
  actions: {
    CLEAR_ROUTINE: {
      ui:{label:'清除生活计划',visibility:'panel'},parameters:z.strictObject({}),execute(c){const current=readRoutine(c);assert(current,'尚未设置生活模式');const {plan,...kept}=current;writeRoutine(c,{...kept,pattern:'未设置',label:'未设置',supplements:[],active:false,enabled:false,status:'saved',interrupted:false,last_interrupt:null,armed_reason:null});c.facts.push('生活计划已清除，既有生活历史仍保留。');},
    },
    START_ROUTINE: {
      ui: { label: '启用生活模式', visibility: 'text' },
      parameters: z.strictObject({
        label: z.string().min(1).max(120), pattern: z.string().min(1).max(3000), activities: z.array(id).max(20).default([]),
        chunk_minutes: integer.min(10).max(1440).default(60), max_minutes: integer.min(1).max(43200).default(43200),
        supplement: z.string().max(1500).optional(),
      }),
      execute(c) {
        const p = c.action.parameters as unknown as { label:string;pattern:string;activities:string[];chunk_minutes:number;max_minutes:number;supplement?:string };
        const current = readRoutine(c), pattern = p.pattern.trim();
        const supplements = mergeSupplements(current?.supplements??[], p.supplement??'');
        const patternChanged = !current || current.pattern !== pattern || supplements.length !== (current.supplements??[]).length;
        writeRoutine(c, {
          ...(current?.history?{history:current.history}:{}),
          ...(patternChanged?{}:{...(current?.plan?{plan:current.plan}:{})}),
          ...(current?.completed_blocks?{completed_blocks:current.completed_blocks}:{}),
          ...(current?.next_arrangement?{next_arrangement:current.next_arrangement}:{}),
          active:true, enabled:true, status:'armed', label:p.label, pattern, supplements,
          pattern_revision:Number(current?.pattern_revision??0)+(patternChanged?1:0),
          plan_revision:Number(current?.plan_revision??0),
          armed_reason:null,
          activities:p.activities, chunk_minutes:p.chunk_minutes,
          elapsed_minutes:Number(current?.elapsed_minutes??0), cycles:Number(current?.cycles??0),
          interrupted:false, last_interrupt:null,
        });
        c.facts.push(`启用生活模式“${p.label}”，计划已保存；将在安全交接点后由后台接管推进。`);
        // Compilation, safe handoff and settlement are performed by the Routine job, never inline.
      },
    },
    SAVE_ROUTINE: {
      ui: { label: '保存生活计划', visibility: 'text' },
      parameters: z.strictObject({ label: z.string().min(1).max(120), pattern: z.string().min(1).max(3000), supplement: z.string().max(1500).optional() }),
      execute(c) {
        const p = c.action.parameters as unknown as { label:string;pattern:string;supplement?:string };
        const current = readRoutine(c), pattern = p.pattern.trim();
        const supplements = mergeSupplements(current?.supplements??[], p.supplement??'');
        const patternChanged = !current || current.pattern !== pattern || supplements.length !== (current.supplements??[]).length;
        writeRoutine(c, {
          ...(current?.history?{history:current.history}:{}),
          ...(current?.completed_blocks?{completed_blocks:current.completed_blocks}:{}),
          ...(patternChanged?{}:{...(current?.plan?{plan:current.plan}:{})}),
          active:false, enabled:false, status:'saved', label:p.label, pattern, supplements,
          pattern_revision:Number(current?.pattern_revision??0)+(patternChanged?1:0),
          plan_revision:Number(current?.plan_revision??0), armed_reason:null,
          activities:current?.activities??[], chunk_minutes:current?.chunk_minutes??60,
          elapsed_minutes:Number(current?.elapsed_minutes??0), cycles:Number(current?.cycles??0),
          interrupted:false, last_interrupt:null,
        });
        c.facts.push(`已保存生活计划“${p.label}”（未启用）。`);
      },
    },
    PAUSE_ROUTINE: {
      ui: { label: '安全暂停', visibility: 'text' }, parameters: z.strictObject({}), execute(c) {
        const routine = readRoutine(c); assert(routine, '当前没有生活计划');
        writeRoutine(c, { ...routine, active:false, enabled:true, status:'paused', interrupted:false, armed_reason:null });
        c.facts.push('生活模式已安全暂停。');
      },
    },
    CONTINUE_ROUTINE: {
      ui: { label: '继续生活模式', visibility: 'text' },
      parameters: z.strictObject({ max_minutes: integer.min(1).max(43200).default(43200) }),
      execute(c) { const r = readRoutine(c); assert(r && r.label !== '未设置', '请先设置生活模式'); writeRoutine(c, {...r, active:true, enabled:true, status:'armed', interrupted:false, last_interrupt:null, armed_reason:null}); },
    },
    CANCEL_ROUTINE: {
      ui: { label: '停用生活模式', visibility: 'text' }, parameters: z.strictObject({}), execute(c) {
        const routine = readRoutine(c); assert(routine, '当前没有生活模式');
        writeRoutine(c, { ...routine, active:false, enabled:false, status:'disabled', interrupted:false, last_interrupt:null, armed_reason:null });
        c.facts.push('已停用生活模式，计划仍保留。');
      },
    },
  },
  handlers: {
    on_interrupt(c, event) {
      const routine = c.store.entity(c.action.actor_id).components.routine as RoutineState | undefined;
      if (!routine?.active) return;
      c.store.update(c.action.actor_id, 'routine', { ...routine, active:false, interrupted:true, status:'interrupted', last_interrupt:event.reason ?? '发生了需要你处理的事情' });
    },
  },
  prompt: 'START_ROUTINE 启用（并保存）玩家的重复生活规则，SAVE_ROUTINE 只保存不启用，PAUSE_ROUTINE 安全暂停，CONTINUE_ROUTINE 在安全交接点后继续，CANCEL_ROUTINE 停用但保留计划。生活模式是可选的：没有计划的玩家照常一回合推进。Routine GM 可提出普通课程、训练、工作、社交、休息等结构化结果，由 Framework 校验结算；重要事件立即暂停，不替玩家选择。禁止自行编造正式随机结果。',
};
