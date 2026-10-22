import type {PublicView} from '../shared/contracts.js';
import {resolveEntities} from '../agent/entities.js';
import type {SavePackage} from '../core/schema.js';

export interface AuthoritativeItemContext {
  item_id:string;
  name:string;
  quantity:number;
  placement:'held'|'scene'|'inside_container'|'worn'|'unknown';
  container_id:string|null;
  location_id:string|null;
  holder_id:string|null;
  condition:string;
  container_access:'open'|'sealed'|'unknown';
  consumable?:{method:'eat'|'drink'|'use';minutes:number};
}

/** A compact, read-only inventory projection for model binding and narration.
 * IDs and quantities come from the current public projection; prose never adds
 * entries here. */
export function authoritativeItemContext(view:PublicView):AuthoritativeItemContext[]{
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const inventory=(player?.components.inventory??{}) as {items?:Record<string,number>;placements?:Record<string,string|null>};
  const local=player?.components.location?.location_id;
  return view.entities.filter(entity=>Boolean(entity.components.item)).flatMap(entity=>{
    const item=entity.components.item as {owner_id?:string|null;container_id?:string|null;placement?:string}|undefined;
    const quantity=Number(inventory.items?.[entity.id]??0);
    const location=entity.components.location?.location_id;
    // Ownership is provenance, not current possession. Scene items (including
    // scene-container contents) never enter the player's inventory projection.
    const held=quantity>0;
    if(!held&&location!==local)return [];
    const containerId=held?inventory.placements?.[entity.id]??null:item?.container_id??null;
    const slots=player?.components.equipment?.slots as Record<string,string|null>|undefined;
    const worn=held&&Object.values(slots??{}).includes(entity.id);
    let access:AuthoritativeItemContext['container_access']='open';
    let parentId=containerId;const seen=new Set([entity.id]);
    while(parentId){
      const parent=view.entities.find(candidate=>candidate.id===parentId);
      if(seen.has(parentId)||parent?.components.item?.container!==true){access='unknown';break;}
      seen.add(parentId);
      if((parent.components.item.tags as string[]|undefined)?.includes('sealed')){access='sealed';break;}
      parentId=held?inventory.placements?.[parent.id]??null:(parent.components.item.container_id as string|undefined)??null;
    }
    const placement:AuthoritativeItemContext['placement']=!held?'scene':worn?'worn':containerId?'inside_container':'held';
    return [{item_id:entity.id,name:String(entity.components.identity?.name??entity.id),quantity:held?quantity:1,
      placement,container_id:typeof containerId==='string'?containerId:null,
      location_id:typeof location==='string'?location:null,holder_id:held?view.player_id:null,
      condition:String(entity.components.item?.condition??'intact'),container_access:access,
      ...(entity.components.item?.consumable?{consumable:entity.components.item.consumable as AuthoritativeItemContext['consumable']}:{})}];
  });
}

/** Chronological settlement evidence; action wording alone never proves travel. */
export function recentSettledActions(save:SavePackage,actorId=save.player_state.entity_id){
  return (save.resolution_receipts??[]).filter(receipt=>receipt.actor_id===actorId&&receipt.commit_status==='committed')
    .slice(-6).map((receipt,index)=>({sequence:index,request_id:receipt.request_id,
      attempted_action:receipt.semantic_action,at:receipt.at??null,effects:receipt.effects,
      movement_route:receipt.movement_route??null,activity:receipt.activity??null,
      facts:save.resolution_history?.some(check=>check.check_id===receipt.check_id&&check.hidden)?[]:
        receipt.canonical_facts.slice(0,4)}));
}

/** Binding needs current facts, not UI panels, all old stories or goal snapshots. */
export function actionBindingContext(view:PublicView,input:string){
  const actor=view.entities.find(entity=>entity.id===view.player_id);
  const here=actor?.components.location?.location_id;
  const mentioned=new Set(resolveEntities(view,input).matches.map(entity=>entity.id));
  return {
    game_id:view.game_id,revision:view.revision,title:view.title,description:view.description,
    player_id:view.player_id,time:view.time,minutes_per_day:view.minutes_per_day,
    capabilities:view.capabilities,currencies:view.currencies,
    authoritative_inventory:authoritativeItemContext(view).filter(item=>item.placement!=='scene'),
    visible_scene_items:authoritativeItemContext(view).filter(item=>item.placement==='scene'),
    actions:view.actions,panels:view.panels,modules:view.modules,
    future_intents:view.future_intents,scheduled_tasks:view.scheduled_tasks,
    interaction_context:view.interaction_context??null,
    entities:view.entities.filter(entity=>entity.id===view.player_id||mentioned.has(entity.id)||
      entity.components.location?.location_id===here||!entity.components.character),
    locations:view.locations.map(place=>({id:place.id,name:place.name,parent_id:place.parent_id,
      kind:place.kind,description:place.id===here||input.includes(place.name)?place.description:''})),
    routes:view.routes,
    recent_turn:view.last_turn?{narrative:view.last_turn.narrative.slice(-900),
      speech:(view.last_turn.scene_beats??[]).filter(beat=>beat.kind==='speech').slice(-12),
      speaker:view.last_turn.speaker,dialogue:view.last_turn.dialogue}:null,
  };
}
