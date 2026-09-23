import { z } from 'zod';
import { dictionary, id, integer, text } from '../core/schema.js';
import type { Module } from '../core/registry.js';

const deadlineSchema = z.strictObject({ day: integer, minute: integer }).nullable();
const recordSchema = z.strictObject({
  title: z.string().min(1).max(200), status: z.string().min(1).max(100), summary: text,
  objectives: z.array(text).max(50).default([]), deadline: deadlineSchema.default(null),
  source: text.optional(), tags: z.array(id).max(30).default([]), metadata: z.record(z.string(), z.json()).default({}),
});
export type QuestRecord = z.infer<typeof recordSchema>;
export type QuestBook = { entries: Record<string, QuestRecord> };

export const questsModule: Module = {
  id: 'quests', version: '0.1.0', requires: ['core'],
  components: {
    quests: {
      schema: z.strictObject({ entries: dictionary(recordSchema) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
    opportunities: {
      schema: z.strictObject({ entries: dictionary(recordSchema) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
  },
  panels: [{ id: 'quests', label: '任务' }],
  prompt: 'quests/opportunities 保存任务与机会的 canonical 状态。不要因玩家提到一个计划就自动把它设为已接受/已完成。',
};
