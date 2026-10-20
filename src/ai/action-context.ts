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
    const owned=quantity>0||item?.owner_id===view.player_id;
    const present=location===local;
    if(!owned&&!present)return [];
    const rawPlacement=inventory.placements?.[entity.id]!==undefined?
      (inventory.placements[entity.id]===null?'held':'inside_container'):
      item?.placement;
    const placement=(rawPlacement==='held'||rawPlacement==='scene'||rawPlacement==='inside_container'||rawPlacement==='worn')?rawPlacement:'unknown';
    return [{item_id:entity.id,name:String(entity.components.identity?.name??entity.id),quantity:quantity||1,
      placement,container_id:typeof (inventory.placements?.[entity.id]??item?.container_id)==='string'?(inventory.placements?.[entity.id]??item?.container_id) as string:null,
      location_id:typeof location==='string'?location:null}];
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
