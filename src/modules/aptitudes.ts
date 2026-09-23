import { z } from 'zod';
import { dictionary, id, integer, text } from '../core/schema.js';
import type { Module } from '../core/registry.js';

export type AptitudeEntry = { name: string; value: number; tags: string[]; note?: string };
export type Aptitudes = { entries: Record<string, AptitudeEntry> };

export const aptitudesModule: Module = {
  id: 'aptitudes', version: '0.1.0', requires: ['core'],
  components: {
    aptitudes: {
      schema: z.strictObject({ entries: dictionary(z.strictObject({
        name: z.string().min(1).max(120), value: integer.max(10000),
        tags: z.array(id).max(30).default([]), note: text.optional(),
      })) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
  },
  panels: [{ id: 'aptitudes', label: '资质' }],
  prompt: 'aptitudes 表示长期适性/学习效率，不等于当前技能等级。',
};
