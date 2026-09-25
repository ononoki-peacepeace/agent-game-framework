import type { Action, SavePackage } from './schema.js';
import type { PublicView } from '../shared/contracts.js';

export function sceneAnchor(entity: {components:Record<string,any>}|undefined) {
  return JSON.stringify([entity?.components.location?.location_id??null,entity?.components.scene_position?.label??null]);
}
export function activeFocus(save:SavePackage) {
  const focus=save.interaction_context;
  if(!focus||focus.status!=='active')return undefined;
  const actor=save.entities.find(e=>e.id===save.player_state.entity_id),target=save.entities.find(e=>e.id===focus.target_entity_id);
  if(!target?.components.character||!actor||sceneAnchor(actor)!==focus.scene_anchor)return undefined;
  if(actor.components.location?.location_id!==target.components.location?.location_id)return undefined;
  if(target.components.scene_position?.label&&actor.components.scene_position?.label!==target.components.scene_position.label)return undefined;
  if(Number(target.components.condition?.hp??1)<=0)return undefined;
  return focus;
}
export function updateInteraction(save:SavePackage,action:Action,previous:SavePackage,directive?:{target_id:string;status:'active'|'ended'}|null) {
  const social=['TALK','SOCIAL_INTERACT'].includes(action.type);
  const targetId=directive?.status==='active'?directive.target_id:social?action.target_id:save.last_turn?.speaker;
  if(targetId&&targetId!==save.player_state.entity_id){
    const old=activeFocus(previous);
    save.interaction_context={mode:'conversation',target_entity_id:targetId,started_turn:old?.target_entity_id===targetId?old.started_turn:previous.state_revision+1,last_interaction_turn:previous.state_revision+1,scene_anchor:sceneAnchor(save.entities.find(e=>e.id===save.player_state.entity_id)),status:'active'};
  }else if(!['LOOK','WAIT'].includes(action.type)&&save.interaction_context)save.interaction_context.status='ended';
  if(directive?.status==='ended'&&save.interaction_context?.target_entity_id===directive.target_id)save.interaction_context.status='ended';
  if(save.interaction_context&&!activeFocus(save))save.interaction_context.status='ended';
}
export function publicFocus(view:PublicView){return view.interaction_context??null;}
