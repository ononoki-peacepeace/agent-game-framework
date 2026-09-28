import { createHash } from 'node:crypto';
import { DEVELOPMENT_CONSTITUTION } from './constitution.js';
import { changePlanSchema, type ChangePlan, type ChangeRequest, type ChangeType, type CompositeRecipe, type Recipe } from './contracts.js';
import { classifyChangeRequest, classifyFrameworkChange, createChangeRequest } from './classifier.js';
import { discoverNovelRecipe, recipeRegistry, validateTemporaryRecipe, type RecipeRegistry } from './recipes.js';

const dependencyOrder: ChangeType[] = ['CONTENT_CHANGE','CONFIGURATION_CHANGE','STATE_EXTENSION','RULE_EXTENSION','CAPABILITY_EXTENSION','PROVIDER_INTEGRATION','AGENT_PLANNING_CHANGE','BEHAVIOR_CHANGE','WORKFLOW_CHANGE','QUERY_AWARENESS_EXTENSION','UI_SURFACE_CHANGE','DATA_MODEL_CHANGE','CORE_EVOLUTION','NOVEL_CHANGE_DISCOVERY'];

export function composeRecipes(recipes: Recipe[]): CompositeRecipe {
  const ordered = [...recipes].sort((a, b) => dependencyOrder.indexOf(a.type) - dependencyOrder.indexOf(b.type));
  const dependencies: Record<string, string[]> = {};
  ordered.forEach((item, index) => { dependencies[item.recipe_id] = index ? [ordered[index - 1].recipe_id] : []; });
  return { recipe_ids: ordered.map(item => item.recipe_id), ordered_types: ordered.map(item => item.type), dependencies };
}

export function planChange(request: ChangeRequest, registry: RecipeRegistry = recipeRegistry): ChangePlan {
  const classification = classifyChangeRequest(request);
  const temporary = classification.primary_type === 'NOVEL_CHANGE_DISCOVERY' ? discoverNovelRecipe(request) : null;
  if (temporary) { const validation = validateTemporaryRecipe(temporary); if (!validation.valid) throw new Error(`temporary recipe invalid: ${validation.errors.join(', ')}`); }
  const recipes = temporary ? [temporary] : classification.recipe_types.map(type => registry.forType(type)).filter((item): item is Recipe => Boolean(item));
  if (!recipes.length) throw new Error('classification has no registered recipe');
  const composite = composeRecipes(recipes), ordered = composite.recipe_ids.map(id => recipes.find(item => item.recipe_id === id)!);
  const steps = ordered.map((item, index) => ({
    step_id: `step_${index + 1}_${item.type.toLowerCase()}`, recipe_id: item.recipe_id, type: item.type,
    depends_on: index ? [`step_${index}_${ordered[index - 1].type.toLowerCase()}`] : [], mechanism: item.preferred_mechanism,
    target_layers: request.target_layers.length ? request.target_layers : [item.type.toLowerCase().replaceAll('_', '-')],
    validation_gates: item.validation_gates, rollback: item.rollback_policy,
  }));
  const mechanisms = new Set(recipes.map(item => item.preferred_mechanism));
  const target = mechanisms.has('core') ? 'core_development' : mechanisms.has('extension') ? 'extension_development' : mechanisms.has('configuration') ? 'runtime_configuration' : 'runtime_content';
    const explicitCore=classification.primary_type==='CORE_EVOLUTION'||classification.primary_type==='DATA_MODEL_CHANGE';
  const extensionSufficient=target==='extension_development'&&!explicitCore;
  const minimum_change_review={existing_extension_primitives:extensionSufficient,reusable_state_or_runtime_value:false,read_only_adapter_sufficient:false,host_projection_sufficient:extensionSufficient,canonical_schema_change_required:classification.primary_type==='DATA_MODEL_CHANGE',new_framework_concept_required:classification.primary_type==='CORE_EVOLUTION',generic_value:extensionSufficient?'现有扩展字段、动作和宿主投影可表达该目标。':explicitCore?'请求明确涉及框架或数据模型；必须经核心审批。':'使用更低成本的内容或配置机制。',selected_mechanism:target==='core_development'?'core':target==='extension_development'?'extension':target==='runtime_configuration'?'configuration':'content',core_justification:explicitCore?'玩家请求明确修改框架源码或 canonical 数据模型；低层机制不能满足。':null} as const;
  const digest = createHash('sha256').update(`${request.request_id}:${classification.recipe_types.join(',')}`).digest('hex').slice(0, 16);
  return changePlanSchema.parse({
    plan_id: `change-plan-${digest}`, request: { ...request, target_layers: [...new Set([...request.target_layers, ...classification.reasons.map(reason => reason.match(/the ([^ ]+) layer/)?.[1]).filter((x): x is string => Boolean(x))])] },
    classification, recipes, temporary_recipe: temporary, steps, target_pipeline: target,
    requires_development_task: target === 'extension_development' || target === 'core_development', requires_core_approval: target === 'core_development', minimum_change_review,
    constitution_version: DEVELOPMENT_CONSTITUTION.version, completion_criteria: [...new Set(recipes.flatMap(item => item.completion_criteria))],
  });
}

export function planFrameworkChange(input: string, context: Record<string, unknown> = {}, requestId?: string): ChangePlan | null {
  const classification = classifyFrameworkChange(input); if (!classification) return null;
  const request = createChangeRequest(input, context, requestId);
  return planChange({ ...request, target_layers: classification.reasons.map(reason => reason.match(/the ([^ ]+) layer/)?.[1]).filter((x): x is string => Boolean(x)) });
}
