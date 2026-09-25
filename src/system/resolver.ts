import { randomUUID } from 'node:crypto';
import type { GameService } from '../server/service.js';
import type { PublicView, Entity } from '../shared/contracts.js';
import { publicView } from '../core/state.js';
import { resolveEntities, entityLabel } from '../agent/entities.js';
import { capabilityPlanSchema, type CapabilityPlan, type GoalSpec } from './goals.js';
import { capabilityRegistry, validateCapabilityPlan, type CapabilityRegistry } from './capabilities.js';

export type UniversalResolution =
  | { handled: false }
  | { handled: true; kind: 'EXECUTED'; goal: GoalSpec; plan: CapabilityPlan; message: string; view: PublicView }
  | { handled: true; kind: 'USER_AMBIGUITY'; goal: GoalSpec | null; question: string; candidates: string[] }
  | { handled: true; kind: 'CAPABILITY_GAP'; goal: GoalSpec; plan: CapabilityPlan; missing: string[]; message: string }
  | { handled: true; kind: 'EXECUTION_FAILURE'; goal: GoalSpec; plan: CapabilityPlan; message: string; retryable: boolean };

export interface UniversalRequestEnvelope { request_id?: string; expected_revision?: number }
export interface ExecuteOptions {
  registry?: CapabilityRegistry;
  executeExternal?: (step: CapabilityPlan['steps'][number]) => Promise<unknown>;
}

const featureWish = /(?:想|希望|需要|请)(?:加|增加|新增|开发|做)(?:一个|个|套|种)?.{0,30}(?:系统|玩法|功能|面板|页面|机制|模块)/;
const stateMutation = /(?:改成|改为|设置为|换成|设成|重命名|改名)/;
const mediaOutcome = /(?:生成|制作|画|绘制).{0,20}(?:图|头像|立绘)|(?:图|头像|立绘).{0,20}(?:生成|制作|画|绘制)/;
const recurringOutcome = /(?:每周|每天|每日|每月|周[一二三四五六日天]).{0,30}(?:去|到|在|上课|开会|工作|活动)/;

/** This gate only identifies outcome-shaped requests; it never selects or executes a capability. */
export function isUniversalGoalCandidate(text: string) {
  if (featureWish.test(text)) return false;
  return stateMutation.test(text) || mediaOutcome.test(text) || recurringOutcome.test(text) || /把她改一下|把他改一下/.test(text);
}

const clean = (value: string) => value.trim().replace(/[。！？!?]+$/, '').replace(/^[“"'「]|[”"'」]$/g, '').trim();
const baseGoal = (text: string, overrides: Partial<GoalSpec>): GoalSpec => ({
  objective: text, targets: [], desired_state: [], desired_outputs: [], constraints: [], persistence: 'canonical',
  temporal: { at: null, recurrence: null }, dependencies: [], world_mutation: true, external_artifact: false,
  multi_step: false, ambiguity: null, ...overrides,
});

/** Offline extraction still produces a provider-neutral goal. Composition remains a separate step. */
export function deterministicGoal(text: string): GoalSpec | null {
  const rename = text.match(/(?:把|将)?(.+?)(?:的)?(?:名字|姓名)(?:改成|改为|设置为|换成|设成)\s*(.+)$/)
    ?? text.match(/(?:把|将)?(.+?)(?:改名为|重命名为)\s*(.+)$/);
  if (rename) {
    const reference = clean(rename[1]).replace(/^把|^将/, '') || '我', name = clean(rename[2]);
    if (!name) return baseGoal(text, { ambiguity: { question: '要把名字改成什么？' } });
    return baseGoal(text, {
      targets: [{ kind: 'entity', reference, entity_id: null }],
      desired_state: [{ path: 'identity.name', value: name, target_ref: 'target' }],
      desired_outputs: [{ kind: 'state_change', description: '目标人物名称发生 canonical 变更' }], multi_step: true,
    });
  }
  if (mediaOutcome.test(text)) {
    const reference = clean(text.replace(/^(?:给|为)/, '').split(/(?:生成|制作|画|绘制)/)[0] || '我');
    return baseGoal(text, { targets: [{ kind: 'entity', reference, entity_id: null }], desired_outputs: [{ kind: 'media_asset', description: '生成图片资源' }, { kind: 'avatar_assignment', description: '将资源设置为同一人物头像' }], external_artifact: true, multi_step: true });
  }
  if (recurringOutcome.test(text)) {
    const target = text.match(/(?:让|请)(.+?)(?:每周|每天|每日|每月|周[一二三四五六日天])/)?.[1]?.trim() ?? '';
    const location = text.match(/(?:去|到|在)([^，。,.]{1,30})(?:开会|上课|工作|活动)/)?.[1]?.trim() ?? '';
    const recurrence = text.match(/(?:每周|每天|每日|每月|周[一二三四五六日天])[^，。,.]{0,20}/)?.[0] ?? '';
    return baseGoal(text, { targets: [{ kind: 'entity_query', reference: target || '未明确的人群', entity_id: null }, ...(location ? [{ kind: 'location' as const, reference: location, entity_id: null }] : [])], desired_outputs: [{ kind: 'schedule', description: '为匹配人物设置重复安排' }], persistence: 'recurring', temporal: { at: null, recurrence: recurrence || null }, multi_step: true, ambiguity: target ? null : { question: '要为哪些人物设置这个安排？' } });
  }
  if (/把她改一下|把他改一下/.test(text)) return baseGoal(text, { ambiguity: { question: '你想修改哪位人物的什么内容？' } });
  return null;
}

/** Compose by desired outcomes/state paths. Text wording is never used to choose a capability. */
export function composeCapabilityPlan(goal: GoalSpec): CapabilityPlan | null {
  if (goal.ambiguity) return { goal, steps: [{ step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] }] };
  const identityName = goal.desired_state.find(item => item.path === 'identity.name');
  if (identityName) return { goal, steps: [
    { step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] },
    { step_id: 'rename_target', capability_id: 'entity.identity.rename', input: { name: identityName.value }, depends_on: ['resolve_target'] },
  ] };
  if (goal.desired_outputs.some(item => item.kind === 'media_asset') && goal.desired_outputs.some(item => item.kind === 'avatar_assignment')) return { goal, steps: [
    { step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] },
    { step_id: 'generate_image', capability_id: 'media.image.generate', input: { kind: 'avatar', description: goal.objective }, depends_on: ['resolve_target'] },
    { step_id: 'persist_asset', capability_id: 'asset.persist', input: {}, depends_on: ['generate_image'] },
    { step_id: 'assign_avatar', capability_id: 'character.avatar.assign', input: {}, depends_on: ['resolve_target', 'persist_asset'] },
  ] };
  if (goal.desired_outputs.some(item => item.kind === 'schedule')) {
    const location = goal.targets.find(item => item.kind === 'location');
    return { goal, steps: [
      { step_id: 'resolve_targets', capability_id: 'entity.query', input: { query: goal.targets.find(item => item.kind === 'entity_query')?.reference ?? '' }, depends_on: [] },
      ...(location ? [{ step_id: 'resolve_location', capability_id: 'location.resolve', input: { reference: location.reference }, depends_on: [] }] : []),
      { step_id: 'assign_schedule', capability_id: 'routine.schedule.assign', input: { recurrence: goal.temporal.recurrence }, depends_on: location ? ['resolve_targets', 'resolve_location'] : ['resolve_targets'] },
    ] };
  }
  return null;
}

function targetEntity(view: PublicView, plan: CapabilityPlan): { entity: Entity | null; candidates: Entity[] } {
  const target = plan.goal.targets.find(item => item.kind === 'entity');
  if (!target) return { entity: null, candidates: [] };
  if (target.entity_id) return { entity: view.entities.find(entity => entity.id === target.entity_id) ?? null, candidates: [] };
  if (/^(我|我自己|自己|我的)$/.test(target.reference)) return { entity: view.entities.find(entity => entity.id === view.player_id) ?? null, candidates: [] };
  const resolved = resolveEntities(view, target.reference);
  return { entity: resolved.confident ? resolved.matches[0] ?? null : null, candidates: resolved.matches };
}

/** Preflight completes before any side effect. Canonical writes then share one receipt/revision transaction. */
export async function executeUniversalPlan(service: GameService, plan: CapabilityPlan, envelope: UniversalRequestEnvelope = {}, options: ExecuteOptions = {}): Promise<UniversalResolution> {
  const save = await service.current(), view = publicView(save);
  if (plan.goal.ambiguity) return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: plan.goal.ambiguity.question, candidates: [] };
  const validation = validateCapabilityPlan(plan, view, options.registry ?? capabilityRegistry);
  if (!validation.ok) return validation.kind === 'CAPABILITY_GAP'
    ? { handled: true, kind: 'CAPABILITY_GAP', goal: plan.goal, plan, missing: validation.missing, message: '当前能力还不能完整完成这个目标。可以先补齐缺少的能力，再由你明确决定是否创建开发任务。' }
    : { handled: true, kind: 'EXECUTION_FAILURE', goal: plan.goal, plan, message: '这次计划没有通过执行前校验，世界状态没有改变。请重新描述目标后再试。', retryable: false };
  const resolved = targetEntity(view, plan);
  if (plan.goal.targets.some(item => item.kind === 'entity') && !resolved.entity) {
    return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: resolved.candidates.length ? '有多个人物符合这个称呼，请指定是哪一位。' : '我还不能确定要修改哪位人物，请说出人物名字。', candidates: resolved.candidates.map(entityLabel) };
  }
  try {
    for (const step of validation.ordered) if (!['entity.lookup', 'entity.query', 'entity.identity.rename'].includes(step.capability_id)) {
      if (!options.executeExternal) throw new Error('capability executor unavailable');
      await options.executeExternal(step);
    }
    const rename = validation.ordered.find(step => step.capability_id === 'entity.identity.rename');
    if (rename && resolved.entity) {
      const name = String(rename.input.name ?? plan.goal.desired_state.find(item => item.path === 'identity.name')?.value ?? '').trim();
      if (!name) return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: '要把名字改成什么？', candidates: [] };
      const request = { game_id: save.game_id, expected_revision: envelope.expected_revision ?? save.state_revision, request_id: envelope.request_id ?? randomUUID() };
      const next = await service.agentTransaction(request, { kind: 'capability_plan', objective: plan.goal.objective, steps: plan.steps.map(step => ({ step_id: step.step_id, capability_id: step.capability_id, input: step.input })) }, draft => {
        const entity = draft.entities.find(item => item.id === resolved.entity!.id);
        if (!entity?.components.identity) throw new Error('目标人物没有可修改的身份资料');
        entity.components.identity.name = name;
      });
      return { handled: true, kind: 'EXECUTED', goal: plan.goal, plan, message: `已将${entityLabel(resolved.entity)}的名字改为「${name}」。`, view: next };
    }
    throw new Error('plan completed without a canonical outcome');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { handled: true, kind: 'EXECUTION_FAILURE', goal: plan.goal, plan, message: '执行时遇到问题，世界状态没有按这次目标继续写入。请稍后重试。', retryable: /timeout|timed out|fetch|network|状态已更新/i.test(reason) };
  }
}

export async function resolveUniversalGoal(service: GameService, text: string, envelope: UniversalRequestEnvelope = {}): Promise<UniversalResolution> {
  if (!isUniversalGoalCandidate(text)) return { handled: false };
  const save = await service.current(), view = publicView(save);
  const planned = await service.ai.systemAgent(capabilityPlanSchema, save.definition.prompt_profile, {
    instruction: '把请求表示为 provider-neutral GoalSpec，并从 capability_catalog 组合最小有向无环计划。不要发明 capability id。目标不明确时填写 goal.ambiguity；缺能力也保留完整计划，由程序判断 availability。功能开发愿望不属于这里。名字值只是字符串，不推断现实身份。',
    player_request: text,
    public_entities: view.entities.map(entity => ({ id: entity.id, name: entity.components.identity?.name ?? null, type: entity.type, role: entity.components.character?.role ?? null })),
    public_locations: view.locations.map(location => ({ id: location.id, name: location.name })),
    capability_catalog: capabilityRegistry.digest(view.capabilities),
  }, save);
  const goal = planned?.goal ?? deterministicGoal(text);
  const selected = planned ?? (goal ? composeCapabilityPlan(goal) : null);
  if (!selected) return { handled: false };
  return executeUniversalPlan(service, selected, envelope);
}
