import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { capabilityRegistry } from './capabilities.js';
import { capabilityPlanSchema, goalSpecSchema, type CapabilityPlan, type GoalSpec } from './goals.js';

export const suspendedGoalStatusSchema = z.enum([
  'waiting_for_auto_extension', 'waiting_for_user_approval', 'waiting_for_external_prerequisite',
  'developing', 'validating', 'installed_ready_to_resume', 'resuming', 'completed', 'failed', 'cancelled',
]);

const suspendedGoalSchema = z.strictObject({
  goal_id: z.string().uuid(), request_id: z.string().uuid(), game_id: z.string().uuid(),
  original_input: z.string().min(1).max(12000), goal: goalSpecSchema, plan: capabilityPlanSchema,
  missing_capabilities: z.array(z.string()).max(50),
  entity_refs: z.array(z.strictObject({ kind: z.string(), reference: z.string(), entity_id: z.string().nullable() })).max(50),
  originating_surface: z.enum(['world', 'system']), created_revision: z.number().int().nonnegative(),
  external_prerequisites: z.array(z.string()).max(50), development_task_id: z.string().uuid().nullable(),
  status: suspendedGoalStatusSchema,
  resume: z.strictObject({ attempts: z.number().int().nonnegative(), last_operation_id: z.string().nullable(), last_error: z.string().nullable(), completed_revision: z.number().int().nonnegative().nullable() }),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
});

const suspendedGoalFileSchema = z.strictObject({ version: z.literal(1), goals: z.array(suspendedGoalSchema) });
export type SuspendedGoal = z.infer<typeof suspendedGoalSchema>;

export interface SuspendGoalInput {
  request_id: string; game_id: string; original_input: string; goal: GoalSpec; plan: CapabilityPlan;
  missing_capabilities: string[]; originating_surface: 'world' | 'system'; created_revision: number;
  installed_capabilities: string[];
}

/** Orchestration state lives beside saves, not inside canonical world state or exported save packages. */
export class SuspendedGoalStore {
  private readonly goals = new Map<string, SuspendedGoal>();
  private readonly requestReceipts = new Map<string, string>();
  private readonly file: string | null;
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory?: string) { this.file = directory ? join(directory, 'suspended-goals.json') : null; this.ready = this.load(); }
  private async load() {
    if (!this.file) return;
    try {
      const parsed = suspendedGoalFileSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      for (const goal of parsed.goals) { this.goals.set(goal.goal_id, goal); this.requestReceipts.set(goal.request_id, goal.goal_id); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async persist() {
    if (!this.file) return;
    const file = this.file;
    const snapshot = suspendedGoalFileSchema.parse({ version: 1, goals: [...this.goals.values()] });
    const write = async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx');
        try { await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
      } finally { await unlink(temp).catch(() => undefined); }
    };
    this.writeQueue = this.writeQueue.then(write, write); await this.writeQueue;
  }
  private classification(input: SuspendGoalInput) {
    const assessment = capabilityRegistry.assess(input.missing_capabilities, input.installed_capabilities);
    return { external_prerequisites: assessment.external_prerequisites, status: assessment.external_prerequisites.length ? 'waiting_for_external_prerequisite' as const : 'waiting_for_auto_extension' as const };
  }
  async suspend(input: SuspendGoalInput): Promise<SuspendedGoal> {
    await this.ready;
    const existingId = this.requestReceipts.get(input.request_id); if (existingId) return structuredClone(this.goals.get(existingId)!);
    const now = new Date().toISOString(), classification = this.classification(input);
    const goal = suspendedGoalSchema.parse({
      goal_id: randomUUID(), request_id: input.request_id, game_id: input.game_id, original_input: input.original_input,
      goal: input.goal, plan: input.plan, missing_capabilities: [...new Set(input.missing_capabilities)],
      entity_refs: input.goal.targets.map(target => ({ kind: target.kind, reference: target.reference, entity_id: target.entity_id })),
      originating_surface: input.originating_surface, created_revision: input.created_revision,
      external_prerequisites: classification.external_prerequisites, development_task_id: null, status: classification.status,
      resume: { attempts: 0, last_operation_id: null, last_error: null, completed_revision: null }, created_at: now, updated_at: now,
    });
    this.goals.set(goal.goal_id, goal); this.requestReceipts.set(goal.request_id, goal.goal_id); await this.persist(); return structuredClone(goal);
  }
  async list(gameId?: string) { await this.ready; return [...this.goals.values()].filter(goal => !gameId || goal.game_id === gameId).map(goal => structuredClone(goal)); }
  async get(goalId: string) { await this.ready; const goal = this.goals.get(goalId); return goal ? structuredClone(goal) : null; }
  async attachDevelopmentTask(goalId: string, taskId: string) {
    await this.ready;
    const goal = this.goals.get(goalId); if (!goal) throw new Error('挂起目标不存在');
    if (goal.development_task_id && goal.development_task_id !== taskId) throw new Error('挂起目标已绑定另一个开发任务');
    goal.development_task_id = taskId; goal.status = 'developing'; goal.updated_at = new Date().toISOString();
    await this.persist(); return structuredClone(goal);
  }
  async forDevelopmentTask(taskId: string) { await this.ready; return [...this.goals.values()].filter(goal => goal.development_task_id === taskId).map(goal => structuredClone(goal)); }
  async markInstalledReady(goalId: string) { return this.transition(goalId, 'installed_ready_to_resume'); }
  async beginResume(goalId: string, operationId: string) {
    await this.ready; const goal = this.goals.get(goalId); if (!goal) throw new Error('挂起目标不存在');
    if (goal.status === 'completed') return structuredClone(goal);
    goal.status = 'resuming'; goal.resume.attempts++; goal.resume.last_operation_id = operationId; goal.resume.last_error = null; goal.updated_at = new Date().toISOString();
    await this.persist(); return structuredClone(goal);
  }
  async completeResume(goalId: string, revision: number) {
    await this.ready; const goal = this.goals.get(goalId); if (!goal) throw new Error('挂起目标不存在');
    goal.status = 'completed'; goal.resume.completed_revision = revision; goal.resume.last_error = null; goal.updated_at = new Date().toISOString(); await this.persist(); return structuredClone(goal);
  }
  async failResume(goalId: string, error: string) {
    await this.ready; const goal = this.goals.get(goalId); if (!goal) throw new Error('挂起目标不存在');
    goal.status = 'failed'; goal.resume.last_error = error.slice(0, 1000); goal.updated_at = new Date().toISOString(); await this.persist(); return structuredClone(goal);
  }
  private async transition(goalId: string, status: SuspendedGoal['status']) {
    await this.ready; const goal = this.goals.get(goalId); if (!goal) throw new Error('挂起目标不存在');
    goal.status = status; goal.updated_at = new Date().toISOString(); await this.persist(); return structuredClone(goal);
  }
}
