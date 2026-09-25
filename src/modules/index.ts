import { ModuleRegistry, type Module } from '../core/registry.js';
import type { ModuleStatus, PanelMeta } from '../shared/contracts.js';
import { assert, type SavePackage } from '../core/schema.js';
import { setModuleCatalog } from './catalog.js';
import { coreModule } from './core.js';
import { charactersModule } from './characters.js';
import { relationshipsModule } from './relationships.js';
import { mapModule } from './map.js';
import { inventoryModule } from './inventory.js';
import { commerceModule } from './commerce.js';
import { attributesModule } from './attributes.js';
import { aptitudesModule } from './aptitudes.js';
import { skillsModule } from './skills.js';
import { traitsModule } from './traits.js';
import { equipmentModule } from './equipment.js';
import { questsModule } from './quests.js';
import { routineModule } from './routine.js';

export const availableModules: Module[] = [
  coreModule, charactersModule, relationshipsModule, mapModule, inventoryModule, commerceModule,
  attributesModule, aptitudesModule, skillsModule, traitsModule, equipmentModule, questsModule, routineModule,
];
setModuleCatalog(availableModules);

/** Framework-level surfaces: always available, independent of world modules. */
export const frameworkPanels: PanelMeta[] = [
  // Out-of-game surface. Extension development lives inside it as an advanced sub-capability.
  { id: 'system', label: '系统', module: 'framework', order: 800, mobile_group: 'secondary', presentation_type: 'panel' },
  { id: 'saves', label: '存档', module: 'framework', order: 810, mobile_group: 'secondary', presentation_type: 'panel' },
  { id: 'logs', label: '日志', module: 'framework', order: 820, mobile_group: 'secondary', presentation_type: 'panel' },
];
export function createRegistry(enabled: string[], available = availableModules) {
  assert(new Set(enabled).size === enabled.length && enabled.includes('core'), '模块列表重复或缺少 core');
  const registry = new ModuleRegistry();
  const visit = (name: string, chain: string[] = []) => {
    if (registry.modules.has(name)) return;
    assert(!chain.includes(name), '模块依赖循环');
    const module = available.find(m => m.id === name); assert(module, `缺少模块: ${name}`);
    for (const dep of module.requires ?? []) { assert(enabled.includes(dep), `缺少必需模块: ${dep}`); visit(dep, [...chain, name]); }
    registry.register(module);
  };
  enabled.forEach(name => visit(name));
  return registry;
}
/** Every panel the client may show, in registry order. Disabled modules contribute nothing. */
export function panelMeta(registry: ModuleRegistry): PanelMeta[] {
  const panels = [...registry.modules.all().flatMap(([, module]) => module.panels ?? []), ...frameworkPanels];
  const seen = new Set<string>();
  return panels.filter(panel => (seen.has(panel.id) ? false : (seen.add(panel.id), true)))
    .sort((a, b) => (a.order ?? 500) - (b.order ?? 500) || a.id.localeCompare(b.id));
}
/** Lifecycle view of every known module: installed, enabled, capabilities and dependents. */
export function moduleStatuses(save: SavePackage, available = availableModules): ModuleStatus[] {
  return available.map(module => {
    const record = save.modules[module.id];
    const enabled = save.definition.enabled_modules.includes(module.id);
    const dependents = save.definition.enabled_modules.filter(other => other !== module.id && (available.find(entry => entry.id === other)?.requires ?? []).includes(module.id));
    return {
      id: module.id, version: record?.version ?? save.module_versions[module.id] ?? module.version,
      installed: record?.installed ?? enabled, enabled,
      state_schema_version: record?.state_version ?? module.manifest?.state_schema_version ?? 'v1',
      provides: module.manifest?.provides ?? [], requires: module.requires ?? [], dependents,
      panels: (module.panels ?? []).map(panel => panel.id),
      supports_enable_disable: module.manifest?.supports_enable_disable !== false,
      supports_remove: module.manifest?.supports_remove !== false,
    };
  });
}
export function capabilityList(registry: ModuleRegistry) { return registry.capabilities.all().map(([name]) => name); }
