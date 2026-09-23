import { z } from 'zod';
import { assert, id, integer } from '../core/schema.js';
import type { ActionContext, Module } from '../core/registry.js';

const routineSchema = z.strictObject({
  active: z.boolean(),
  label: z.string().min(1).max(120),
  pattern: z.string().min(1).max(3000),
  activities: z.array(id).max(20).default([]),
  chunk_minutes: integer.min(10).max(1440),
  elapsed_minutes: integer,
  cycles: integer,
  interrupted: z.boolean(),
  last_interrupt: z.string().max(500).nullable(),
});
type RoutineState = z.infer<typeof routineSchema>;

function readRoutine(ctx: ActionContext) {
  return ctx.store.entity(ctx.action.actor_id).components.routine as RoutineState | undefined;
}
function writeRoutine(ctx: ActionContext, value: RoutineState) { ctx.store.update(ctx.action.actor_id, 'routine', value); }

function runRoutine(ctx: ActionContext, maxMinutes: number) {
  let routine = readRoutine(ctx); assert(routine?.active, '当前没有正在运行的生活模式');
  let advanced = 0, steps = 0;
  while (advanced < maxMinutes && routine.active && steps < 1000) {
    const chunk = Math.min(routine.chunk_minutes, maxMinutes - advanced);
    ctx.advance(chunk); advanced += chunk; steps++;
    routine = readRoutine(ctx)!;
    routine = { ...routine, elapsed_minutes: routine.elapsed_minutes + chunk, cycles: routine.cycles + 1 };
    writeRoutine(ctx, routine);
  }
  assert(steps < 1000 || advanced >= maxMinutes || !routine.active, '生活模式单次推进步骤过多，请提高时间块大小');
  routine = readRoutine(ctx)!;
  if (routine.interrupted) { const reason=(routine.last_interrupt ?? '发生了需要处理的事情').replace(/[。！？!?]+$/,''); ctx.facts.push(`生活模式“${routine.label}”推进 ${advanced} 分钟后被打断：${reason}。`); }
  else ctx.facts.push(`生活模式“${routine.label}”已推进 ${advanced} 分钟；期间没有触发需要打断的事件，模式保持运行。`);
}

export const routineModule: Module = {
  id: 'routine', version: '0.1.0', requires: ['core'],
  components: { routine: { schema: routineSchema, project: d => d } },
  panels: [{ id: 'routine', label: '生活模式' }],
  actions: {
    START_ROUTINE: {
      ui: { label: '开始生活模式', visibility: 'text' },
      parameters: z.strictObject({
        label: z.string().min(1).max(120), pattern: z.string().min(1).max(3000), activities: z.array(id).max(20).default([]),
        chunk_minutes: integer.min(10).max(1440).default(60), max_minutes: integer.min(10).max(43200).default(43200),
      }),
      execute(c) {
        const p = c.action.parameters as unknown as { label:string;pattern:string;activities:string[];chunk_minutes:number;max_minutes:number };
        writeRoutine(c, { active:true, label:p.label, pattern:p.pattern, activities:p.activities, chunk_minutes:p.chunk_minutes, elapsed_minutes:0, cycles:0, interrupted:false, last_interrupt:null });
        c.facts.push(`开始生活模式“${p.label}”：${p.pattern}`);
        runRoutine(c, p.max_minutes);
      },
    },
    CONTINUE_ROUTINE: {
      ui: { label: '继续生活模式', visibility: 'text' },
      parameters: z.strictObject({ max_minutes: integer.min(10).max(43200).default(43200) }),
      execute(c) { runRoutine(c, Number(c.action.parameters.max_minutes)); },
    },
    CANCEL_ROUTINE: {
      ui: { label: '结束生活模式', visibility: 'text' }, parameters: z.strictObject({}), execute(c) {
        const routine = readRoutine(c); assert(routine, '当前没有生活模式');
        writeRoutine(c, { ...routine, active:false, interrupted:false, last_interrupt:null });
        c.facts.push(`结束生活模式“${routine.label}”。`);
      },
    },
  },
  handlers: {
    on_interrupt(c, event) {
      const routine = c.store.entity(c.action.actor_id).components.routine as RoutineState | undefined;
      if (!routine?.active) return;
      c.store.update(c.action.actor_id, 'routine', { ...routine, active:false, interrupted:true, last_interrupt:event.reason ?? '发生了需要处理的事情' });
    },
  },
  prompt: 'Routine 是通用时间压缩/重复生活机制。用户明确表示“重复这种生活直到有事打断”时，可用 START_ROUTINE；后续“继续”可用 CONTINUE_ROUTINE。Routine 只推进时间并触发所有程序 hook；具体上课、工作、训练收益应由对应世界模块监听 on_time_advance 等 hook 实现，不能凭叙事虚构机械收益。任何模块认为某事件值得玩家接管时，应发出 on_interrupt。',
};
