import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sparseSetup } from './sparse-fixture.js';
import { handleAgentInput } from '../src/agent/executor.js';
import { validatePlan } from '../src/agent/planner.js';
import type { GoalInput } from '../src/agent/plan-schema.js';

const goal = (extra: Partial<GoalInput> & { goal_id: string; type: GoalInput['type'] }): GoalInput => ({
  normalized_goal: '测试目标', depends_on: [], condition: null, branch: null,
  temporal_scope: { scope: 'now', day_offset: 0, window: 'any' }, target_entities: [], ...extra,
});

/** Prompts authored for this test only: none of them appears anywhere in the framework or its fixtures. */
const blindPrompts = [
  '把窗台的灰掸一掸，顺便看看楼下有没有人。',
  '冲对面那桌使个眼色，让他先别说了。',
  '把桌上的糖块推到他手边。',
  '伸个懒腰，然后问问柜台后面的人今天忙不忙。',
  '蹲下来把掉在地上的纸片捡起来看看写了什么。',
  '去201看看有没有人，如果有的话就跟他聊聊天。',
];
const internalDiagnostics = /ZodError|result_ref|goal_id|from_goal_id|runtime_gap|needs_binding|capability_gap|PlanConversion|execution_availability|stepContract|运行时引用|Invalid|schema/i;

describe('interaction boundary: model-owned interaction, program-owned settlement', () => {
  it('keeps natural verbs out of the Action Registry and keeps strict settlement capabilities in it', async () => {
    const f = await sparseSetup();
    const types = new Set(((await f.service.view())!.actions).map(action => action.type));
    // Ordinary interaction is an Agent capability, not a registered action type.
    for (const verb of ['JOKE', 'COMFORT', 'WAVE', 'LOOK', 'LISTEN', 'THINK', 'ASK', 'SMILE', 'SIGH', 'CHAT', 'WATCH', 'OBSERVE', 'LOOK_AT_DOOR', 'WAIT_AND_SEE']) {
      expect(types.has(verb), `${verb} must not become an Action Type`).toBe(false);
    }
    // KNOCK exists, but only as a settlement action: it needs a canonical door that is explicitly knockable,
    // which is exactly the bar the boundary document sets for a registered action type.
    const knock = (await f.service.view())!.actions.find(action => action.type === 'KNOCK');
    if (knock) expect(knock.target_component).toBe('interactable');
    // What the registry does contain is the set of actions that must be settled by the program.
    for (const settled of ['MOVE', 'TALK', 'MOVE_ITEM', 'WAIT']) expect(types.has(settled), `${settled} missing`).toBe(true);
  });

  it('lets a later step reference an observation-producing goal, and still rejects a non-producing source', async () => {
    const plan = validatePlan({ goals: [
      goal({ goal_id: 'g1', type: 'WORLD_LOOKUP', normalized_goal: '看看房间里有没有人', operation_hint: 'presence_query' }),
      goal({ goal_id: 'g2', type: 'WORLD_SPEECH', normalized_goal: '跟遇到的人聊聊', depends_on: ['g1'],
        result_ref: { from_goal_id: 'g1', field: 'observed_entities', entity_kind: 'person' } }),
    ] });
    expect(plan.execution_order).toEqual(['g1', 'g2']);
    // A future plan produces no result in this input, so it can never be a runtime binding source.
    expect(() => validatePlan({ goals: [
      goal({ goal_id: 'f1', type: 'FUTURE_INTENT', normalized_goal: '明天去找人', temporal_scope: { scope: 'future', day_offset: 1, window: 'any' } }),
      goal({ goal_id: 'g2', type: 'WORLD_SPEECH', normalized_goal: '跟他聊聊', depends_on: ['f1'],
        result_ref: { from_goal_id: 'f1', field: 'responders', entity_kind: 'person' } }),
    ] })).toThrow();
  });

  it('re-plans once and never turns an internal plan failure into player feedback', async () => {
    const invalid = { goals: [goal({ goal_id: 'g1', type: 'WORLD_SPEECH', normalized_goal: '随口聊聊',
      result_ref: { from_goal_id: 'missing_goal', field: 'responders', entity_kind: 'person' } })] };
    const f = await sparseSetup(async request => {
      if ((request.schema as { properties?: Record<string, unknown> }).properties?.goals) return { data: invalid };
      throw new Error('unexpected AI call');
    });
    const before = await f.service.current();
    const result = await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input: '去201看看有没有人，如果有的话就跟他聊聊天。' }, undefined, null, false, { kind: 'world_action' } as never);
    // Exactly one corrective re-plan, and the corrective hint is only on the second attempt.
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].prompt).not.toContain('不要用运行时引用去绑定尚未产生的结果');
      expect(f.calls[1].prompt).toContain('"failure_stage":"plan_conversion"');
      expect(f.calls[1].prompt).toContain('"original_request":"去201看看有没有人，如果有的话就跟他聊聊天。"');
    // Player feedback stays natural; internal structure never reaches it.
    expect(String(result.message)).not.toMatch(internalDiagnostics);
    expect(result.presentation).toBe('failure');
    const after = await f.service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });

  it('keeps blind prompts free of internal diagnostics and free of phantom world changes', async () => {
    const invalid = { goals: [goal({ goal_id: 'g1', type: 'WORLD_ACTION', normalized_goal: '做点什么',
      result_ref: { from_goal_id: 'nowhere', field: 'targets', entity_kind: 'any' } })] };
    const f = await sparseSetup(async request => {
      if ((request.schema as { properties?: Record<string, unknown> }).properties?.goals) return { data: invalid };
      throw new Error('unexpected AI call');
    });
    for (const input of blindPrompts) {
      const before = await f.service.current();
      const result = await handleAgentInput(f.service, { request_id: randomUUID(), game_id: before.game_id, expected_revision: before.state_revision, input }, undefined, null, false, { kind: 'world_action' } as never);
      expect(String(result.message), input).not.toMatch(internalDiagnostics);
      expect(String(result.message).length, input).toBeGreaterThan(8);
      const after = await f.service.current();
      expect(after.state_revision, input).toBe(before.state_revision);
      expect(after.runtime.time, input).toEqual(before.runtime.time);
      expect(after.last_turn, input).toEqual(before.last_turn);
    }
  });
});
