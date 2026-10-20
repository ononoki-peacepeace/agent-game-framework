import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {GameService} from '../server/service.js';
import {behaviorPatchSchema,guidanceCategorySchema,type BehaviorPatch} from './guidance.js';
import {GameError} from '../core/schema.js';

const feedbackSchema=z.strictObject({
  decision:z.enum(['discussion','create']),
  category:guidanceCategorySchema.nullable(),title:z.string().max(100),
  trigger_semantics:z.string().max(240),preferred_behavior:z.string().max(400),anti_pattern:z.string().max(400),
  scope:z.enum(['session','world','global']).nullable(),reason:z.string().max(240),
  invariant_conflict:z.boolean(),
});
/** A semantic compiler, not a second game-intent router. It only returns an advisory configuration draft. */
export async function compileBehaviorFeedback(service:GameService,input:string,requestId?:string){
  const save=await service.current();
  const existing=await service.behaviorGuidance();
  const replay=requestId?existing.filter(patch=>patch.id===requestId):[];
  if(replay.length){
    if(replay.length!==1||replay[0].source_text!==input)throw new GameError('请求 ID 已用于另一项指导或多个范围',409);
    return {kind:'create' as const,patch:replay[0],overridden:null};
  }
  const proposal=await service.ai.systemAgent(feedbackSchema,save.definition.prompt_profile,{
    instruction:'Classify only whether this System message explicitly asks the assistant to behave differently in future similar situations. A complaint, question, ordinary world discussion, request for new software or immediate prose style preference is discussion, not persistent learning. Return create only for explicit forward-looking AI reasoning/decision guidance. Compile a short semantic trigger, preferred reasoning behavior and anti-pattern; never copy a full user sentence into preferred_behavior. Choose session only for this session, world by default, global only for explicit all-world scope. Framework invariants (player-only control, independent NPC will, committed state, truth and knowledge boundaries) cannot be overridden. Return invariant_conflict=true if requested. No world action.',
    input,existing:existing.map(p=>({id:p.id,title:p.title,category:p.category,scope:p.scope,trigger_semantics:p.trigger_semantics})),
  },save);
  if(!proposal||proposal.decision!=='create')return {kind:'discussion' as const,reason:proposal?.reason??'当前只是讨论或反馈，未建立长期指导。'};
  if(proposal.invariant_conflict)return {kind:'rejected' as const,reason:'这项要求与世界事实、人物自主性或行动结算等 Framework 规则冲突，未保存。'};
  const scope=proposal.scope??'world';
  if(!proposal.category||!proposal.title.trim()||!proposal.trigger_semantics.trim()||
    !proposal.preferred_behavior.trim()||!proposal.anti_pattern.trim())return {kind:'discussion' as const,reason:'尚不能形成明确的长期行为指导，未保存。'};
  const conflicts=existing.filter(p=>p.id!==requestId&&p.enabled&&p.category===proposal.category&&p.scope===scope);
  const previous=conflicts.sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
  const patch:BehaviorPatch=behaviorPatchSchema.parse({
    id:requestId??randomUUID(),version:1,scope,category:proposal.category,
    title:proposal.title.trim(),trigger_semantics:proposal.trigger_semantics.trim(),
    preferred_behavior:proposal.preferred_behavior.trim(),anti_pattern:proposal.anti_pattern.trim(),
    optional_exemplar:null,priority:5,enabled:true,created_at:new Date().toISOString(),
    source_text:input,overrides:previous?.id??null,
  });
  return {kind:'create' as const,patch,overridden:previous?.title??null};
}
