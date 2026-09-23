import { z } from 'zod';
import { assert } from '../core/schema.js';
import type { Module } from '../core/registry.js';
export const charactersModule: Module = {
  id: 'characters', version: '0.1.0', requires: ['core'],
  components: { character: { schema: z.strictObject({ role: z.string().max(200), traits: z.array(z.string().max(100)).max(10) }), project: d => d } },
  panels: [{ id: 'characters', label: '人物' }],
  actions: { TALK: { ui: { label: '交流', visibility: 'contextual', target_component: 'character', requires_text: true, text_parameter: 'topic' }, parameters: z.strictObject({ topic: z.string().min(1).max(2000) }), execute(c) {
    assert(c.action.target_id && c.action.target_id !== c.action.actor_id, '请选择另一位角色');
    c.store.component(c.action.target_id, 'character');
    assert(c.store.component<{ location_id: string }>(c.action.target_id, 'location').location_id === c.store.component<{ location_id: string }>(c.action.actor_id, 'location').location_id, '角色不在同一地点');
    c.advance(c.save.definition.ruleset.talk_minutes);
    c.facts.push(`与 ${c.store.component<{ name: string }>(c.action.target_id, 'identity').name} 交谈，话题：${c.action.parameters.topic}`);
  } }, SOCIAL_INTERACT: { ui: { label: '互动', visibility: 'internal', target_component: 'character', requires_text: true, text_parameter: 'intent' }, parameters: z.strictObject({ intent: z.string().min(1).max(2000) }), execute(c) {
    assert(c.action.target_id && c.action.target_id !== c.action.actor_id, '请选择另一位角色');
    c.store.component(c.action.target_id, 'character');
    assert(c.store.component<{ location_id: string }>(c.action.target_id, 'location').location_id === c.store.component<{ location_id: string }>(c.action.actor_id, 'location').location_id, '角色不在同一地点');
    c.advance(c.save.definition.ruleset.talk_minutes);
    c.facts.push(`与 ${c.store.component<{ name: string }>(c.action.target_id, 'identity').name} 进行互动：${c.action.parameters.intent}`);
  } } },
  prompt: '用稳定的 character_id 指代人物；只为当前在场 NPC 生成对白。Narrator 可在 context_actions 中给当前在场人物提供少量、贴合关系与场景的玩家可选互动建议；这些建议只是 UI affordance，不代表已经执行。不要重复已经注册的硬动作。涉及战斗、偷窃、跟踪等需要硬机制的行为，只有对应模块已经提供正式 action 时才作为硬动作；否则不要伪装成已支持。亲密建议必须符合世界年龄与同意边界；未成年人不得出现性行为建议。',
};
