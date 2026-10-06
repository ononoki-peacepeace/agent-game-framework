import {z} from 'zod';
import type {GameService} from '../server/service.js';
import type {PublicView} from '../shared/contracts.js';
import {contextEnvelope,type InputSurface} from '../system/context-envelope.js';
import {worldQueryEvidence} from './truth-query.js';
import {recentReferent} from '../core/recent-referent.js';

const semanticDecisionSchema=z.strictObject({
  domain:z.enum(['world','system','ambiguous']),
  kind:z.enum(['read_only','world_action','system_operation','clarification']),
  confidence:z.number().min(0).max(1),
  answer:z.string().max(1200).nullable(),
  answer_basis:z.enum(['world_fact','world_rule','general_knowledge','reasoned_advice','unknown']).nullable(),
  evidence_ids:z.array(z.string()).max(12),
  clarification:z.string().max(400).nullable(),
  speech_target_id:z.string().nullable(),
});
export type SemanticDecision=z.infer<typeof semanticDecisionSchema>;

/** One model-owned interpretation for free text from either composer. No tool or state write occurs here. */
export async function interpretSemanticEntry(service:GameService,view:PublicView,input:string,surface:InputSurface,
  pending?:{input:string;question:string}|null,systemSession?:unknown):Promise<SemanticDecision|null>{
  const save=await service.storage.read();
  if(!save||save.game_id!==view.game_id)return null;
  const publicHistory=(save.narrative_history??[]).slice(-3).map((entry,index)=>({
    id:`recent_turn:${index}`,kind:'observation' as const,
    value:{narrative:entry.narrative.slice(0,700),dialogue:entry.dialogue,
      speaker:entry.speaker?view.entities.find(entity=>entity.id===entry.speaker)?.components.identity?.name??null:null},
  }));
  const evidence=[...worldQueryEvidence(view,input).slice(0,240),...publicHistory,
    ...(view.last_turn?.dialogue?[{id:'last_dialogue',kind:'observation' as const,
      value:{dialogue:view.last_turn.dialogue,speaker:view.last_turn.speaker?
        view.entities.find(entity=>entity.id===view.last_turn!.speaker)?.components.identity?.name??null:null}}]:[])];
  const visibleIds=new Set(evidence.map(entry=>entry.id));
  const context={
    input,pending_clarification:pending??null,system_session:systemSession??null,
    context_envelope:contextEnvelope(view,input,surface),
    world:{title:view.title,time:view.time,player_id:view.player_id,
      location:view.entities.find(entity=>entity.id===view.player_id)?.components.location??null,
      visible_entities:view.entities.map(entity=>({id:entity.id,name:entity.components.identity?.name??null,
        type:entity.type,location:entity.components.location??null})),
      capabilities:view.capabilities,interaction_context:surface==='WORLD'?view.interaction_context??null:null,
      recent_scene:view.last_turn?.narrative?.slice(0,700)??null,
      recent_referent:surface==='WORLD'?recentReferent(save):null},
    public_evidence:evidence,
  };
  const instruction='你是游戏与系统两个自由文本入口共用的只读语义理解器，只输出 JSON，不调用工具、不执行行动。先根据本句、对话语境和公开世界资料判断真实意图；输入入口只说明操作权限，不改变句子的基本语义。普通询问、事实查询、讨论、建议、假设、可行性评估都用 read_only，并在 answer 给出有帮助的回答；清点已登记的自身物品等只需读取现有状态的请求也可直接回答，不为展示信息制造行动。它们绝不等于授权执行。只有玩家明确要求角色现在尝试会改变世界的行为，才用 world_action。只有明确要求更改游戏设置、管理模块、创建或修改功能，才用 system_operation；这类请求可交给现有 System 权限与参数处理，不因偏好程度尚可细化而先当成两种意图的歧义。缺少能力的普通游戏问题不能升级为开发任务。多个合理解释且结果不同才 clarification。系统输入框中的角色行动仍是 world_action；游戏输入框中的明确系统管理请求仍是 system_operation。若 read_only 涉及世界事实或规则，只引用 public_evidence 中确实支持结论的 ID；recent_turn 和 last_dialogue 是已提交且玩家可见的交谈记录，足以回答对应的过去事件。未知事实说明未知，不得编造。一般知识和建议标注其性质，不把它们写成已确认的世界事实。不得把 NPC 曾被谈及当成本句一定是对其说话。speech_target_id 仅在玩家明确对某个公开人物说话、且人物可唯一绑定时填写；否则为 null。confidence 低于 0.8 时用 clarification。answer_basis 只用于 read_only，其余为 null。';
  // One correction is allowed only before any action has been planned or committed.
  // The original input and evidence are unchanged on the second pass.
  let decision:SemanticDecision|null=null;
  for(let attempt=0;attempt<2;attempt++){
    decision=await service.ai.systemAgent(semanticDecisionSchema,save.definition.prompt_profile,{
      instruction,...context,
      ...(attempt?{correction:'上一份解释没有通过公开事实或目标校验。重新依据原始请求与 public_evidence 作答；无法证实的世界事实应明确说明未知。不得声称任何行动已执行。'}:{}),
    },{...save,ai:{threads:{}}});
    if(!decision)return null;
    const unsupported=decision.kind==='read_only'&&(!decision.answer?.trim()||
      decision.evidence_ids.some(id=>!visibleIds.has(id))||
      ((decision.answer_basis==='world_fact'||decision.answer_basis==='world_rule')&&decision.evidence_ids.length===0));
    const badRoute=decision.kind==='world_action'&&decision.domain!=='world'||
      decision.kind==='system_operation'&&decision.domain!=='system';
    const badTarget=Boolean(decision.speech_target_id)&&!view.entities.some(entity=>entity.id===decision!.speech_target_id&&entity.components.character);
    if(!unsupported&&!badRoute&&!badTarget)break;
    if(attempt===1)return null;
  }
  if(!decision)return null;
  if(decision.confidence<0.8||decision.domain==='ambiguous'||decision.kind==='clarification')
    return {...decision,domain:'ambiguous',kind:'clarification',answer:null,answer_basis:null,evidence_ids:[],
      clarification:decision.clarification||'这句话有两种可能的意思，你想询问，还是让角色现在实际行动？',speech_target_id:null};
  return decision;
}
