import { z } from 'zod';
import { assert, type SavePackage } from '../core/schema.js';
import type { ActionSpec } from '../core/registry.js';
import { moduleCatalog } from './catalog.js';

const parameters = z.strictObject({ module: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), confirmed: z.boolean().default(false) });

function moduleOf(id: string) {
  const module = moduleCatalog().find(entry => entry.id === id);
  assert(module, `未知模块: ${id}`);
  return module;
}
export function dependentsOf(enabled: string[], id: string) {
  return enabled.filter(other => other !== id && (moduleCatalog().find(module => module.id === other)?.requires ?? []).includes(id));
}
function mark(save: SavePackage, id: string, enabled: boolean, installed = true) {
  const module = moduleOf(id);
  save.modules[id] = { installed, enabled, version: save.module_versions[id] ?? module.version, state_version: module.manifest?.state_schema_version ?? 'v1' };
  return module;
}
export function enableModule(save: SavePackage, moduleId: string, confirmed: boolean) {
  const module = moduleOf(moduleId);
  assert(module.manifest?.supports_enable_disable !== false, `${moduleId} 不能动态启用`);
  assert(confirmed, `启用 ${moduleId} 需要玩家明确确认`);
  assert(!save.definition.enabled_modules.includes(moduleId), `${moduleId} 已经启用`);
  for (const dependency of module.requires ?? []) {
    if (save.definition.enabled_modules.includes(dependency)) continue;
    const dependencyModule = moduleOf(dependency);
    assert(dependencyModule.manifest?.supports_enable_disable !== false, `缺少必需模块 ${dependency}`);
    save.definition.enabled_modules.push(dependency);
    save.module_versions[dependency] = dependencyModule.version;
    mark(save, dependency, true);
    dependencyModule.manifest?.setup?.(save);
  }
  save.definition.enabled_modules.push(moduleId);
  save.module_versions[moduleId] = module.version;
  mark(save, moduleId, true);
  module.manifest?.setup?.(save);
  return module;
}
export function disableModule(save: SavePackage, moduleId: string, confirmed: boolean) {
  const module = moduleOf(moduleId);
  assert(save.definition.enabled_modules.includes(moduleId), `${moduleId} 没有启用`);
  // Dependencies are reported first: "who still needs this?" is the actionable answer.
  const dependents = dependentsOf(save.definition.enabled_modules, moduleId);
  assert(!dependents.length, `以下已启用模块依赖 ${moduleId}，请先停用它们：${dependents.join('、')}`);
  assert(module.manifest?.supports_enable_disable !== false, `${moduleId} 不能停用`);
  assert(confirmed, `停用 ${moduleId} 需要玩家明确确认`);
  save.definition.enabled_modules = save.definition.enabled_modules.filter(id => id !== moduleId);
  mark(save, moduleId, false);
  return module;
}
// Removal is the only destructive lifecycle step: the service writes a checkpoint before the turn,
// dependencies must be resolved first, and only the module's own declared state is stripped.
export function removeModule(save: SavePackage, moduleId: string, confirmed: boolean) {
  const module = moduleOf(moduleId);
  const dependents = dependentsOf(save.definition.enabled_modules, moduleId);
  assert(!dependents.length, `以下已启用模块依赖 ${moduleId}，请先停用或移除它们：${dependents.join('、')}`);
  assert(module.manifest?.supports_remove !== false, `${moduleId} 不支持移除；只能停用`);
  assert(confirmed, `移除 ${moduleId} 需要玩家明确确认`);
  for (const path of module.manifest?.state_ownership ?? []) stripOwnedState(save, path);
  save.definition.enabled_modules = save.definition.enabled_modules.filter(id => id !== moduleId);
  // The version record stays as an audit trail: installed=false marks the module as removed, so a
  // save can still be validated by a registry that was built before the removal.
  mark(save, moduleId, false, false);
  return module;
}
export function stripOwnedState(save: SavePackage, path: string) {
  if (path.startsWith('components.')) {
    const component = path.slice('components.'.length);
    for (const entity of save.entities) delete entity.components[component];
    for (const entity of save.definition.entities) delete entity.components[component];
    return;
  }
  if (path === 'definition.map') { (save.definition as { map?: unknown }).map = undefined; return; }
  if (path === 'map_state') { save.map_state = { known_location_ids: [], dynamic_locations: [], dynamic_routes: [] }; return; }
  if (path === 'definition.routine_rules') { (save.definition as { routine_rules?: unknown }).routine_rules = undefined; return; }
  if (path.startsWith('definition.')) { delete (save.definition as unknown as Record<string, unknown>)[path.slice('definition.'.length)]; return; }
  delete (save as unknown as Record<string, unknown>)[path];
}

const action = (run: (save: SavePackage, moduleId: string, confirmed: boolean) => string): ActionSpec => ({
  ui: { label: '管理玩法模块', visibility: 'text' },
  parameters,
  execute(context) {
    const moduleId = String(context.action.parameters.module), confirmed = context.action.parameters.confirmed === true;
    context.facts.push(run(context.save, moduleId, confirmed));
  },
});
export const lifecycleActions: Record<string, ActionSpec> = {
  ENABLE_MODULE: action((save, moduleId, confirmed) => `已启用模块 ${enableModule(save, moduleId, confirmed).id}。`),
  DISABLE_MODULE: action((save, moduleId, confirmed) => `已停用模块 ${disableModule(save, moduleId, confirmed).id}（数据休眠保留，可随时重新启用）。`),
  REMOVE_MODULE: action((save, moduleId, confirmed) => `已移除模块 ${removeModule(save, moduleId, confirmed).id} 及其自有状态。`),
};
