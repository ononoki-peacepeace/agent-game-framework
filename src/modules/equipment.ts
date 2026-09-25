import { z } from 'zod';
import { assert, dictionary, id, text } from '../core/schema.js';
import type { Module } from '../core/registry.js';
import type { Inventory } from './inventory.js';

export type Equipment = { slots: Record<string, string | null>; labels?: Record<string, string> };
export type EquipmentItem = { allowed_slots: string[]; modifiers: Record<string, number>; effect: string };

export const equipmentModule: Module = {
  id: 'equipment', version: '0.1.0', requires: ['inventory'],
  manifest: { api_version:'1', provides:['equipment.slots'], state_ownership:['components.equipment','components.equipment_item'], state_schema_version:'equipment.v1', migration_version:1, supports_enable_disable:true, supports_remove:true },
  components: {
    equipment: {
      schema: z.strictObject({ slots: dictionary(id.nullable()), labels: dictionary(z.string().min(1).max(120)).default({}) }),
      project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined,
    },
    equipment_item: {
      schema: z.strictObject({ allowed_slots: z.array(id).min(1).max(20), modifiers: dictionary(z.number().min(-1_000_000).max(1_000_000)), effect: text }),
      project: d => d,
    },
  },
  panels: [{ id: 'equipment', label: '装备', module: 'equipment', order: 130, mobile_group: 'secondary', presentation_type: 'panel' }],
  actions: {
    EQUIP: {
      ui: { label: '装备', visibility: 'panel', target_component: 'equipment_item' },
      parameters: z.strictObject({ item_id: id, slot: id }),
      execute(c) {
        const itemId = String(c.action.parameters.item_id), slot = String(c.action.parameters.slot);
        const inv = c.store.component<Inventory>(c.action.actor_id, 'inventory');
        assert((inv.items[itemId] ?? 0) > 0, '背包中没有这件物品');
        const spec = c.store.component<EquipmentItem>(itemId, 'equipment_item');
        assert(spec.allowed_slots.includes(slot), '该物品不能装备到这个槽位');
        const equipment = c.store.component<Equipment>(c.action.actor_id, 'equipment');
        assert(Object.hasOwn(equipment.slots, slot), '角色不存在这个装备槽位');
        for (const [otherSlot, equipped] of Object.entries(equipment.slots)) if (equipped === itemId) equipment.slots[otherSlot] = null;
        equipment.slots[slot] = itemId;
        c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
        c.facts.push(`装备 ${c.store.component<{ name: string }>(itemId, 'identity').name} 到 ${slot}。`);
      },
    },
    UNEQUIP: {
      ui: { label: '卸下', visibility: 'panel' },
      parameters: z.strictObject({ slot: id }),
      execute(c) {
        const slot = String(c.action.parameters.slot), equipment = c.store.component<Equipment>(c.action.actor_id, 'equipment');
        assert(Object.hasOwn(equipment.slots, slot), '角色不存在这个装备槽位');
        const itemId = equipment.slots[slot]; assert(itemId, '这个槽位没有装备');
        equipment.slots[slot] = null;
        c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
        c.facts.push(`卸下 ${c.store.component<{ name: string }>(itemId, 'identity').name}。`);
      },
    },
  },
  validate(save) {
    for (const entity of save.entities) {
      const equipment = entity.components.equipment as Equipment | undefined;
      const inv = entity.components.inventory as Inventory | undefined;
      if (!equipment) continue;
      assert(inv, `${entity.id} 有 equipment 但没有 inventory`);
      const used = new Set<string>();
      for (const [slot, itemId] of Object.entries(equipment.slots)) {
        if (!itemId) continue;
        assert(!used.has(itemId), `同一物品不能同时占用多个装备槽: ${itemId}`); used.add(itemId);
        assert((inv.items[itemId] ?? 0) > 0, `已装备物品不在背包中: ${itemId}`);
        const item = save.entities.find(x => x.id === itemId);
        const spec = item?.components.equipment_item as EquipmentItem | undefined;
        assert(spec && spec.allowed_slots.includes(slot), `物品 ${itemId} 不能装备到 ${slot}`);
      }
    }
  },
  prompt: 'equipment 与 equipment_item 是 canonical 装备事实。只能通过 EQUIP/UNEQUIP 或其他授权规则改变，叙事不能偷偷换装。',
};
