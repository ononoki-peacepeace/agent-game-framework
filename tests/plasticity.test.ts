import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RECIPES, RecipeRegistry, validateTemporaryRecipe } from '../src/change/recipes.js';
import { classifyFrameworkChange, createChangeRequest } from '../src/change/classifier.js';
import { composeRecipes, planChange, planFrameworkChange } from '../src/change/planner.js';
import { changePlanSchema, changeTypeValues } from '../src/change/contracts.js';
import { classifyMeta } from '../src/system/router.js';
import { capabilityRegistry } from '../src/system/capabilities.js';
import { ExtensionHost } from '../src/extensions/host.js';
import { ExtensionDevelopment } from '../src/extensions/development.js';
import { DevelopmentTasks } from '../src/extensions/tasks.js';
import type { AIRequest } from '../src/ai/contracts.js';
import type { ExtensionSpec } from '../src/extensions/schema.js';
import { sparseSetup } from './sparse-fixture.js';

describe('plasticity change architecture', () => {
  it('keeps the recipe library structural and complete without feature-specific recipes', () => {
    const registry = new RecipeRegistry();
    expect(BUILTIN_RECIPES).toHaveLength(13);
    expect(new Set(BUILTIN_RECIPES.map(recipe => recipe.type))).toEqual(new Set(changeTypeValues.filter(type => type !== 'NOVEL_CHANGE_DISCOVERY')));
    for (const recipe of registry.all()) {
      expect(recipe.required_analysis.length).toBeGreaterThan(0);
      expect(recipe.validation_gates.length).toBeGreaterThan(0);
      expect(recipe.forbidden_actions.length).toBeGreaterThan(0);
      expect(recipe.rollback_policy).toBeTruthy();
      expect(recipe.recipe_id).not.toMatch(/好感|声望|睡觉|赚钱|婚姻|favor|reputation|sleep|money|marriage/i);
    }
  });

  it('classifies content/configuration changes without development and rejects neighboring play input', () => {
    const content = planFrameworkChange('新增一个名为北港的地点，并添加两件普通物品');
    const configuration = planFrameworkChange('把已有规则的恢复倍率调整为 1.5，并修改默认上限');
    expect(content).toMatchObject({ target_pipeline: 'runtime_content', requires_development_task: false });
    expect(content?.classification.recipe_types).toContain('CONTENT_CHANGE');
    expect(configuration).toMatchObject({ target_pipeline: 'runtime_configuration', requires_development_task: false });
    expect(configuration?.classification.recipe_types).toContain('CONFIGURATION_CHANGE');
    expect(classifyFrameworkChange('我去北港看看')).toBeNull();
    expect(classifyMeta('我去北港看看')).toBe('IN_WORLD_INPUT');
  });

  it('composes state, rule, query and surface in dependency order', () => {
    const plan = planFrameworkChange('为所有角色新增信任属性；每当共同完成任务时按规则变化；允许查询当前状态，并显示在人物页面');
    expect(plan).not.toBeNull();
    expect(plan?.classification.recipe_types).toEqual(expect.arrayContaining(['STATE_EXTENSION', 'RULE_EXTENSION', 'QUERY_AWARENESS_EXTENSION', 'UI_SURFACE_CHANGE']));
    expect(plan).toMatchObject({ target_pipeline: 'extension_development', requires_development_task: true, requires_core_approval: false });
    const ordered = plan!.steps.map(step => step.type);
    expect(ordered.indexOf('STATE_EXTENSION')).toBeLessThan(ordered.indexOf('RULE_EXTENSION'));
    expect(ordered.indexOf('RULE_EXTENSION')).toBeLessThan(ordered.indexOf('QUERY_AWARENESS_EXTENSION'));
    expect(ordered.indexOf('QUERY_AWARENESS_EXTENSION')).toBeLessThan(ordered.indexOf('UI_SURFACE_CHANGE'));
    expect(plan!.steps.slice(1).every(step => step.depends_on.length === 1)).toBe(true);
  });

  it('discovers and validates a temporary recipe instead of using OTHER', () => {
    const request = createChangeRequest('让不同世界之间协商可携带的因果承诺', { fixture: 'novel' });
    const plan = planChange(request);
    expect(plan.classification.primary_type).toBe('NOVEL_CHANGE_DISCOVERY');
    expect(plan.temporary_recipe?.temporary).toBe(true);
    expect(plan.target_pipeline).toBe('extension_development');
    expect(validateTemporaryRecipe(plan.temporary_recipe!)).toEqual({ valid: true, errors: [], candidate_eligible: true });
    expect(() => new RecipeRegistry().registerCandidate(plan.temporary_recipe!, { successful: false, reusable: true, generic: true, validations: ['fixture'] })).toThrow();
  });

  it('uses one capability assessment for external ownership and local builder eligibility', () => {
    const external = capabilityRegistry.assess(['media.image.generate'], []);
    expect(external.external_prerequisites).toContain('media.image_generation');
    expect(external.safe_local_builder).toBe(false);
    const local = capabilityRegistry.assess(['entity.wallet.balance.set'], ['economy.wallet']);
    expect(local.external_prerequisites).toEqual([]);
    expect(local.safe_local_builder).toBe(true);
  });
});

describe('plasticity development pipeline integration', () => {
  it('persists a composite ChangePlan in the existing DevelopmentTask and builds a validated candidate', async () => {
    const fixture = await sparseSetup();
    const directory = await mkdtemp(join(tmpdir(), 'agf-plasticity-'));
    try {
      const host = new ExtensionHost(fixture.service, directory);
      const builder = new ExtensionDevelopment(host);
      const calls: AIRequest[] = [];
      const plan = planFrameworkChange('为角色新增可查询的专注属性，按规则变化，并显示在状态面板')!;
      const planning = {
        normalized_requirements: ['提供扩展自有专注状态、规则动作与可见面板'], complexity: 'LOW', clarification: null,
        milestones: [{ id: 'focus', title: '专注状态、动作与界面', kind: 'integration', acceptance: ['状态动作与展示通过验证'] }],
        capability_gaps: [], affected_milestone_ids: [],
      };
      const adapter = { name: 'plasticity-fixture', async generate(request: AIRequest) {
        calls.push(request);
        if ((request.schema as any).properties.normalized_requirements) return { data: planning };
        const context = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"extension_id"')));
        const spec: ExtensionSpec = {
          extension_id: context.extension_id, name: '专注测试扩展', description: '验证组合变更计划进入既有扩展管线',
          template: 'declarative', allow_betting: false, max_stake: 0, healing_item_id: null,
          fields: [{ key: 'focus', type: 'number', initial: 0 }],
          declarative_actions: [{ id: 'increase_focus', label: '提升专注', op: 'increment', field: 'focus', value: 1 }],
          surfaces: [{ id: 'focus_panel', kind: 'panel', title: '专注', visibility: 'always' }],
        };
        return { data: { spec, capability_gaps: [] } };
      } };
      const tasks = new DevelopmentTasks(builder, () => adapter);
      const started = await tasks.start({ request_id: randomUUID(), request: plan.request.original_input, change_plan: plan });
      const completed = await tasks.wait(started.id);
      expect(completed.status).toBe('ready_for_preview');
      expect(changePlanSchema.parse(completed.change_plan)).toEqual(plan);
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.test_results).toEqual(expect.arrayContaining([expect.objectContaining({ passed: true })]));
      expect(calls[0].prompt).toContain('"change_plan"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
