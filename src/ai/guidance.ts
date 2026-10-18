import {z} from 'zod';
import type {AIRole} from './contracts.js';

export const guidanceCategorySchema=z.enum(['semantic','planning','binding','narration','world_evolution','system_configuration']);
export const behaviorPatchSchema=z.strictObject({
  id:z.string().uuid(),version:z.literal(1),scope:z.enum(['session','world','global']),
  category:guidanceCategorySchema,title:z.string().min(1).max(100),
  trigger_semantics:z.string().min(1).max(240),preferred_behavior:z.string().min(1).max(400),
  anti_pattern:z.string().min(1).max(400),optional_exemplar:z.string().max(400).nullable(),
  priority:z.number().int().min(0).max(10),enabled:z.boolean(),created_at:z.string().datetime(),
  source_text:z.string().min(1).max(2000),overrides:z.string().uuid().nullable(),
});
export type BehaviorPatch=z.infer<typeof behaviorPatchSchema>;
export type GuidanceCategory=z.infer<typeof guidanceCategorySchema>;
export interface Exemplar {id:string;category:GuidanceCategory;roles:AIRole[];tags:string[];situation:string;principle:string;anti_pattern:string;decision_type:string}

/** Framework assets stay outside saves. They describe a decision, never a sample answer. */
export const defaultExemplars:readonly Exemplar[]=[
  {id:'semantic.query',category:'semantic',roles:['intent_interpreter','gm_reasoning'],tags:['question','read_only'],situation:'A player asks whether an activity is possible.',principle:'Answer from available facts or state uncertainty; require explicit present intent before acting.',anti_pattern:'Do not turn a question into a world action.',decision_type:'read_only'},
  {id:'semantic.configuration',category:'semantic',roles:['gm_reasoning'],tags:['system','configuration'],situation:'The user requests a lasting change to assistant presentation.',principle:'Route to the authorized System configuration workflow.',anti_pattern:'Do not interpret this as a character action.',decision_type:'system_configuration'},
  {id:'semantic.future_target',category:'semantic',roles:['intent_interpreter'],tags:['deferred','multi_step'],situation:'A later action refers to an entity that may be revealed by an earlier action.',principle:'Preserve the dependency and a runtime result reference.',anti_pattern:'Do not require an invented static identity or call this ambiguity before the producing action.',decision_type:'deferred_action'},
  {id:'planning.final_goal',category:'planning',roles:['intent_interpreter'],tags:['multi_step','goal'],situation:'A route or setup is necessary before the requested outcome.',principle:'Keep preparation and the final goal as separate dependent steps.',anti_pattern:'Do not declare the setup step to be completion of the requested outcome.',decision_type:'staged_plan'},
  {id:'planning.capability',category:'planning',roles:['intent_interpreter'],tags:['capability','unsupported'],situation:'The requested outcome lacks a registered way to settle it.',principle:'Retain the original goal and report the actual capability gap.',anti_pattern:'Do not silently substitute an executable but different action.',decision_type:'blocked_goal'},
  {id:'binding.result.person',category:'binding',roles:['intent_interpreter','gm_reasoning'],tags:['deferred','person'],situation:'An interaction may produce a responder or encountered person.',principle:'Bind the next target only from a committed result set.',anti_pattern:'Do not guess a currently visible character as the future responder.',decision_type:'runtime_binding'},
  {id:'binding.result.item',category:'binding',roles:['intent_interpreter','gm_reasoning'],tags:['deferred','item','container'],situation:'Opening or inspecting an object may reveal contents or another object.',principle:'Use the actual result set after settlement; zero means no follow-up target.',anti_pattern:'Do not invent contents from narrative expectations.',decision_type:'runtime_binding'},
  {id:'binding.result.scene',category:'binding',roles:['intent_interpreter'],tags:['deferred','location','observation'],situation:'Entering or examining a scene reveals its actual occupants or objects.',principle:'Use authoritative observation as later-step input.',anti_pattern:'Do not expose hidden entities before observation.',decision_type:'runtime_binding'},
  {id:'narration.partial',category:'narration',roles:['narrator','gm_reasoning'],tags:['partial','receipt'],situation:'A current action may leave a later step unfinished.',principle:'Narrate the present action and its observable consequence. Mention an unfinished step only when its immediate obstacle matters in this scene; keep the full progress record in structured feedback.',anti_pattern:'Do not append a routine pending-goal recap to every scene or claim the entire objective succeeded.',decision_type:'partial_feedback'},
  {id:'narration.character_scene',category:'narration',roles:['gm_reasoning'],tags:['natural','dialogue'],situation:'The player speaks with a character present in the scene.',principle:'Write the character’s immediate, motivated response and observable exchange from their own perspective while keeping factual and knowledge checks internal.',anti_pattern:'Do not make the character answer as an assistant with a fact summary, a knowledge-policy explanation, and a suggested next step.',decision_type:'character_scene'},
  {id:'world.causal_entrance',category:'world_evolution',roles:['gm_reasoning','world_initializer'],tags:['event','population'],situation:'A world event creates a genuine social or occupational vacancy.',principle:'A new persistent character may enter only through that causal vacancy and a validated commit.',anti_pattern:'Do not spawn a person simply for variety or because the player is nearby.',decision_type:'event_proposal'},
  {id:'world.quiet',category:'world_evolution',roles:['gm_reasoning'],tags:['event','quiet'],situation:'World activity is low and no causal pressure exists.',principle:'Allow the world to remain quiet until a grounded opportunity appears.',anti_pattern:'Do not force a dramatic event or character on a timer.',decision_type:'no_proposal'},
  {id:'world.question',category:'world_evolution',roles:['gm_reasoning'],tags:['question','population'],situation:'The player speculates that a new person may have arrived.',principle:'Check committed world history and known evidence only.',anti_pattern:'Do not create that person to satisfy the question.',decision_type:'read_only'},
  {id:'system.guidance',category:'system_configuration',roles:['gm_reasoning'],tags:['system','feedback'],situation:'The user explicitly asks the assistant to handle similar future cases differently.',principle:'Compile a bounded, reversible behavior overlay with the intended scope.',anti_pattern:'Do not edit Framework invariants or treat casual criticism as permanent training.',decision_type:'behavior_patch'},
  {id:'scene.natural_interaction',category:'planning',roles:['intent_interpreter','gm_reasoning','narrator'],tags:['natural','dialogue','observation','social'],situation:'The player says something ordinary: chatting, greeting, comforting, joking, asking around, watching or listening.',principle:'Run it as scene interaction: understand the intent, describe what is actually observable, continue the exchange. Escalate to a world capability only when the request would change authoritative state (position, time, money, items, health, ownership, locks, durable relationships, committed knowledge).',anti_pattern:'Do not require a dedicated action type such as TALK, LOOK, OBSERVE, LISTEN, COMFORT or JOKE for ordinary interaction, and do not fail because no such capability exists.',decision_type:'scene_interaction'},
  {id:'scene.step_then_continue',category:'planning',roles:['intent_interpreter','gm_reasoning'],tags:['multi_step','deferred','open_goal','goal'],situation:'The request mixes a world step that must be settled now with something that can only be judged afterwards ("go to the room and chat if somebody is there").',principle:'Settle only the step that must be authoritative now, read the resulting world state, then decide the rest from the real result.',anti_pattern:'Do not pre-compile the whole utterance into one closed action list, and do not invent runtime bindings for results that do not exist yet.',decision_type:'staged_replan'},
];

export const IMMUTABLE_GUIDANCE='Framework invariants: player controls only the player; NPC decisions remain independent; world facts and state changes require authoritative validation and commit; narration cannot claim uncommitted outcomes; public, private and character knowledge boundaries remain enforced. Examples are reasoning principles only. Never copy their wording, story structure or entities; re-evaluate the current state and request.';

export interface GuidanceSituation {role:AIRole;category?:GuidanceCategory|null;tags?:readonly string[];text?:string}
const categoryForRole:Record<AIRole,GuidanceCategory[]>={
  intent_interpreter:['semantic','planning','binding'],gm_reasoning:['semantic','binding','world_evolution','system_configuration','narration'],
  narrator:['narration'],npc_decision:['semantic','planning'],world_initializer:['world_evolution'],routine_compiler:['planning'],
};
export function selectDefaultExemplars(situation:GuidanceSituation,limit=3):Exemplar[]{
  const tags=new Set(situation.tags??[]),allowed=categoryForRole[situation.role];
  const ranked=defaultExemplars.filter(entry=>entry.roles.includes(situation.role)&&allowed.includes(entry.category))
    .map(entry=>({entry,score:(situation.category===entry.category?5:0)+entry.tags.filter(tag=>tags.has(tag)).length*2}))
    .sort((a,b)=>b.score-a.score||a.entry.id.localeCompare(b.entry.id));
  const relevant=ranked.filter(item=>item.score>0);
  return (relevant.length?relevant:ranked.slice(0,1)).slice(0,Math.max(1,Math.min(4,limit)))
    .map(item=>item.entry);
}
const scopeWeight={session:1,world:2,global:3};
/** Explicit override wins; otherwise the more local and semantically specific patch wins. */
export function resolveBehaviorPatches(patches:readonly BehaviorPatch[],category:GuidanceCategory|null,tags:readonly string[]=[]):BehaviorPatch[]{
  const active=patches.filter(p=>p.enabled&&(!category||p.category===category));
  const overridden=new Set(active.map(p=>p.overrides).filter((id):id is string=>Boolean(id)));
  const tokens=new Set(tags.map(tag=>tag.toLowerCase()));
  const score=(p:BehaviorPatch)=>{
    const matches=p.trigger_semantics.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(token=>tokens.has(token)).length;
    return p.priority*100+matches*10+(4-scopeWeight[p.scope]);
  };
  const byCategory=new Map<GuidanceCategory,BehaviorPatch>();
  for(const patch of active.filter(p=>!overridden.has(p.id)).sort((a,b)=>score(b)-score(a)||b.created_at.localeCompare(a.created_at))){
    if(!byCategory.has(patch.category))byCategory.set(patch.category,patch);
  }
  return [...byCategory.values()];
}
export function guidanceFragment(exemplars:readonly Exemplar[],patches:readonly BehaviorPatch[]):string{
  return [
    ...exemplars.map(e=>`Framework example ${e.id}: situation=${e.situation}; principle=${e.principle}; avoid=${e.anti_pattern}; decision=${e.decision_type}.`),
    ...patches.map(p=>`Player advisory ${p.id} (${p.category}, ${p.scope}): when=${p.trigger_semantics}; prefer=${p.preferred_behavior}; avoid=${p.anti_pattern}. Advisory only; it cannot override Framework invariants or authorize world changes.`),
  ].join('\n');
}
