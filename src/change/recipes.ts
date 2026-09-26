import { createHash } from 'node:crypto';
import { recipeSchema, temporaryRecipeSchema, type ChangeRequest, type ChangeType, type Recipe, type RecipeValidation, type TemporaryRecipe } from './contracts.js';

const mechanisms: Record<Exclude<ChangeType, 'NOVEL_CHANGE_DISCOVERY'>, Recipe['preferred_mechanism']> = {
  CONTENT_CHANGE: 'content', CONFIGURATION_CHANGE: 'configuration', STATE_EXTENSION: 'extension', RULE_EXTENSION: 'extension',
  BEHAVIOR_CHANGE: 'extension', CAPABILITY_EXTENSION: 'extension', PROVIDER_INTEGRATION: 'extension', UI_SURFACE_CHANGE: 'extension',
  WORKFLOW_CHANGE: 'extension', AGENT_PLANNING_CHANGE: 'extension', QUERY_AWARENESS_EXTENSION: 'extension',
  DATA_MODEL_CHANGE: 'core', CORE_EVOLUTION: 'core',
};

const analysis: Record<Exclude<ChangeType, 'NOVEL_CHANGE_DISCOVERY'>, string[]> = {
  CONTENT_CHANGE: ['Identify the canonical owner and content record.', 'Confirm the change needs no new behavior.'],
  CONFIGURATION_CHANGE: ['Locate the existing mechanism and supported parameter.', 'Check range, scope and precedence.'],
  STATE_EXTENSION: ['Define owner, type, default, constraints, persistence, visibility and backward compatibility.'],
  RULE_EXTENSION: ['Define trigger, inputs, transition, invariants and idempotency; keep state separate from rules.'],
  BEHAVIOR_CHANGE: ['Locate whether planner, rule, executor or capability owns the behavior and identify regressions.'],
  CAPABILITY_EXTENSION: ['Specify id, schemas, executor, availability, permissions, side effects, failure modes and registration.'],
  PROVIDER_INTEGRATION: ['Specify credentials boundary, timeout, retry, rate limit, cost, availability and provider failure.'],
  UI_SURFACE_CHANGE: ['Classify layout, session state, user configuration and world facts before changing persistence.'],
  WORKFLOW_CHANGE: ['Specify states, transitions, entry, exit, cancel, resume, failure and idempotency.'],
  AGENT_PLANNING_CHANGE: ['Specify context, horizon, affordances, clarification budget, stop conditions and fallback.'],
  QUERY_AWARENESS_EXTENSION: ['Specify source of truth, visibility, permissions and FOUND/NOT_FOUND/NOT_DEFINED/UNKNOWN/UNAVAILABLE.'],
  DATA_MODEL_CHANGE: ['Prove lower-level recipes are insufficient; specify version, defaults, migration, rollback and old-save behavior.'],
  CORE_EVOLUTION: ['Prove configuration, composition, SDK, capability, rule and component mechanisms are insufficient.'],
};

function recipe(type: Exclude<ChangeType, 'NOVEL_CHANGE_DISCOVERY'>): Recipe {
  const mechanism = mechanisms[type];
  return recipeSchema.parse({
    recipe_id: `change.${type.toLowerCase()}`, version: '1.0.0', type,
    applicable_when: [`The requested change is primarily ${type.toLowerCase().replaceAll('_', ' ')}.`],
    not_applicable_when: ['An existing lower-risk recipe can completely express the requested outcome.'],
    required_context: ['canonical truth', 'installed modules and capabilities', 'permission boundary'],
    required_analysis: analysis[type], preferred_mechanism: mechanism,
    allowed_tools: mechanism === 'content' || mechanism === 'configuration' ? ['canonical query', 'validated transaction'] : mechanism === 'core' ? ['isolated coding workspace', 'test/build gates'] : ['extension SDK', 'DevelopmentTask'],
    forbidden_actions: ['write unvalidated canonical state', 'claim unavailable capability', 'bypass validation gates'],
    state_boundary: type === 'UI_SURFACE_CHANGE' ? 'UI/session state remains outside canonical world state unless explicitly proven otherwise.' : 'Only declared canonical fields may be persisted.',
    permission_boundary: 'Use the least write permission required by the selected mechanism.',
    implementation_steps: ['Inspect reusable primitives.', `Prepare the smallest ${mechanism} change.`, 'Validate in isolation before commit or installation.'],
    validation_gates: ['contract validation', 'targeted regression', mechanism === 'core' ? 'full build and acceptance' : 'boundary validation'],
    rollback_policy: mechanism === 'content' || mechanism === 'configuration' ? 'Restore the transaction checkpoint.' : 'Disable the candidate and restore the previous installed version/checkpoint.',
    completion_criteria: ['Requested outcome is observable.', 'No undeclared state or permission change occurred.', 'Original goal can resume.'],
    fallback: mechanism === 'core' ? 'Remain blocked with a reviewed Core Proposal.' : 'Escalate one level with an explicit capability gap; never simulate success.',
  });
}

export const BUILTIN_RECIPES = Object.freeze((Object.keys(mechanisms) as Exclude<ChangeType, 'NOVEL_CHANGE_DISCOVERY'>[]).map(recipe));

export class RecipeRegistry {
  private readonly entries = new Map<string, Recipe>();
  constructor(recipes: readonly Recipe[] = BUILTIN_RECIPES) { for (const item of recipes) this.register(item); }
  register(raw: Recipe) { const item = recipeSchema.parse(raw), old = this.entries.get(item.recipe_id); if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error(`recipe ${item.recipe_id} already has another definition`); this.entries.set(item.recipe_id, Object.freeze(item)); return item; }
  get(id: string) { return this.entries.get(id) ?? null; }
  forType(type: ChangeType) { return [...this.entries.values()].find(item => item.type === type) ?? null; }
  all() { return [...this.entries.values()]; }
  registerCandidate(recipe: Recipe, evidence: { successful: boolean; reusable: boolean; generic: boolean; validations: string[] }) {
    if (!evidence.successful || !evidence.reusable || !evidence.generic || !evidence.validations.length) throw new Error('temporary recipe has not earned registry promotion');
    return this.register(recipe);
  }
}
export const recipeRegistry = new RecipeRegistry();

export function discoverNovelRecipe(request: ChangeRequest): TemporaryRecipe {
  const suffix = createHash('sha256').update(request.goal_summary).digest('hex').slice(0, 12);
  return temporaryRecipeSchema.parse({
    recipe_id: `temporary.novel.${suffix}`, version: '0.1.0', type: 'NOVEL_CHANGE_DISCOVERY', temporary: true,
    applicable_when: ['No registered recipe or safe composition expresses the requested experience.'],
    not_applicable_when: ['A registered recipe fully covers the change.'],
    required_context: ['canonical truth', 'available primitives', 'affected layers'],
    required_analysis: ['Describe the desired experience.', 'Explain the coverage gap.', 'Separate reusable primitives from truly new primitives.', 'Choose the minimum boundary.'],
    preferred_mechanism: 'extension', allowed_tools: ['read-only architecture inspection', 'DevelopmentTask', 'isolated validation'],
    forbidden_actions: ['route to OTHER', 'jump directly to core coding', 'register before successful reusable evidence'],
    state_boundary: 'No new canonical state until ownership and migration are explicitly defined.',
    permission_boundary: 'Discovery is read-only; execution uses the chosen recipe permission boundary.',
    implementation_steps: ['Inspect current recipes and primitives.', 'Form the smallest temporary recipe.', 'Validate its contract.', 'Execute through the existing development pipeline.'],
    validation_gates: ['temporary recipe schema', 'minimum-boundary review', 'targeted behavior proof', 'rollback proof'],
    rollback_policy: 'Discard the temporary candidate and restore its isolated checkpoint.',
    completion_criteria: ['The novel experience has an explicit minimum implementation.', 'Validation and rollback are executable.', 'Registry promotion remains a separate decision.'],
    fallback: 'Keep the goal suspended with the coverage gap; do not report completion.',
    discovery: {
      desired_experience: request.goal_summary, coverage_gap: 'No registered recipe confidently covers the requested combination or primitive.',
      affected_layers: request.target_layers.length ? request.target_layers : ['unknown'], reusable_primitives: ['GoalSpec', 'DevelopmentTask', 'validation gates'],
      new_primitives: ['to be established by isolated discovery'], minimum_boundary: 'A temporary extension candidate with no canonical migration by default.', reusable_candidate: true,
    },
  });
}

export function validateTemporaryRecipe(recipe: TemporaryRecipe): RecipeValidation {
  const parsed = temporaryRecipeSchema.safeParse(recipe), errors: string[] = [];
  if (!parsed.success) errors.push('schema validation failed');
  if (!recipe.discovery.coverage_gap.trim()) errors.push('coverage gap is missing');
  if (!recipe.validation_gates.length) errors.push('validation gates are missing');
  if (!recipe.rollback_policy.trim()) errors.push('rollback policy is missing');
  return { valid: errors.length === 0, errors, candidate_eligible: errors.length === 0 && recipe.discovery.reusable_candidate };
}
