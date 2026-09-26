import { z } from 'zod';

export const changeTypeValues = [
  'CONTENT_CHANGE', 'CONFIGURATION_CHANGE', 'STATE_EXTENSION', 'RULE_EXTENSION',
  'BEHAVIOR_CHANGE', 'CAPABILITY_EXTENSION', 'PROVIDER_INTEGRATION', 'UI_SURFACE_CHANGE',
  'WORKFLOW_CHANGE', 'AGENT_PLANNING_CHANGE', 'QUERY_AWARENESS_EXTENSION',
  'DATA_MODEL_CHANGE', 'CORE_EVOLUTION', 'NOVEL_CHANGE_DISCOVERY',
] as const;
export const changeTypeSchema = z.enum(changeTypeValues);
export type ChangeType = z.infer<typeof changeTypeSchema>;

export const changeLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type ChangeLevel = z.infer<typeof changeLevelSchema>;

export const changeRequestSchema = z.strictObject({
  request_id: z.string().min(1), original_input: z.string().min(1).max(12000),
  goal_summary: z.string().min(1).max(1000), desired_outcomes: z.array(z.string().max(600)).min(1).max(12),
  target_layers: z.array(z.string().max(80)).max(20), known_context: z.record(z.string(), z.unknown()).default({}),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const changeClassificationSchema = z.strictObject({
  primary_type: changeTypeSchema, recipe_types: z.array(changeTypeSchema).min(1), level: changeLevelSchema,
  confidence: z.number().min(0).max(1), reasons: z.array(z.string().max(500)).min(1),
  novel_reason: z.string().max(1000).nullable(),
});
export type ChangeClassification = z.infer<typeof changeClassificationSchema>;

export const recipeSchema = z.strictObject({
  recipe_id: z.string().regex(/^[a-z][a-z0-9_.-]{2,100}$/), version: z.string().regex(/^\d+\.\d+\.\d+$/), type: changeTypeSchema,
  applicable_when: z.array(z.string()).min(1), not_applicable_when: z.array(z.string()).min(1),
  required_context: z.array(z.string()), required_analysis: z.array(z.string()).min(1),
  preferred_mechanism: z.enum(['content', 'configuration', 'composition', 'extension', 'core']),
  allowed_tools: z.array(z.string()), forbidden_actions: z.array(z.string()).min(1),
  state_boundary: z.string().min(1), permission_boundary: z.string().min(1),
  implementation_steps: z.array(z.string()).min(1), validation_gates: z.array(z.string()).min(1),
  rollback_policy: z.string().min(1), completion_criteria: z.array(z.string()).min(1), fallback: z.string().min(1),
});
export type Recipe = z.infer<typeof recipeSchema>;

export const temporaryRecipeSchema = recipeSchema.extend({
  temporary: z.literal(true), discovery: z.strictObject({
    desired_experience: z.string(), coverage_gap: z.string(), affected_layers: z.array(z.string()).min(1),
    reusable_primitives: z.array(z.string()), new_primitives: z.array(z.string()), minimum_boundary: z.string(),
    reusable_candidate: z.boolean(),
  }),
});
export type TemporaryRecipe = z.infer<typeof temporaryRecipeSchema>;

export const changePlanStepSchema = z.strictObject({
  step_id: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/), recipe_id: z.string(), type: changeTypeSchema,
  depends_on: z.array(z.string()), mechanism: z.enum(['content', 'configuration', 'composition', 'extension', 'core']),
  target_layers: z.array(z.string()), validation_gates: z.array(z.string()), rollback: z.string(),
});
export const changePlanSchema = z.strictObject({
  plan_id: z.string().min(1), request: changeRequestSchema, classification: changeClassificationSchema,
  recipes: z.array(z.union([recipeSchema, temporaryRecipeSchema])).min(1), temporary_recipe: temporaryRecipeSchema.nullable(),
  steps: z.array(changePlanStepSchema).min(1),
  target_pipeline: z.enum(['runtime_content', 'runtime_configuration', 'extension_development', 'core_development']),
  requires_development_task: z.boolean(), requires_core_approval: z.boolean(),
  constitution_version: z.string(), completion_criteria: z.array(z.string()).min(1),
});
export type ChangePlan = z.infer<typeof changePlanSchema>;

export interface CompositeRecipe { recipe_ids: string[]; ordered_types: ChangeType[]; dependencies: Record<string, string[]>; }
export interface RecipeValidation { valid: boolean; errors: string[]; candidate_eligible: boolean; }
