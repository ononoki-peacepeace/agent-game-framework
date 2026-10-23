import type {SavePackage} from '../core/schema.js';
import {publicView} from '../core/state.js';
import {relationshipSummary} from '../shared/relationship.js';
import {composePersonaContext} from '../characters/persona.js';
import {ProviderError} from './failures.js';

export const dialogueContinuityPolicy='按实际听到的回答承接对话，区分“对方已经回答”与“本人是否相信或接受”。已回答的问题不因缺少信任或好感数值而重新变成未答；需要追问时针对仍未回答的部分、具体矛盾或本人当下确有关系的顾虑，而非每次更换一种动机或承诺审查。职业、谨慎等只是人格的一部分，只有眼前话题与本人目的相关时才主导用语。人物可以接受、拒绝、犹豫、沉默或结束交谈，无须另设证明任务来显示独立性；这些选择不自动增加好感或改变关系。玩家长篇、正式的输入不规定 NPC 的句长、语气或答复结构。历史原话是说过什么的证据，不是当前台词模板；保持既有意愿，不照搬旧句式或逐轮自述原则。';
export const performanceContinuityPolicy='历史旁白仅用于保持已经发生的姿态、场景和表现连续，不是本轮行文范本。静态环境与姿态没有新意义时可以不再描述；不要为每次发言重复停顿、目光、手势或等待回应的收尾，也不要仅把旧微动作换成同义动作来凑变化。若当前只有一句话或沉默有意义，可以只呈现它。新动作仍需符合人物、身体状态与当前授权；不能为制造新鲜感新增道具、人物、声音、位置或其他世界变化。';
export const continuityGuidance='保持人物人格、记忆、关系和行为连续性。结合近期事件和当下首要目标作出反应，不使用固定情绪顺序。不强迫讲话或最低字数；沉默、逃离、僵住、拒绝均可，关键是符合人物和刚发生的事。只采用公开可观察信息；人物不能知道不在场时的私密事件。interaction 只描述交流是否持续：NPC 主动交谈可返回 active；明确结束、离开、不能交流可返回 ended，否则 null；target_id 必须是给定人物。安全边界优先，必要时概括或淡出，禁止把模型拒绝说明写作人物台词。';
export function characterContext(save:SavePackage,targetId?:string){
  const view=publicView(save),player=view.entities.find(e=>e.id===view.player_id);
  const characters=view.entities.filter(e=>e.components.character&&(e.id===targetId||e.components.location?.location_id===player?.components.location?.location_id)).slice(0,8);
  return {
    scene:{time:view.time,location:player?.components.location??null,local_position:player?.components.scene_position??null},
    conversation_focus:view.interaction_context??null,
    characters:characters.map(e=>({id:e.id,name:e.components.identity?.name,
      allowed_persona:composePersonaContext(save,e.id,1000,false,'narration')?.fields??{},
      public_description:String(e.components.identity?.description??'').slice(0,500),traits:e.components.traits??null,
      observable_condition:e.components.condition??null,relationship:relationshipSummary(view,e).text,
      knowledge_boundary:'只知道自身公开资料、现场可观察事实和以下与自己直接相关的互动；其余公开记录是叙述者上下文，不等同于该人物亲历。',
      recent_interactions:(save.action_facts??[]).filter(f=>f.target_id===e.id).slice(-4).map(f=>({facts:f.facts,time:f.time}))})),
    recent_turns:(save.narrative_history??[]).slice(-5).map(h=>({narrative:h.narrative.slice(0,1400),dialogue:h.dialogue?.slice(0,600)??null,facts:h.facts})),
    guidance:continuityGuidance,
  };
}
export function assertNotRefusal(value:{narrative?:string;dialogue?:string|null}){
  const text=[value.narrative,value.dialogue].filter(Boolean).join('\n');
  if(/作为(?:一个)?\s*(?:AI|人工智能|语言模型)|as an? (?:AI|language model)|(?:我|I)\s*(?:无法|不能|不能够|cannot|can't)\s*(?:协助|帮助|生成|提供|继续描写|help|assist|generate).{0,60}(?:内容|请求|场景|content|request)|违反.{0,12}(?:安全政策|内容政策)/i.test(text))throw new ProviderError('refusal','Narrative contains provider refusal','本段描写需要安全降级');
}
const normalize=(s:string)=>s.toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
function similarity(a:string,b:string){
  a=normalize(a);b=normalize(b);if(!a||!b)return 0;if(a===b)return 1;
  const grams=(s:string)=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));
  const x=grams(a),y=grams(b);return 2*[...x].filter(v=>y.has(v)).length/Math.max(1,x.size+y.size);
}
export function narrativeHealth(save:SavePackage,value:{narrative:string;dialogue?:string|null;speaker?:string|null},facts:string[]){
  const recent=(save.narrative_history??[]).slice(-3),text=value.narrative+' '+(value.dialogue??'');
  // A reply belongs to its speaker. Matching words from somebody else do not
  // establish a dialogue loop; shared descriptive prose is still comparable.
  // Two legacy unattributed records retain their former behavior, but an unknown
  // speaker is not evidence that a known character has already said something.
  const sameVoice=(entry:typeof recent[number])=>(entry.speaker??null)===(value.speaker??null);
  const recent_similarity=Math.max(0,...recent.map(h=>sameVoice(h)
    ?similarity(text,h.narrative+' '+(h.dialogue??'')):similarity(value.narrative,h.narrative)));
  const voiceHistory=recent.filter(sameVoice);
  const repeated_dialogue=!!value.dialogue&&voiceHistory.filter(h=>h.dialogue&&similarity(value.dialogue!,h.dialogue)>.9).length>=2;
  const generic=/^(你为什么这样|为什么要这样|我不知道|你想干什么|她愣住了|他愣住了)[。！？?！\s]*$/.test(text.trim());
  const factTokens=facts.flatMap(f=>f.match(/[\p{L}\p{N}]{2,}/gu)??[]).flatMap(t=>Array.from({length:Math.max(0,t.length-1)},(_,i)=>t.slice(i,i+2)));
  const context_coverage=factTokens.length?factTokens.filter(t=>text.includes(t)).length/factTokens.length:1;
  // Brevity alone is never a failure. An exact repeat needs history; silence with specific behavior is valid.
  const reasons=[...(recent_similarity>.87?['recent_repetition']:[]),...(repeated_dialogue?['dialogue_loop']:[]),...(generic&&context_coverage===0&&(value.dialogue?voiceHistory.length>0:recent.length>0)?['generic_without_context']:[])];
  return {detected:reasons.length>0,reason:reasons,repetition_score:recent_similarity,recent_similarity,context_coverage,generic_response_signal:generic};
}
