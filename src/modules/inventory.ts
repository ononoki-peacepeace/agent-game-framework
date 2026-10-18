import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assert, dictionary, integer, id, type SavePackage } from '../core/schema.js';
import type { Module } from '../core/registry.js';
import {prepareCheck,resolveCheck} from '../core/resolution.js';
import {worldAssert} from '../agent/outcome.js';
export type Inventory = { items: Record<string, number>; placements?: Record<string, string | null> };
const itemSchema=z.strictObject({weight:z.number().min(0).max(100000),stackable:z.boolean(),container:z.boolean().optional(),container_id:id.optional(),placed_sequence:z.number().int().nonnegative().optional(),owner_id:id.optional(),condition:z.enum(['intact','damaged','destroyed']).optional(),tags:z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(12).optional(),tracking:z.enum(['incidental','tracked']).optional()});

function playerInventory(save:SavePackage,actorId=save.player_state.entity_id){
  const player=save.entities.find(entity=>entity.id===actorId);
  assert(player?.components.inventory,'当前角色没有背包');
  return {player,inventory:player.components.inventory as Inventory};
}
/** An item definition remains the existing entity primitive; placements describe owned nesting. */
export function putItemInInventory(save:SavePackage,itemId:string,containerId:string|null=null,actorId=save.player_state.entity_id){
  const {player,inventory}=playerInventory(save,actorId),item=save.entities.find(entity=>entity.id===itemId);
  assert(item?.components.item,'物品不存在');
  worldAssert(!item.components.item.owner_id||item.components.item.owner_id===actorId,'unavailable','物品属于其他人物，不能直接拿取');
  worldAssert(!(item.components.item.tags as string[]|undefined)?.includes('shared_fixture'),'unavailable','这是共同设施，不能作为个人物品取走');
  assert(!save.entities.some(entity=>entity.id!==player.id&&Number((entity.components.inventory?.items as Record<string,number>|undefined)?.[itemId]??0)>0),'物品已由其他人物持有');
  if(containerId){const parent=save.entities.find(entity=>entity.id===containerId);assert(parent?.components.item?.container===true&&(inventory.items[containerId]??0)>0,'容器不在角色持有物中');assert(containerId!==itemId,'物品不能装进自身');}
  assert((inventory.items[itemId]??0)<=1,'堆叠物品不能作为单件物品移动');
  inventory.items[itemId]=1;
  inventory.placements??={};inventory.placements[itemId]=containerId;
  delete item.components.location;delete item.components.scene_position;
  item.components.item.tracking='tracked';
  item.components.item.owner_id=player.id;
  delete item.components.item.container_id;
  delete item.components.item.placed_sequence;
}
export function putItemInScene(save:SavePackage,itemId:string,positionLabel:string|null=null,actorId=save.player_state.entity_id){
  const {player,inventory}=playerInventory(save,actorId),item=save.entities.find(entity=>entity.id===itemId);
  assert(item?.components.item&&(inventory.items[itemId]??0)===1,'角色没有持有这件物品');
  assert(!Object.values(player.components.equipment?.slots??{}).includes(itemId),'请先卸下这件物品');
  assert(!Object.entries(inventory.placements??{}).some(([child,parent])=>parent===itemId&&(inventory.items[child]??0)>0),'请先取出容器里的物品');
  const locationId=player.components.location?.location_id;assert(locationId,'当前场景没有可登记的地点');
  delete inventory.items[itemId];if(inventory.placements)delete inventory.placements[itemId];
  item.components.location={location_id:locationId};
  if(positionLabel)item.components.scene_position={label:positionLabel};else delete item.components.scene_position;
  item.components.item.tracking='tracked';
  delete item.components.item.owner_id;
  delete item.components.item.container_id;
  if(save.environment_state){
    save.environment_state.sequence=(save.environment_state.sequence??0)+1;
    item.components.item.placed_sequence=save.environment_state.sequence;
  }
}
/** Place a held item inside a reachable scene container; the Core sequence proves it arrived after older observations. */
export function putItemInSceneContainer(save:SavePackage,itemId:string,containerId:string,actorId=save.player_state.entity_id){
  const actor=save.entities.find(entity=>entity.id===actorId),container=save.entities.find(entity=>entity.id===containerId);
  worldAssert(Boolean(actor&&container?.components.item?.container&&container.id!==itemId&&
    container.components.location?.location_id===actor.components.location?.location_id&&
    (!container.components.item.owner_id||container.components.item.owner_id===actorId)&&
    !(container.components.item.tags as string[]|undefined)?.includes('sealed')),
  'unavailable','场景容器不在当前可存放范围');
  putItemInScene(save,itemId,null,actorId);
  const item=save.entities.find(entity=>entity.id===itemId)!;
  item.components.item!.container_id=containerId;
  item.components.discovery={known_to_player:actorId===save.player_state.entity_id};
  if(actorId===save.player_state.entity_id){
    const record=save.environment_state?.resolutions.find(r=>r.entity_id===itemId&&r.status==='present');
    if(record?.known_by&&!record.known_by.includes(actorId))record.known_by.push(actorId);
  }
}
/** Shared mutation after an authorized Core/freeform check. Never creates an item or a truth. */
export function setItemCondition(save:SavePackage,itemId:string,condition:'damaged'|'destroyed',requestId:string){
  const item=save.entities.find(entity=>entity.id===itemId);assert(item?.components.item,'物品不存在');
  assert(item.components.item.condition!=='destroyed','损毁物品不能恢复为完好或受损状态');
  item.components.item.condition=condition;
  if(condition==='destroyed'){
    for(const entity of save.entities)for(const [slot,equipped] of Object.entries(entity.components.equipment?.slots??{}))
      if(equipped===item.id)(entity.components.equipment!.slots as Record<string,string|null>)[slot]=null;
    for(const truth of save.gm_state.hidden_truth?.commitments??[])for(const evidence of truth.evidence)
      if(evidence.placement?.anchor_entity_id===item.id){evidence.status='DESTROYED';evidence.destroyed_event_ref=requestId;}
  }
}
export function ensureOrdinaryItem(save:SavePackage,name:string,weight:number,container=false):SavePackage['entities'][number]{
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  const owned=(player?.components.inventory as Inventory|undefined)?.items??{};
  const here=player?.components.location?.location_id;
  const existing=save.entities.find(entity=>entity.components.item&&entity.components.identity?.name===name&&((owned[entity.id]??0)>0||Boolean(here&&entity.components.location?.location_id===here)));
  if(existing){if(container)existing.components.item.container=true;return existing;}
  assert(!save.entities.some(entity=>entity.components.item&&entity.components.identity?.name===name),
    '同名物品已有权威记录，不能在此重新补造');
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
    TRANSFER_ITEM:{ui:{label:'交付物品',visibility:'text',target_component:'character'},
      capability:{intent:'item_move',description:'将本人持有的一件物品交给同场人物；不代表对方答应任何其他条件',target_role:'person',parameter_roles:{item_id:'item'},completion_kind:'interaction_performed'},
      parameters:z.strictObject({item_id:id}),execute(c){
        const actor=c.store.entity(c.action.actor_id),target=c.action.target_id?c.store.entity(c.action.target_id):null;
        const itemId=String(c.action.parameters.item_id),inventory=actor.components.inventory as Inventory|undefined;
        assert(target?.components.character&&target.id!==actor.id&&target.components.location?.location_id===actor.components.location?.location_id,'接收物品的人不在同一地点');
        assert(inventory?.items[itemId]===1,'本人没有持有这件物品');
        assert(!Object.values(actor.components.equipment?.slots??{}).includes(itemId),'请先卸下这件物品');
        assert(!Object.entries(inventory.placements??{}).some(([child,parent])=>parent===itemId&&(inventory.items[child]??0)>0),'请先取出容器里的物品');
        delete inventory.items[itemId];if(inventory.placements)delete inventory.placements[itemId];
        target.components.inventory??={items:{}};(target.components.inventory as Inventory).items[itemId]=1;
        const item=c.store.entity(itemId);item.components.item!.owner_id=target.id;
        delete item.components.location;delete item.components.scene_position;
        c.result_entities.items=[itemId];c.advance(1);c.facts.push('物品已交给当前在场的接收者。');
      }},
    DAMAGE_ITEM:{ui:{label:'尝试损坏物品',visibility:'text',target_component:'item'},
      capability:{intent:'interact',description:'尝试损坏或销毁可接触的已登记物品，经 Core 判定；不能改变案件真相',target_role:'item',parameter_roles:{},completion_kind:'interaction_performed'},
      parameters:z.strictObject({extent:z.enum(['damage','destroy'])}),execute(c){
        const actor=c.store.entity(c.action.actor_id),item=c.action.target_id?c.store.entity(c.action.target_id):null;
        const owned=Number((actor.components.inventory?.items as Record<string,number>|undefined)?.[item?.id??'']??0)>0;
        assert(item?.components.item&&!item.components.item.stackable,'请选择一件已登记的非堆叠物品');
        assert(owned||item.components.location?.location_id===actor.components.location?.location_id,'物品不在可接触范围');
        assert(item.components.item.condition!=='destroyed','该物品已经损毁');
        const check=prepareCheck(c.save,c.action.id,{type:'SIMPLE_CHECK',domain:'physique',band:'normal',stakes:'尝试改变已存在物品的物理状态'},actor.id);
        const result=resolveCheck(c.save,check,c.rng);c.advance(1);
        if(result.outcome==='success'||result.outcome==='strong_success'){
          setItemCondition(c.save,item.id,c.action.parameters.extent==='destroy'?'destroyed':'damaged',c.action.id);
          c.facts.push(item.components.item.condition==='destroyed'?'已登记物品被损毁，原先获知的信息不会因此消失。':'已登记物品受到损坏。');
        }else c.facts.push('尝试没有改变这件物品的已确认状态。');
        c.result_entities.items=[item.id];
      }},
    MOVE_ITEM:{ui:{label:'移动物品',visibility:'text',target_component:'item'},
      capability:{intent:'item_move',description:'改变已登记物品在角色持有物或当前场景中的位置',target_role:'item',parameter_roles:{item_id:'item',to:'destination'},completion_kind:'item_location'},
      parameters:z.strictObject({item_id:id,to:z.enum(['held','container','scene','scene_container']),container_id:id.nullable().default(null),position_label:z.string().max(80).nullable().default(null)}),execute(c){
      const itemId=String(c.action.parameters.item_id),to=String(c.action.parameters.to);
      if(to==='scene')putItemInScene(c.save,itemId,String(c.action.parameters.position_label??'')||null,c.action.actor_id);
      else if(to==='scene_container')putItemInSceneContainer(c.save,itemId,String(c.action.parameters.container_id??''),c.action.actor_id);
      else {
        const item=c.save.entities.find(entity=>entity.id===itemId),player=c.save.entities.find(entity=>entity.id===c.action.actor_id);
        assert(item?.components.item&&player,'物品不存在');
        player.components.inventory??={items:{}};
        if((player.components.inventory as Inventory).items[itemId]!==1)assert(item.components.location?.location_id===player.components.location?.location_id,'物品不在当前场景');
        putItemInInventory(c.save,itemId,to==='container'?String(c.action.parameters.container_id??''):null,c.action.actor_id);
      }
      c.advance(1);c.facts.push(`物品位置已更新：${String(c.save.entities.find(entity=>entity.id===itemId)?.components.identity?.name??'物品')}。`);
    }},
  },
  panels: [{ id: 'inventory', label: '背包', module: 'inventory', order: 60, mobile_group: 'primary', presentation_type: 'panel' }],
  validate(save) {
    const singleHolders=new Set<string>();
    for (const e of save.entities) {
      const inventory=e.components.inventory as Inventory|undefined;
      for (const [itemId, n] of Object.entries(inventory?.items ?? {})) {
      const item = save.entities.find(i => i.id === itemId)?.components.item;
      assert(item, `未知物品 ${itemId}`); assert(item.stackable || n <= 1, '非堆叠物品数量超过 1');
      if(!item.stackable&&n>0){assert(!singleHolders.has(itemId),'同一非堆叠物品不能由多人同时持有');singleHolders.add(itemId);
        assert(!save.entities.find(entity=>entity.id===itemId)?.components.location,'持有物品不能同时位于场景');}
      if(item.owner_id)assert(item.owner_id===e.id,'物品持有者与归属记录不一致');
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
    for(const entity of save.entities)if(entity.components.item?.owner_id)
      assert(save.entities.some(owner=>owner.id===entity.components.item!.owner_id&&owner.components.character),
        '物品归属引用未知人物');
    for(const entity of save.entities)if(entity.components.item?.container_id){
      const parent=save.entities.find(other=>other.id===entity.components.item!.container_id);
      assert(parent?.components.item?.container===true&&parent.id!==entity.id&&
        entity.components.location?.location_id===parent.components.location?.location_id&&
        !entity.components.item.owner_id&&
        !save.entities.some(holder=>Number((holder.components.inventory?.items as Record<string,number>|undefined)?.[entity.id]??0)>0),
        '场景容器内容物引用无效');
    }
  },
};
