import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assert, dictionary, integer, id, type SavePackage } from '../core/schema.js';
import type { Module } from '../core/registry.js';
export type Inventory = { items: Record<string, number>; placements?: Record<string, string | null> };
const itemSchema=z.strictObject({weight:z.number().min(0).max(100000),stackable:z.boolean(),container:z.boolean().optional(),tags:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(12).optional(),tracking:z.enum(['incidental','tracked']).optional()});

function playerInventory(save:SavePackage){
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  assert(player?.components.inventory,'当前角色没有背包');
  return {player,inventory:player.components.inventory as Inventory};
}
/** An item definition remains the existing entity primitive; placements describe owned nesting. */
export function putItemInInventory(save:SavePackage,itemId:string,containerId:string|null=null){
  const {inventory}=playerInventory(save),item=save.entities.find(entity=>entity.id===itemId);
  assert(item?.components.item,'物品不存在');
  if(containerId){const parent=save.entities.find(entity=>entity.id===containerId);assert(parent?.components.item?.container===true&&(inventory.items[containerId]??0)>0,'容器不在角色持有物中');assert(containerId!==itemId,'物品不能装进自身');}
  assert((inventory.items[itemId]??0)<=1,'堆叠物品不能作为单件物品移动');
  inventory.items[itemId]=1;
  inventory.placements??={};inventory.placements[itemId]=containerId;
  delete item.components.location;delete item.components.scene_position;
  item.components.item.tracking='tracked';
}
export function putItemInScene(save:SavePackage,itemId:string,positionLabel:string|null=null){
  const {player,inventory}=playerInventory(save),item=save.entities.find(entity=>entity.id===itemId);
  assert(item?.components.item&&(inventory.items[itemId]??0)===1,'角色没有持有这件物品');
  assert(!Object.entries(inventory.placements??{}).some(([child,parent])=>parent===itemId&&(inventory.items[child]??0)>0),'请先取出容器里的物品');
  const locationId=player.components.location?.location_id;assert(locationId,'当前场景没有可登记的地点');
  delete inventory.items[itemId];if(inventory.placements)delete inventory.placements[itemId];
  item.components.location={location_id:locationId};
  if(positionLabel)item.components.scene_position={label:positionLabel};else delete item.components.scene_position;
  item.components.item.tracking='tracked';
}
export function ensureOrdinaryItem(save:SavePackage,name:string,weight:number,container=false):SavePackage['entities'][number]{
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const owned=(player?.components.inventory as Inventory|undefined)?.items??{};
  const here=player?.components.location?.location_id;
  const existing=save.entities.find(entity=>entity.components.item&&entity.components.identity?.name===name&&((owned[entity.id]??0)>0||Boolean(here&&entity.components.location?.location_id===here)));
  if(existing){if(container)existing.components.item.container=true;return existing;}
  assert(save.entities.length<500,'世界实体数量已达上限');
  const entity={id:`item_${randomUUID().replaceAll('-','').slice(0,24)}`,type:'item',components:{identity:{name,description:'',avatar_id:null,gender:null,age:null},item:{weight,stackable:false,container,tags:['ordinary'],tracking:'tracked'}}};
  save.entities.push(entity);return entity;
}
export const inventoryModule: Module = {
  id: 'inventory', version: '0.1.0', requires: ['core'],
  manifest: { api_version:'1', provides:['inventory.storage','item.definition'], state_ownership:['components.inventory','components.item'], state_schema_version:'inventory.v1', migration_version:1, supports_enable_disable:false, supports_remove:false },
  components: {
    item: { schema: itemSchema, project: d => d },
    inventory: { schema: z.strictObject({ items: dictionary(integer), placements:dictionary(z.string().nullable()).optional() }), project: (d, e, s) => e.id === s.player_state.entity_id ? d : undefined },
  },
  actions:{
    MOVE_ITEM:{ui:{label:'移动物品',visibility:'text',target_component:'item'},
      capability:{intent:'item_move',description:'改变已登记物品在角色持有物或当前场景中的位置',target_role:'item',parameter_roles:{item_id:'item',to:'destination'},completion_kind:'item_location'},
      parameters:z.strictObject({item_id:id,to:z.enum(['held','container','scene']),container_id:id.nullable().default(null),position_label:z.string().max(80).nullable().default(null)}),execute(c){
      const itemId=String(c.action.parameters.item_id),to=String(c.action.parameters.to);
      if(to==='scene')putItemInScene(c.save,itemId,String(c.action.parameters.position_label??'')||null);
      else {
        const item=c.save.entities.find(entity=>entity.id===itemId),player=c.save.entities.find(entity=>entity.id===c.save.player_state.entity_id);
        assert(item?.components.item&&player,'物品不存在');
        if((player.components.inventory as Inventory).items[itemId]!==1)assert(item.components.location?.location_id===player.components.location?.location_id,'物品不在当前场景');
        putItemInInventory(c.save,itemId,to==='container'?String(c.action.parameters.container_id??''):null);
      }
      c.advance(1);c.facts.push(`物品位置已更新：${String(c.save.entities.find(entity=>entity.id===itemId)?.components.identity?.name??'物品')}。`);
    }},
  },
  panels: [{ id: 'inventory', label: '背包', module: 'inventory', order: 60, mobile_group: 'primary', presentation_type: 'panel' }],
  validate(save) {
    for (const e of save.entities) {
      const inventory=e.components.inventory as Inventory|undefined;
      for (const [itemId, n] of Object.entries(inventory?.items ?? {})) {
      const item = save.entities.find(i => i.id === itemId)?.components.item;
      assert(item, `未知物品 ${itemId}`); assert(item.stackable || n <= 1, '非堆叠物品数量超过 1');
      if(item.tracking==='tracked')assert(!save.entities.find(i=>i.id===itemId)?.components.location,'持有物品不能同时放在场景');
      }
      for(const [itemId,parentId] of Object.entries(inventory?.placements??{})){
        assert((inventory?.items[itemId]??0)===1,'物品位置引用未持有物品');
        if(!parentId)continue;
        assert((inventory?.items[parentId]??0)===1&&save.entities.find(item=>item.id===parentId)?.components.item?.container===true,'物品位置引用无效容器');
        const seen=new Set([itemId]);let at:string|null=parentId;
        while(at){assert(!seen.has(at),'容器层级存在循环');seen.add(at);at=inventory?.placements?.[at]??null;}
      }
    }
  },
};
