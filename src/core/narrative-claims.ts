import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {narrativeResultSchema} from '../ai/contracts.js';
import {GameError,type SavePackage} from './schema.js';
import {addDynamicLocation,currentMap} from './map.js';
import {ensureOrdinaryItem,putItemInInventory,putItemInScene,type Inventory} from '../modules/inventory.js';

type NarrativeResult=Pick<z.infer<typeof narrativeResultSchema>,'narrative'> & Partial<Pick<z.infer<typeof narrativeResultSchema>,'item_claims'|'stable_locations'>>;
/** Validate model observations against public context, then materialize through existing map/item primitives. */
export function applyNarrativeClaims(save:SavePackage,result:NarrativeResult){
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const here=String(player.components.location?.location_id??'');
  if(result.item_claims?.length&&!save.definition.enabled_modules.includes('inventory'))throw new GameError('这次物品描写与当前世界能力不一致，本回合尚未结算，可以安全重试。',503);
  const names=new Set<string>();
  const claims=[...(result.item_claims??[])].sort((a,b)=>Number(b.container)-Number(a.container));
  for(const claim of claims){
    const name=claim.name.trim();
    if(!result.narrative.includes(name)||names.has(name))throw new GameError('这次物品描写与世界状态不一致，本回合尚未结算，可以安全重试。',503);
    names.add(name);
    const item=ensureOrdinaryItem(save,name,claim.weight,claim.container);
    const owned=(player.components.inventory as Inventory).items;
    if(claim.placement==='inside_container'){
      const containerName=claim.container_name?.trim();
      if(!containerName||!result.narrative.includes(containerName))throw new GameError('这次物品容器缺少可验证的场景依据，本回合尚未结算，可以安全重试。',503);
      const container=ensureOrdinaryItem(save,containerName,0.3,true);
      if((owned[container.id]??0)===0)putItemInInventory(save,container.id);
      putItemInInventory(save,item.id,container.id);
    }else if(claim.placement==='held')putItemInInventory(save,item.id);
    else{
      if(!here)throw new GameError('当前场景没有可登记的物品位置，本回合尚未结算，可以安全重试。',503);
      if((owned[item.id]??0)===1)putItemInScene(save,item.id,claim.position_label);
      else{item.components.location={location_id:here};if(claim.position_label)item.components.scene_position={label:claim.position_label};}
      item.components.item.tracking=claim.placement==='incidental'?'incidental':'tracked';
    }
  }
  if(!save.definition.enabled_modules.includes('map')||!here)return save;
  const previous=[save.last_turn?.narrative??'',...(save.narrative_history??[]).map(turn=>turn.narrative)];
  for(const proposal of result.stable_locations??[]){
    const name=proposal.name.trim();
    if(!proposal.reenterable||!proposal.interactive||proposal.parent_id!==here||!result.narrative.includes(name)||!previous.some(text=>text.includes(name)))continue;
    if(currentMap(save).locations.some(location=>location.name===name&&location.parent_id===here))continue;
    const locationId=`loc_${randomUUID().replaceAll('-','').slice(0,24)}`;
    addDynamicLocation(save,{id:locationId,name,description:'可再次进入的场景空间',tags:[],parent_id:here,kind:'sublocation',known_by_default:true},[
      {from:here,to:locationId,travel_minutes:proposal.travel_minutes,conditions:[]},
      {from:locationId,to:here,travel_minutes:proposal.travel_minutes,conditions:[]},
    ]);
  }
  return save;
}
