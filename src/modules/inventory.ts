import { z } from 'zod';
import { assert, dictionary, integer } from '../core/schema.js';
import type { Module } from '../core/registry.js';
export type Inventory = { items: Record<string, number> };
export const inventoryModule: Module = {
  id: 'inventory', version: '0.1.0', requires: ['core'],
  components: {
    item: { schema: z.strictObject({ weight: z.number().min(0).max(100000), stackable: z.boolean() }), project: d => d },
    inventory: { schema: z.strictObject({ items: dictionary(integer) }), project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined },
  },
  panels: [{ id: 'inventory', label: '背包' }],
  validate(save) {
    for (const e of save.entities) for (const [itemId, n] of Object.entries((e.components.inventory as Inventory | undefined)?.items ?? {})) {
      const item = save.entities.find(i => i.id === itemId)?.components.item;
      assert(item, `未知物品 ${itemId}`); assert(item.stackable || n <= 1, '非堆叠物品数量超过 1');
    }
  },
};
