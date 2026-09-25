import { z } from 'zod';
import { assert, dictionary, id, integer, text } from '../core/schema.js';
import type { Module } from '../core/registry.js';

export type SkillEntry = {
  name: string; level: number; xp: number; next_xp: number; aptitude_ref: string | null;
  tags: string[]; source?: string; note?: string;
};
export type Skills = { entries: Record<string, SkillEntry> };

export const skillsModule: Module = {
  id: 'skills', version: '0.1.0', requires: ['aptitudes'],
  manifest: { api_version:'1', provides:['character.skills'], state_ownership:['components.skills'], state_schema_version:'skills.v1', migration_version:1, supports_enable_disable:true, supports_remove:true },
  components: {
    skills: {
      schema: z.strictObject({ entries: dictionary(z.strictObject({
        name: z.string().min(1).max(120), level: integer.max(10000), xp: integer,
        next_xp: integer.min(1), aptitude_ref: id.nullable(), tags: z.array(id).max(30).default([]),
        source: text.optional(), note: text.optional(),
      })) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
  },
  panels: [{ id: 'skills', label: '技能', module: 'skills', order: 100, mobile_group: 'secondary', presentation_type: 'panel' }],
  validate(save) {
    for (const entity of save.entities) {
      const skills = entity.components.skills as Skills | undefined;
      const aptitudes = entity.components.aptitudes as { entries?: Record<string, unknown> } | undefined;
      for (const skill of Object.values(skills?.entries ?? {})) {
        assert(skill.xp < skill.next_xp, `技能 ${skill.name} 的 XP 必须小于下一级阈值；升级应由规则模块显式结算`);
        if (skill.aptitude_ref) assert(!!aptitudes?.entries?.[skill.aptitude_ref], `技能 ${skill.name} 引用了不存在的资质 ${skill.aptitude_ref}`);
      }
    }
  },
  prompt: 'skills 中 level/xp/next_xp 是 canonical 事实。Narrator 不得自行加经验或升级；成长必须由程序规则模块结算。',
};
