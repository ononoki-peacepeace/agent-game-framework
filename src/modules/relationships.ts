import { z } from 'zod';
import { assert, dictionary } from '../core/schema.js';
import type { Module } from '../core/registry.js';
type Relations = { entries: Record<string, Record<string, number>> };
export const relationshipsModule: Module = {
  id: 'relationships', version: '0.1.0', requires: ['characters'],
  manifest: { api_version:'1', provides:['relationship.graph'], state_ownership:['components.relationships'], state_schema_version:'relationships.v1', migration_version:1, supports_enable_disable:false, supports_remove:false },
  components: { relationships: { schema: z.strictObject({ entries: dictionary(dictionary(z.number().int())) }), project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined } },
  panels: [{ id: 'relationships', label: '关系', module: 'relationships', order: 50, mobile_group: 'secondary', presentation_type: 'panel' }],
  validate(save) {
    const dims = save.definition.ruleset.relationship_dimensions;
    for (const [name, d] of Object.entries(dims)) assert(d.min <= d.initial && d.initial <= d.max, `关系维度 ${name} 范围无效`);
    for (const e of save.entities) {
      const rel = e.components.relationships as Relations | undefined;
      for (const [target, values] of Object.entries(rel?.entries ?? {})) {
        assert(save.entities.some(x => x.id === target && x.components.character), '关系对象不存在');
        for (const [name, value] of Object.entries(values)) assert(dims[name] && value >= dims[name].min && value <= dims[name].max, '关系值超出规则范围');
      }
    }
  },
  patches: { relationship_delta(save, patch, action) {
    assert(['TALK','SOCIAL_INTERACT','FREEFORM_ACTION'].includes(action.type) && action.actor_id === patch.entity_id && action.target_id === patch.target_id, '只允许更新本次人物互动的玩家关系');
    assert(Number.isInteger(patch.delta) && Math.abs(patch.delta) <= 2, '单回合关系变化最多 2');
    const d = save.definition.ruleset.relationship_dimensions[patch.dimension];
    assert(d, '未知关系维度');
    const entity = save.entities.find(e => e.id === patch.entity_id)!;
    const rel = entity.components.relationships as Relations | undefined;
    assert(rel, '角色没有关系组件');
    rel.entries[patch.target_id] ??= {};
    const next = (rel.entries[patch.target_id][patch.dimension] ?? d.initial) + patch.delta;
    assert(next >= d.min && next <= d.max, '关系变化越界');
    rel.entries[patch.target_id][patch.dimension] = next;
  } },
};
