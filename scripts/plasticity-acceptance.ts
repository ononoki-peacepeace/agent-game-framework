import { strict as assert } from 'node:assert';
import { classifyFrameworkChange, createChangeRequest } from '../src/change/classifier.js';
import { planChange, planFrameworkChange } from '../src/change/planner.js';
import { validateTemporaryRecipe } from '../src/change/recipes.js';

const content = planFrameworkChange('在世界中新增一个叫白塔港的地点');
assert(content);
assert.equal(content.target_pipeline, 'runtime_content');
assert.equal(content.requires_development_task, false);

const composite = planFrameworkChange('新增一个角色专注属性；每当完成调查时按规则变化；可以查询，并显示在状态面板');
assert(composite);
for (const type of ['STATE_EXTENSION', 'RULE_EXTENSION', 'QUERY_AWARENESS_EXTENSION', 'UI_SURFACE_CHANGE']) {
  assert(composite.classification.recipe_types.includes(type as never), `missing ${type}`);
}
assert.equal(composite.target_pipeline, 'extension_development');

const novel = planChange(createChangeRequest('让不同世界之间协商可携带的因果承诺'));
assert.equal(novel.classification.primary_type, 'NOVEL_CHANGE_DISCOVERY');
assert(novel.temporary_recipe);
assert.equal(validateTemporaryRecipe(novel.temporary_recipe).valid, true);
assert.equal(classifyFrameworkChange('我去白塔港'), null);

console.log(JSON.stringify({
  content_configuration: 'PASS',
  composite_recipe: 'PASS',
  novel_change: 'PASS',
  development_pipeline_target: composite.target_pipeline,
}, null, 2));
