import type {PublicView} from './contracts.js';
/** A player-selected scene interaction. It is request context, never rewritten player speech. */
export interface NpcConversationContext {
  source:'npc_interaction';
  target_id:string;
  mode:'conversation';
}
/** Use one authoritative snapshot for both scene membership and target validation. */
export function npcPresentInView(view:Pick<PublicView,'player_id'|'entities'>,targetId:string){
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const target=view.entities.find(entity=>entity.id===targetId);
  const here=player?.components.location?.location_id;
  return Boolean(here&&targetId!==view.player_id&&target?.components.character&&
    target.components.location?.location_id===here);
}
