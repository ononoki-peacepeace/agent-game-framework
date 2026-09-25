import { z } from 'zod';

const jsonValue = z.json();

export const goalTargetSchema = z.strictObject({
  kind: z.enum(['entity', 'entity_query', 'location']),
  reference: z.string().min(1).max(240),
  entity_id: z.string().min(1).max(120).nullable().default(null),
});

export const desiredStateSchema = z.strictObject({
  path: z.string().min(1).max(160),
  value: jsonValue,
  target_ref: z.string().min(1).max(120).nullable().default(null),
});

export const desiredOutputSchema = z.strictObject({
  kind: z.enum(['state_change', 'media_asset', 'avatar_assignment', 'schedule', 'relationship', 'feature']),
  description: z.string().min(1).max(400),
});

/** Provider-neutral description of the outcome. It contains no tool or workflow choice. */
export const goalSpecSchema = z.strictObject({
  objective: z.string().min(1).max(600),
  targets: z.array(goalTargetSchema).max(20).default([]),
  desired_state: z.array(desiredStateSchema).max(20).default([]),
  desired_outputs: z.array(desiredOutputSchema).max(20).default([]),
  constraints: z.array(z.string().min(1).max(300)).max(20).default([]),
  persistence: z.enum(['none', 'session', 'canonical', 'recurring']),
  temporal: z.strictObject({
    at: z.string().max(200).nullable().default(null),
    recurrence: z.string().max(300).nullable().default(null),
  }).default({ at: null, recurrence: null }),
  dependencies: z.array(z.string().min(1).max(200)).max(20).default([]),
  world_mutation: z.boolean(),
  external_artifact: z.boolean(),
  multi_step: z.boolean(),
  ambiguity: z.strictObject({ question: z.string().min(1).max(400) }).nullable().default(null),
});

export type GoalSpec = z.infer<typeof goalSpecSchema>;

export const capabilityPlanStepSchema = z.strictObject({
  step_id: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  capability_id: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  input: z.record(z.string(), jsonValue).default({}),
  depends_on: z.array(z.string()).max(20).default([]),
});

export const capabilityPlanSchema = z.strictObject({
  goal: goalSpecSchema,
  steps: z.array(capabilityPlanStepSchema).min(1).max(30),
});

export type CapabilityPlan = z.infer<typeof capabilityPlanSchema>;
export type CapabilityPlanStep = z.infer<typeof capabilityPlanStepSchema>;

