import type {SavePackage} from '../core/schema.js';
import {physicalStateSummary,visionBlocked,readPhysicalState} from '../core/perception-state.js';

/** The firewall rejects narration that contradicts these same facts, so the generator
 * has to see them. Nothing here authorises a new world change. */
export const narratorCognitionPolicy='character_cognition 的每一条只属于该人物本人。own_knowledge、own_beliefs 与 own_recent_experience 是他自己的认知和记忆，既不是世界真相，也不是别人知道的事：不要让一个人物说出或反应出另一个人物条目里的内容。own_recent_experience 也可包含仍重要的早期记忆，以 at 为事件时间，不把回忆写成本轮新事件。event_ref 只追溯记忆来源，participant_ids 只表示参与者集合，不表示说话人或承诺的收件人；原摘要未指明时不能据此猜测。旧约定不证明后来履约，较晚的澄清也只证明记忆中记录过的说法，须保留人物与时间归属。source_type 为 told_by 或 inferred 的内容只是他听说或推测的，不能写成已确认事实；confidence 低的条目本人也可能记错、怀疑或说错。own_active_goals 影响他此刻关心什么、愿意配合到哪一步，不是要他宣读目标。authoritative_body 与 sight 是结算后的权威状态：sight.blocked 为 true 的人物当时没有视觉信息，不得描写他看见、目睹或看清这次动作的经过，但他可以凭触觉、声音、疼痛、气味和既有认知作出反应；posture、eyes 与 restrained_by 不得与这里给出的状态矛盾。这些字段只约束如何呈现已经结算的事实，不授权新增伤害、物品、关系或其他世界变化。';

/** Reserve the salient event plus important and latest player experiences, then
 * fill with recent events. Selection stays bounded to three and chronological;
 * relevance comes from canonical participant IDs, never text/name guesses. */
function rememberedExperiences(memories:NonNullable<SavePackage['npc_agent_state']>[string]['memories'],playerId:string){
  const ordered=[...memories].sort((a,b)=>a.at.day-b.at.day||a.at.minute-b.at.minute);
  const mostImportant=(items:typeof memories)=>items.reduce<typeof memories[number]|undefined>((best,item)=>
    !best||item.importance>=best.importance?item:best,undefined);
  const related=ordered.filter(item=>item.participant_ids.includes(playerId));
  const selected=new Set([mostImportant(ordered),mostImportant(related),related.at(-1)]
    .filter(item=>item!==undefined));
  for(let index=ordered.length-1;index>=0&&selected.size<3;index--)selected.add(ordered[index]);
  return ordered.filter(item=>selected.has(item));
}

/** Per-character private cognition and authoritative body state for the presentation layer.
 * Read-only: the player's own cognition stays the player's, so only characters are included. */
export function narratorCharacterCognition(save:SavePackage,ids:readonly string[]){
  const relevant=[save.player_state.entity_id,...new Set(ids)];
  const priority=(id:string)=>{const index=relevant.indexOf(id);return index<0?relevant.length:index;};
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
        .sort(([a],[b])=>priority(a)-priority(b)).slice(0,6).map(([target_id,dimensions])=>({target_id,dimensions})),
      own_active_goals:(mind?.goals??[]).filter(goal=>goal.status==='active')
        .sort((a,b)=>b.priority-a.priority).slice(0,3)
        .map(goal=>({description:goal.description,horizon:goal.horizon})),
      // Canonical statements are already capped at 500 characters. Keep them whole:
      // a prefix can erase a negation, condition or correction; bound entry counts instead.
      own_knowledge:(mind?.knowledge??[]).slice(-5).map(item=>({proposition:item.proposition,
        source_type:item.source_type,source_ref:item.source_ref,confidence:item.confidence})),
      own_beliefs:(mind?.beliefs??[]).slice(-3).map(item=>({proposition:item.proposition,
        stance:item.stance})),
      own_recent_experience:rememberedExperiences(mind?.memories??[],save.player_state.entity_id).map(item=>({kind:item.kind,
        event_ref:item.event_ref,participant_ids:[...item.participant_ids],historical:true,
        summary:item.summary,at:{...item.at}})),
    }];
  });
}
