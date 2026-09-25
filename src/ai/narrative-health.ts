import type {SavePackage} from '../core/schema.js';
import {publicView} from '../core/state.js';
import {relationshipSummary} from '../shared/relationship.js';
import {ProviderError} from './failures.js';

export const continuityGuidance='保持人物人格、记忆、关系和行为连续性。结合近期事件和当下首要目标作出反应，不使用固定情绪顺序。不强迫讲话或最低字数；沉默、逃离、僵住、拒绝均可，关键是符合人物和刚发生的事。只采用公开可观察信息；人物不能知道不在场时的私密事件。interaction 只描述交流是否持续：NPC 主动交谈可返回 active；明确结束、离开、不能交流可返回 ended，否则 null；target_id 必须是给定人物。安全边界优先，必要时概括或淡出，禁止把模型拒绝说明写作人物台词。';
export function characterContext(save:SavePackage,targetId?:string){
  const view=publicView(save),player=view.entities.find(e=>e.id===view.player_id);
  const characters=view.entities.filter(e=>e.components.character&&(e.id===targetId||e.components.location?.location_id===player?.components.location?.location_id)).slice(0,8);
  return {
    scene:{time:view.time,location:player?.components.location??null,local_position:player?.components.scene_position??null},
    conversation_focus:view.interaction_context??null,
    characters:characters.map(e=>({id:e.id,name:e.components.identity?.name,profile:e.components.character,allowed_persona:{description:String(e.components.character_card?.description??e.components.identity?.description??'').slice(0,1800),personality:String(e.components.character_card?.personality??'').slice(0,1800)},traits:e.components.traits??null,observable_condition:e.components.condition??null,relationship:relationshipSummary(view,e).text,
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
export function narrativeHealth(save:SavePackage,value:{narrative:string;dialogue?:string|null},facts:string[]){
  const recent=(save.narrative_history??[]).slice(-3),text=value.narrative+' '+(value.dialogue??'');
  const recent_similarity=Math.max(0,...recent.map(h=>similarity(text,h.narrative+' '+(h.dialogue??''))));
  const repeated_dialogue=!!value.dialogue&&recent.filter(h=>h.dialogue&&similarity(value.dialogue!,h.dialogue)>.9).length>=2;
  const generic=/^(你为什么这样|为什么要这样|我不知道|你想干什么|她愣住了|他愣住了)[。！？?！\s]*$/.test(text.trim());
  const factTokens=facts.flatMap(f=>f.match(/[\p{L}\p{N}]{2,}/gu)??[]).flatMap(t=>Array.from({length:Math.max(0,t.length-1)},(_,i)=>t.slice(i,i+2)));
  const context_coverage=factTokens.length?factTokens.filter(t=>text.includes(t)).length/factTokens.length:1;
  // Brevity alone is never a failure. An exact repeat needs history; silence with specific behavior is valid.
  const reasons=[...(recent_similarity>.87?['recent_repetition']:[]),...(repeated_dialogue?['dialogue_loop']:[]),...(generic&&context_coverage===0&&recent.length>0?['generic_without_context']:[])];
  return {detected:reasons.length>0,reason:reasons,repetition_score:recent_similarity,recent_similarity,context_coverage,generic_response_signal:generic};
}
