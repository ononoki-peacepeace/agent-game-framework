import type {SavePackage} from '../core/schema.js';
import {physicalStateSummary,visionBlocked,readPhysicalState} from '../core/perception-state.js';

/** The firewall rejects narration that contradicts these same facts, so the generator
 * has to see them. Nothing here authorises a new world change. */
export const narratorCognitionPolicy='character_cognition 的每一条只属于该人物本人。own_knowledge、own_beliefs 与 own_recent_experience 是他自己的认知和记忆，既不是世界真相，也不是别人知道的事：不要让一个人物说出或反应出另一个人物条目里的内容。source_type 为 told_by 或 inferred 的内容只是他听说或推测的，不能写成已确认事实；confidence 低的条目本人也可能记错、怀疑或说错。own_active_goals 影响他此刻关心什么、愿意配合到哪一步，不是要他宣读目标。authoritative_body 与 sight 是结算后的权威状态：sight.blocked 为 true 的人物当时没有视觉信息，不得描写他看见、目睹或看清这次动作的经过，但他可以凭触觉、声音、疼痛、气味和既有认知作出反应；posture、eyes 与 restrained_by 不得与这里给出的状态矛盾。这些字段只约束如何呈现已经结算的事实，不授权新增伤害、物品、关系或其他世界变化。';

/** Per-character private cognition and authoritative body state for the presentation layer.
 * Read-only: the player's own cognition stays the player's, so only characters are included. */
export function narratorCharacterCognition(save:SavePackage,ids:readonly string[]){
  return [...new Set(ids)].flatMap(id=>{
    const entity=save.entities.find(item=>item.id===id&&item.components.character);
    if(!entity||id===save.player_state.entity_id)return [];
    const state=readPhysicalState(entity),sight=visionBlocked(entity),mind=save.npc_agent_state?.[id];
    return [{
      id,name:String(entity.components.identity?.name??id),
      authoritative_body:{summary:physicalStateSummary(entity),posture:state.posture,eyes:state.eyes,
        restrained_by:state.restrained_by},
      sight:{blocked:sight.blocked,reason:sight.reason},
      own_relationships:Object.entries((entity.components.relationships?.entries??{}) as Record<string,Record<string,number>>)
        .slice(0,6).map(([target_id,dimensions])=>({target_id,dimensions})),
      own_active_goals:(mind?.goals??[]).filter(goal=>goal.status==='active')
        .sort((a,b)=>b.priority-a.priority).slice(0,3)
        .map(goal=>({description:goal.description,horizon:goal.horizon})),
      own_knowledge:(mind?.knowledge??[]).slice(-5).map(item=>({proposition:item.proposition.slice(0,200),
        source_type:item.source_type,source_ref:item.source_ref,confidence:item.confidence})),
      own_beliefs:(mind?.beliefs??[]).slice(-3).map(item=>({proposition:item.proposition.slice(0,200),
        stance:item.stance})),
      own_recent_experience:(mind?.memories??[]).slice(-3).map(item=>({kind:item.kind,
        summary:item.summary.slice(0,200),at:item.at})),
    }];
  });
}
