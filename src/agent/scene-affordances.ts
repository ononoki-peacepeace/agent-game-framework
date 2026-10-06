import {z} from 'zod';
import {contextActionSchema} from '../core/schema.js';
import type {GameService} from '../server/service.js';
import {relationshipSummary} from '../shared/relationship.js';

/** Read-only scene suggestions. Only currently reachable characters may become targets. */
export async function sceneAffordances(service:GameService){
  const save=await service.current(),view=service.project(save),here=view.entities.find(item=>item.id===view.player_id)?.components.location?.location_id;
  const candidates=view.entities.filter(item=>item.id!==view.player_id&&item.components.character&&item.components.location?.location_id===here);
  if(!candidates.length)return [];
  const proposed=await service.ai.systemAgent(z.array(contextActionSchema).max(20),save.definition.prompt_profile,{
    instruction:'你只给当前场景中可见人物生成可选的软互动建议，不执行，不改状态。按场景、人物身份与外显状态、玩家关系、当前活动及已安装能力挑选自然且彼此有差异的行动；数量随真实机会变化，不要强行凑数。每项 target_id 必须在 candidates 中，intent 是玩家可直接发送的自然语言。每项给出 family；若需要更贴切的当前场景行为大类，可另给 category 简短名称，相同性质的建议使用同一 category。category 是一级类别，label 是点开后才显示的二级具体行动。硬机制没有登记时不可假装已支持。不能替玩家做选择，不能泄露秘密。只输出 JSON 数组。',
    scene:{location_id:here,location:view.locations.find(item=>item.id===here)?.name??null,time:view.time,visible_narrative:view.last_turn?.narrative??null,pending_choices:view.last_turn?.choices??[],scheduled_tasks:view.scheduled_tasks??[]},
    candidates:candidates.map(item=>({id:item.id,name:item.components.identity?.name??item.id,description:item.components.identity?.description??'',role:item.components.character?.role??'',relationship:relationshipSummary(view,item).text})),
    capabilities:view.capabilities,actions:view.actions.filter(item=>item.visibility!=='internal'),
  },save);
  const valid=new Set(candidates.map(item=>item.id));
  return (proposed??[]).filter(item=>valid.has(item.target_id));
}
