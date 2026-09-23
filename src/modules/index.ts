import { ModuleRegistry, type Module } from '../core/registry.js';
import { assert } from '../core/schema.js';
import { coreModule } from './core.js';
import { charactersModule } from './characters.js';
import { relationshipsModule } from './relationships.js';
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
  coreModule, charactersModule, relationshipsModule, inventoryModule, commerceModule,
  attributesModule, aptitudesModule, skillsModule, traitsModule, equipmentModule, questsModule, routineModule,
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
