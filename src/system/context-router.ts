import {z} from 'zod';
import type {GameService} from '../server/service.js';
import {publicView} from '../core/state.js';
import {assert} from '../core/schema.js';
import {capabilityDigest,shallowUnderstanding} from './understanding.js';
import {systemSessionContext} from './session.js';
import {planMeta} from './router.js';
import {fastPlan} from '../agent/planner.js';
import {recentReferent} from '../core/recent-referent.js';
import {sanitizePlayerText} from './player-copy.js';
/** A clarification answer belongs to the message right after the question; older entries are forgotten. */
const pendingTtlMs=10*60*1000;

export const contextRouteSchema=z.strictObject({
  destination:z.enum(['WORLD_INTENT','SYSTEM_META_INTENT','AMBIGUOUS']),confidence:z.number().min(0).max(1),
  clarification:z.string().max(600).nullable(),speech_target_id:z.string().nullable(),
  resolved_input:z.string().max(2000).nullable().default(null),world_input:z.string().max(2000).nullable(),end_conversation:z.boolean().default(false),
});
export type ContextRoute=z.infer<typeof contextRouteSchema>;
export type SourceContext='world_input'|'system_input';
export async function readContextView(service:GameService){const save=await service.storage.read();return save?publicView(save):null;}
const pending=new WeakMap<GameService,Map<string,{input:string;question:string;at:number}>>();
/** Read-only semantic gate. Failure to understand never grants permission to execute. */
export async function routeContext(service:GameService,input:string,source:SourceContext):Promise<ContextRoute>{
  const save=await service.storage.read();assert(save,'请先载入世界');
  const view=publicView(save),key=save.game_id+':'+source;
  const memory=pending.get(service)??new Map();pending.set(service,memory);
  const session=systemSessionContext(service,save.game_id);
  const quick=fastPlan(view,input),metaPlan=planMeta(input,view.capabilities),shallowGuess=shallowUnderstanding(input,view);
  const stored=memory.get(key);
  // The last question stays available as *context* for a plausible answer, but an entry that outlived the
  // clarification window is forgotten. Nothing from it may execute: the executed sentence is always the
  // player's current one, and System writes are bound to their own request.
  const fresh=Boolean(stored)&&Date.now()-(stored?.at??0)<pendingTtlMs;
  if(!fresh)memory.delete(key);
  const previous=stored&&fresh?stored:undefined;
  const salient=recentReferent(save);
  const context={source_context:source,input,pending:previous?{input:previous.input,question:previous.question}:null,
    system_session:source==='system_input'?session:null,
    interaction_context:source==='world_input'?view.interaction_context??null:null,
    recent_scene:{primary:salient.primary?.name??null,primary_id:salient.primary?.id??null,last_target:salient.last_target?.name??null,conflict_target:salient.conflict_target?.name??null,last_event:salient.last_event??null,recent_turns:(save.narrative_history??[]).slice(-2).map(entry=>({narrative:String(entry.narrative??'').slice(0,240),dialogue:entry.dialogue??null,speaker:entry.speaker??null}))},
    public_scene:{characters:view.entities.filter(e=>e.components.character).map(e=>({id:e.id,name:e.components.identity?.name,location:e.components.location??null})),player_location:view.entities.find(e=>e.id===view.player_id)?.components.location??null},
    capability_digest:capabilityDigest(view,save),
  };
  const fixed=(destination:ContextRoute['destination']):ContextRoute=>({destination,confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false});
  if(!previous){
    const systemKnown=!['UNKNOWN','IN_WORLD_INPUT'].includes(metaPlan.category);
    const writingWorld=quick?.goals.some(g=>['WORLD_ACTION','WORLD_SPEECH','CONTINUE_ROUTINE','EXECUTE_FUTURE'].includes(g.type));
    if(source==='system_input'&&session&&['waiting_for_clarification','waiting_for_confirmation'].includes(session.status)&&!writingWorld)return fixed('SYSTEM_META_INTENT');
    if(systemKnown&&!writingWorld)return fixed('SYSTEM_META_INTENT');
    const planned=quick?.goals.some(g=>['CONDITIONAL_INTENT','FUTURE_INTENT','SCHEDULED_INTENT'].includes(g.type));
    if(planned&&!['behavior_config','media_asset','development_task','module_management'].includes(shallowGuess.likely_workflow))return fixed('WORLD_INTENT');
  }
  let result:ContextRoute|null=null;
  if(service.ai.adapter?.name!=='mock')result=await service.ai.systemAgent(contextRouteSchema,save.definition.prompt_profile,{
    instruction:'你是现有 System understanding 的跨输入语境理解层。只读判别，不执行。输入来源是强提示而非硬边界。角色行动、查询世界、说话是 WORLD_INTENT；调整界面、玩法、风格、模块、人物图片是 SYSTEM_META_INTENT。复用系统会话理解范围修正与澄清答案；澄清回答必须结合 pending 的原请求，并在 resolved_input 返回合并后不改变原意的完整请求；无 pending 则 null。两个合理解释并存或同时要求跨两种语境操作时必须 AMBIGUOUS 并用自然语言精准澄清，不允许任何写入。不要因为系统框就把角色动作当开发；不要因为世界框就把风格请求当台词。只有 world_input 才能继承 interaction_context，对当前交谈者的简短后续提问可为 WORLD_INTENT 并填写 speech_target_id；System 框不能自动继承 NPC。明确新目标覆盖旧目标；多个合理目标应澄清。world_input 字段仅在确认世界说话时填写原话（不是模拟结果），其余 null。end_conversation 仅用于玩家明确结束交谈；不推断 NPC 必须回答。高置信度 >=0.8 才执行，否则澄清。玩家的短句（再揍她一拳／再来一下／追上去／拦住她／她怎么了）必须优先解析到 recent_scene 的最近对象；代词与最近对象明显冲突时只做一句自然澄清（例如「你是指刚才的伊芙琳吗？」）；绝不能声称没有任何前文，也不得说出字段名、内部标识或系统模块名。',...context,
  },structuredClone(save));
  if(!result){
    const meta=planMeta(input,view.capabilities),shallow=shallowUnderstanding(input,view),world=fastPlan(view,input);
    const knownMeta=!['UNKNOWN','IN_WORLD_INPUT'].includes(meta.category);
    const explicitMeta=knownMeta||shallow.likely_workflow!=='unclear'&&['behavior_config','media_asset','development_task','module_management','diagnostic'].includes(shallow.likely_workflow);
    // Existing recognizers are an offline fallback only. Conflicting interpretations remain unresolved.
    const worldOnly=world&&!explicitMeta;
    result={destination:explicitMeta?'SYSTEM_META_INTENT':worldOnly?'WORLD_INTENT':'AMBIGUOUS',confidence:worldOnly||explicitMeta?0.85:0,
      resolved_input:null,clarification:null,speech_target_id:null,world_input:null,end_conversation:false};
    if(source==='system_input'&&session&&['waiting_for_clarification','waiting_for_confirmation'].includes(session.status)&&!world){result.destination='SYSTEM_META_INTENT';result.confidence=.85;}
  }
  if(result.destination==='AMBIGUOUS'||result.confidence<.8){
    const fallbackQuestion=salient.primary?`你是指刚才的${salient.primary.name}吗？还是想调整游戏本身的设置？`:'你是在对世界中的人物说这句话，还是想修改游戏的回复方式或功能？';
    result={...result,destination:'AMBIGUOUS',speech_target_id:null,world_input:null,clarification:sanitizePlayerText(result.clarification||fallbackQuestion,fallbackQuestion)};
    memory.set(key,{input:previous?.input??input,question:result.clarification!,at:Date.now()});
  }else{
    if(result.speech_target_id){assert(result.destination==='WORLD_INTENT','对话目标只允许世界请求');assert(view.entities.some(e=>e.id===result!.speech_target_id&&e.components.character&&e.id!==view.player_id),'请明确一个当前可见的交谈对象');}
    memory.delete(key);
  }
  return result;
}
