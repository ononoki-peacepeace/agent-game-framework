import { z } from 'zod';
import { dictionary } from '../core/schema.js';
import type { Module } from '../core/registry.js';

export type Attributes = { values: Record<string, number>; labels?: Record<string, string> };

export const attributesModule: Module = {
  id: 'attributes', version: '0.1.0', requires: ['core'],
  manifest: { api_version:'1', provides:['character.attributes'], state_ownership:['components.attributes'], state_schema_version:'attributes.v1', migration_version:1, supports_enable_disable:true, supports_remove:true },
  components: {
    attributes: {
      schema: z.strictObject({ values: dictionary(z.number().min(-1_000_000).max(1_000_000)), labels: dictionary(z.string().min(1).max(120)).default({}) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
  },
  panels: [{ id: 'attributes', label: '属性', module: 'attributes', order: 80, mobile_group: 'secondary', presentation_type: 'panel' }],
  prompt: 'attributes 是程序保存的角色属性事实；不得仅靠叙事修改。',
};
