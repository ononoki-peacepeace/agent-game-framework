import { z } from 'zod';
import { dictionary, id, text } from '../core/schema.js';
import type { Module } from '../core/registry.js';

export type TraitEntry = { name: string; type: string; status: string; effects: string[]; tags: string[]; source?: string; note?: string };
export type Traits = { entries: Record<string, TraitEntry> };

export const traitsModule: Module = {
  id: 'traits', version: '0.1.0', requires: ['core'],
  manifest: { api_version:'1', provides:['character.traits'], state_ownership:['components.traits'], state_schema_version:'traits.v1', migration_version:1, supports_enable_disable:true, supports_remove:true },
  components: {
    traits: {
      schema: z.strictObject({ entries: dictionary(z.strictObject({
        name: z.string().min(1).max(120), type: z.string().min(1).max(80), status: z.string().min(1).max(80),
        effects: z.array(text).max(30), tags: z.array(id).max(30).default([]), source: text.optional(), note: text.optional(),
      })) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
  },
  panels: [{ id: 'traits', label: '特质', module: 'traits', order: 110, mobile_group: 'secondary', presentation_type: 'panel' }],
  prompt: 'traits 是持续特征或状态标签；只有规则明确授权时才改变，不因叙事便利临时添加或移除。',
};
