import {prepareNarrativeWorld,type NarrativeWorldKind} from './narrative-worlds.js';
import type {SavePackage} from '../../src/core/schema.js';
export async function consumptionWorld(kind:NarrativeWorldKind){
 const prepared=await prepareNarrativeWorld(kind),save=structuredClone(prepared.save);
 const bread={id:'qa_bread',type:'item',components:{identity:{name:'面包',description:'世界定义的食物',avatar_id:null},
  item:{weight:.1,stackable:true,consumable:{method:'eat',minutes:2}},discovery:{known_to_player:true}}};
 const other=structuredClone(bread);other.id='qa_other_bread';
 save.entities.push(bread,other);
 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
 (player.components.inventory!.items as Record<string,number>).qa_bread=3;
 (save.entities.find(e=>e.id==='npc_lin')!.components.inventory??={items:{}}).items={qa_other_bread:2};
 return {...prepared,save};
}
export const quantity=(save:SavePackage,itemId='qa_bread',actor='player')=>Number((save.entities.find(e=>e.id===actor)!.components.inventory?.items as Record<string,number>|undefined)?.[itemId]??0);
