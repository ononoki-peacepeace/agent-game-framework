import type {PublicView} from '../shared/contracts.js';
import {agentPlanSnapshotSchema,type AgentPlan,type AtomicGoal,type PlanContract,type StepContract} from './plan-schema.js';
import {currentTrace} from '../observability/trace.js';
import type {GoalSpec} from '../system/goals.js';
import {localDurationIntent} from '../core/freeform.js';

export interface GoalSource {kind:'manual'|'choice';text:string;offerId?:string|null;semanticGoal?:GoalSpec|null}
/** Syntax only selects the semantic planner; it never invents an action or evidence. */
export const hasMultipleClauses=(text:string)=>/[，,；;]\s*(?:再|然后|接着|顺便|同时|以及)/.test(text)||
  /(?:^|[，,；;])\s*先.{1,100}?(?:再|然后|接着)(?=\S)/.test(text)||
  hasLocalMotionThenClause(text);
/** A comma-separated action after local motion still needs its own evidence,
 * even when the text has no explicit "then" connective. */
function hasLocalMotionThenClause(text:string){
  // A timed stay/rest is one bounded Core activity even if the sentence opens
  // with taking a posture near a fixture. Explicit connectors remain separate.
  if(localDurationIntent(text))return false;
  const clauses=text.split(/[，,；;]/).map(part=>part.trim()).filter(Boolean);
  return clauses.some((clause,index)=>index<clauses.length-1&&
    /(?:走到|回到|来到|走向|移到|移动到|去到)/.test(clause)&&
    clauses.slice(index+1).some(part=>/\S/.test(part)));
}
export const hasInteractionDependentClause=(view:PublicView,text:string)=>/[，,；;]/.test(text)&&
  view.entities.some(entity=>Boolean(entity.components.interactable)&&
    typeof entity.components.identity?.name==='string'&&text.includes(entity.components.identity.name));

const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・._-]+/g,'');
const numeral:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
/** Only a player-stated count is authoritative; an unmentioned amount means one unit. */
function purchaseQuantity(text:string){
  const match=text.match(/([0-9零一二两三四五六七八九十百千万]+)\s*(?:件|份|个|瓶|盒|袋|包|本|杯|块|张)/);
  if(!match)return 1;
  const token=match[1];
  if(/^\d+$/.test(token)){const value=Number(token);return value>=1&&value<=100?value:null;}
  if(token==='十')return 10;
  if(token.length===1)return numeral[token]??null;
  const chinese=token.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  return chinese?(chinese[1]?numeral[chinese[1]]:1)*10+(chinese[2]?numeral[chinese[2]]:0):null;
}

/** Bind a model-suggested public label, never a model-supplied canonical ID. Ambiguity stays unresolved. */
function bind(view:PublicView,role:'destination'|'person'|'interactable',mention:string){
  const key=normalized(mention);
  const candidates=role==='destination'?view.locations.map(place=>({id:place.id,names:[place.name]})):
    view.entities.filter(entity=>entity.id!==view.player_id&&
      (role==='interactable'?Boolean(entity.components.interactable||entity.components.character):Boolean(entity.components.character))).map(entity=>({id:entity.id,
      names:[String(entity.components.identity?.name??''),...((entity.components.identity?.previous_names??[]) as string[]),
        String(entity.components.character_card?.nickname??'')].filter(Boolean)}));
  const exact=candidates.filter(candidate=>candidate.names.some(name=>normalized(name)===key));
  const titled=role==='person'?view.entities.filter(entity=>entity.components.character).filter(entity=>{
    const title=normalized(String(entity.components.character?.role??''));
    if(!title||!key.endsWith(title))return false;
    const prefix=key.slice(0,-title.length);
    return prefix.length>=2&&normalized(String(entity.components.identity?.name??'')).startsWith(prefix);
  }).map(entity=>({id:entity.id})):[];
  const matches=exact.length?exact:titled.length?titled:key.length>=2?candidates.filter(candidate=>candidate.names.some(name=>normalized(name).includes(key))):[];
  return {role,mention,entity_id:matches.length===1?matches[0].id:null,
    status:matches.length===1?'bound':matches.length>1?'ambiguous':'unresolved'} as const;
}

/** Preserve a semantic target across planning for every public entity kind. */
function bindTargetEntity(view:PublicView,entityId:string){
  const location=view.locations.find(place=>place.id===entityId);
  if(location)return {role:'destination' as const,mention:location.name,entity_id:location.id,status:'bound' as const};
  const entity=view.entities.find(candidate=>candidate.id===entityId);
  if(!entity)return null;
  const role=entity.components.character?'person' as const:entity.components.item?'item' as const:'interactable' as const;
  return {role,mention:String(entity.components.identity?.name??entity.id),entity_id:entity.id,status:'bound' as const};
}

/** A named discussion subject is not necessarily the addressee. This guard only
 * proves direct single-clause recipient frames; Semantic owns broader role alignment. */
function sourcePronounBeforeName(text:string,name:string){
  const intent=normalized(text),index=intent.indexOf(normalized(name));
  return index>=0&&[...intent.matchAll(/(?:询问|问|告诉|告知|通知|对|向|跟|与|和)(?:他|她|对方)/g)].some(match=>match.index! < index);
}
function sourceNamesRecipient(text:string,name:string){
  if(hasMultipleClauses(text))return false;
  const intent=normalized(text),key=normalized(name),index=intent.indexOf(key);
  if(index<0)return false;
  // A preceding pronoun can already occupy the addressee slot (“向他询问林舟…”).
  // A later query verb does not make the named subject a new recipient.
  if(sourcePronounBeforeName(text,name))return false;
  const before=intent.slice(0,index),after=intent.slice(index+key.length);
  return /(?:询问|问|告诉|告知|通知)$/.test(before)||
    /(?:对|向|跟|与|和)$/.test(before)&&/^(?:说|询问|问|表示|解释|道谢|交谈|交流|聊天|讨论)/.test(after);
}
function talkPerson(view:PublicView,goal:AtomicGoal,source:GoalSource){
  // A stage-owned recipient is not the set of every person mentioned in the
  // original compound request (e.g. asking A about B). Bind once, validate later.
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const here=player?.components.location?.location_id;
  const people=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character);
  const focus=people.find(entity=>entity.id===view.interaction_context?.target_entity_id&&
    entity.components.location?.location_id===here);
  const pronoun=source.text.match(/他|她|它|对方/);
  const bindPronoun=()=>{
    if(focus?.components.identity?.name)return bind(view,'person',String(focus.components.identity.name));
    const present=people.filter(entity=>entity.components.location?.location_id===here);
    if(present.length===1&&present[0].components.identity?.name)return bind(view,'person',String(present[0].components.identity.name));
    return {role:'person',mention:pronoun?.[0]??'对方',entity_id:null,status:present.length>1?'ambiguous':'unresolved'} as const;
  };
  const explicit=people.filter(entity=>{
    const name=String(entity.components.identity?.name??'');
    return name.length>=2&&source.text.includes(name);
  });
  const suggested=goal.referent?.trim(),person=suggested?bind(view,'person',suggested):null;
  // Only a source-owned addressee takes priority here. Preserve the existing
  // referent path when a named person is a subject or belongs to another clause.
  if(explicit.length===1){
    const name=String(explicit[0].components.identity?.name);
    if(sourcePronounBeforeName(source.text,name))return bindPronoun();
    if(person&&!sourceNamesRecipient(source.text,name)&&(person.status==='bound'||person.status==='ambiguous'))return person;
    return bind(view,'person',name);
  }
  // In a compound request the stage may name one of several authorized people.
  // Use that stage's own name before treating the whole sentence as ambiguous;
  // an invented name that exists only in a model paraphrase grants no authority.
  if(explicit.length>1){
    if(person?.status==='bound'&&explicit.some(entity=>entity.id===person.entity_id))return person;
    const staged=explicit.filter(entity=>goal.normalized_goal.includes(String(entity.components.identity?.name??'')));
    if(staged.length===1)return bind(view,'person',String(staged[0].components.identity?.name));
  }
  if(explicit.length>1)return {role:'person',mention:source.text.slice(0,120),entity_id:null,status:'ambiguous'} as const;
  if(pronoun)return bindPronoun();
  // Only use model-supplied referents after source names and existing pronoun
  // context have had their say; an unresolved non-person label still falls through.
  if(person&&(person.status==='bound'||person.status==='ambiguous'))return person;
  const planned=people.filter(entity=>{
    const name=String(entity.components.identity?.name??'');
    return name.length>=2&&goal.normalized_goal.includes(name);
  });
  if(planned.length>1)return {role:'person',mention:goal.normalized_goal.slice(0,120),entity_id:null,status:'ambiguous'} as const;
  if(planned.length===1)return bind(view,'person',String(planned[0].components.identity?.name));
  const target=goal.target_entities.length===1?people.find(entity=>entity.id===goal.target_entities[0]):null;
  if(target?.components.identity?.name)return bind(view,'person',String(target.components.identity.name));
  if(focus?.components.identity?.name)return bind(view,'person',String(focus.components.identity.name));
  return null;
}

/** Resolve coordinated addressees, not everyone mentioned in the subject of a conversation.
 * Planner referent is optional: real outputs can preserve the list only in normalized_goal.
 * Names still bind uniquely against public identities; execution checks physical presence.
 */
function talkAudience(view:PublicView,goal:AtomicGoal){
  const people=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character&&
    normalized(String(entity.components.identity?.name??'')).length>=2);
  const names=[...new Set(people.map(entity=>normalized(String(entity.components.identity?.name))))]
    .sort((a,b)=>b.length-a.length);
  const parseList=(text:string)=>{
    const audience:typeof people=[];
    let rest=text;
    while(rest){
      const name=names.find(name=>rest.startsWith(name));
      if(!name)return null;
      const matches=people.filter(entity=>normalized(String(entity.components.identity?.name))===name);
      if(matches.length!==1||audience.some(entity=>entity.id===matches[0].id))return null;
      audience.push(matches[0]);rest=rest.slice(name.length);
      const separator=rest.match(/^(?:[、,，]|以及|和|与|及)+/);
      if(!separator)break;
      rest=rest.slice(separator[0].length);
    }
    if(audience.length<2||audience.length>12||/^(?:或|还是|其中)/.test(rest))return null;
    return {audience,rest};
  };
  // Locate the first public name rather than requiring it immediately after
  // the address preposition. Qualifiers are not listeners; a preceding list
  // member or alternative must not be silently discarded as a qualifier.
  const qualifiedList=(text:string)=>{
    const starts=names.map(name=>text.indexOf(name)).filter(index=>index>=0);
    if(!starts.length)return null;
    const start=Math.min(...starts),prefix=text.slice(0,start);
    if(prefix.length>80||/[、,，。；;！？!?：:和与及或]/.test(prefix))return null;
    return parseList(text.slice(start));
  };
  const reference=qualifiedList(normalized(goal.referent??''));
  if(reference&&!reference.rest)return reference.audience;
  // A list must occupy the recipient position of a speech clause. In particular,
  // "ask A about B" and "A or B" cannot silently become a group conversation.
  // As with a populated referent, the existing goal-alignment check owns
  // whether public full names faithfully resolve the player's abbreviated
  // names. Requiring literal full names here rejects those verified plans.
  const intent=normalized(goal.normalized_goal);
  const frame=/(?:对|向|告诉|告知|通知|与|和)/g;
  for(const match of intent.matchAll(frame)){
    const clause=intent.slice(0,match.index).split(/[，,。；;！？!?「」“”]/).at(-1)??'';
    if((match[0]==='与'||match[0]==='和')&&
      (/(?:对|向|告诉|告知|通知)/.test(clause)||names.some(name=>clause.includes(name))))continue;
    const list=qualifiedList(intent.slice(match.index!+match[0].length));
    if(!list)continue;
    const speech=match[0]==='与'||match[0]==='和'?/^(?:交谈|交流|聊天|讨论|说)/:
      match[0]==='对'||match[0]==='向'?/^(?:说|表示|说明|告知|道谢|解释|询问)/:/^/;
    if(speech.test(list.rest))return list.audience;
  }
  return null;
}

function mentionedHeldItem(view:PublicView,text:string){
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const held=(player?.components.inventory as {items?:Record<string,number>}|undefined)?.items??{};
  const intent=normalized(text);
  const matches=view.entities.filter(entity=>entity.components.item&&(held[entity.id]??0)>0).map(entity=>{
    const name=String(entity.components.identity?.name??''),key=normalized(name);
    let length=0;
    for(let size=2;size<=key.length;size++)
      if(intent.includes(key.slice(-size)))length=size;
    return {entity,name,length};
  }).filter(match=>match.length>=2);
  if(!matches.length)return null;
  const best=Math.max(...matches.map(match=>match.length));
  const closest=matches.filter(match=>match.length===best);
  return {role:'item',mention:closest[0].name,entity_id:closest.length===1?closest[0].entity.id:null,
    status:closest.length===1?'bound':'ambiguous'} as const;
}

function stepContract(view:PublicView,goal:AtomicGoal,source:GoalSource):StepContract{
  const playerIntent=source.text;
  const hint=goal.operation_hint,mention=goal.referent?.trim()??'';
  const bindings:StepContract['bindings']=[];
  const required_capabilities:string[]=[];
  let completion:StepContract['completion']={kind:'unsupported'};
  let availability:StepContract['availability']='ready';
  if(hint==='move'){
    const destination=mention?bind(view,'destination',mention):null;
    if(destination)bindings.push(destination);
    else availability='needs_binding';
    required_capabilities.push('map.graph');
    completion={kind:'location_at',destination_id:destination?.entity_id??null};
  }else if(hint==='purchase'){
    required_capabilities.push('commerce.shop');
    // Product and shop are bound against the post-MOVE scene in a later phase, not invented now.
    if(mention)bindings.push({role:'item',mention,entity_id:null,status:'unresolved'});
    // The model's paraphrase is not authority to increase the player's purchase quantity.
    const quantity=purchaseQuantity(playerIntent);
    completion={kind:'purchase',shop_id:null,item_id:null,quantity};
    availability='runtime_gap';
    if(quantity===null||purchaseQuantity(goal.normalized_goal)!==quantity||
      goal.quantity&&goal.quantity!==quantity)availability='needs_binding';
  }else if(hint==='presence_query'){
    // A scene census has no single person to bind. Preserve observation as
    // an attempted Core perception action; explicit unknown people still block.
    if(!mention&&!goal.target_entities.length&&!/(?:某人|那个人|这个人|他|她|他们|她们)/u.test(goal.normalized_goal)){
      goal.operation_hint='observe';
      return {bindings,required_capabilities,completion:{kind:'activity_occurred'},availability:'ready',evidence_refs:[]};
    }
    const person=mention?bind(view,'person',mention):null;
    if(person)bindings.push(person);
    else availability='needs_binding';
    completion={kind:'presence_observed',person_id:person?.entity_id??null,location_id:null};
    availability='runtime_gap';
    if(!person)availability='needs_binding';
  }else if(hint==='interact'){
    const site=mention?bind(view,'interactable',mention):null;
    if(site)bindings.push(site);
    else availability='needs_binding';
    required_capabilities.push('core.transaction');
    completion={kind:'interaction_performed',target_id:site?.entity_id??null};
  }else if(hint==='talk'||goal.type==='WORLD_SPEECH'){
    const audience=goal.speech_recipients?.length?[]:talkAudience(view,goal)??[];
    const listeners:StepContract['bindings']=goal.speech_recipients?.length?
      goal.speech_recipients.map(name=>bind(view,'person',name)):
      audience.map(entity=>({role:'person',mention:String(entity.components.identity?.name??entity.id),entity_id:entity.id,status:'bound'}));
    const ids=listeners.flatMap(binding=>binding.entity_id?[binding.entity_id]:[]);
    if(new Set(ids).size!==ids.length)for(const binding of listeners){binding.entity_id=null;binding.status='ambiguous';}
    const explicitGroup=listeners.length>1&&listeners.every(binding=>binding.status==='bound');
    const person=goal.result_ref||listeners.length?null:talkPerson(view,goal,source);
    if(listeners.length)bindings.push(...listeners);
    else if(person)bindings.push(person);
    else availability=goal.result_ref?'runtime_gap':'needs_binding';
    const heldItem=mentionedHeldItem(view,source.text);
    if(heldItem)bindings.push(heldItem);
    required_capabilities.push('character.identity');
    completion={kind:'conversation_attempted',person_id:listeners.length?listeners[0].entity_id:person?.entity_id??null,
      ...(explicitGroup?{audience_ids:listeners.map(binding=>binding.entity_id!)}:{})};
    currentTrace()?.info('agent.speech_binding',{metadata:{goal_id:goal.goal_id,
      source:goal.speech_recipients?.length?'speech_recipients':audience.length?'legacy_recipient_list':'single_person_fallback',
      listeners:bindings.filter(binding=>binding.role==='person').map(binding=>({entity_id:binding.entity_id,status:binding.status}))}});
  }else if(hint==='item_move'){
    required_capabilities.push('inventory.storage');
    const player=view.entities.find(entity=>entity.id===view.player_id);
    const here=player?.components.location?.location_id;
    const owned=(player?.components.inventory as {items?:Record<string,number>}|undefined)?.items??{};
    const matches=mention?view.entities.filter(entity=>entity.components.item&&
      normalized(String(entity.components.identity?.name??''))===normalized(mention)):[];
    const item=matches.length===1?matches[0]:null;
    const accessible=Boolean(item&&((owned[item.id]??0)>0||item.components.location?.location_id===here));
    if(mention)bindings.push({role:'item',mention,entity_id:accessible?item!.id:null,
      status:matches.length>1?'ambiguous':accessible?'bound':matches.length===1?'unavailable':'unresolved'});
    if((goal.item_destination==='held'||goal.item_destination==='scene')&&accessible)
      completion={kind:'item_location',item_id:item!.id,to:goal.item_destination};
    else if(matches.length===0&&mention&&goal.item_destination==='held'){
      // An unregistered object is an existence/permission attempt, not an invented
      // item ID. A real but inaccessible/ambiguous item never enters this fallback.
      goal.operation_hint='environment_query';completion={kind:'environment_resolved'};
    }else availability=goal.item_destination==='container'?'runtime_gap':'needs_binding';
  }else if(hint==='environment_query')completion={kind:'environment_resolved'};
  else if(hint==='activity'||hint==='observe')completion={kind:'activity_occurred'};
  else if(goal.target_entities.length===1){
    // An upstream-identified person still owns the goal even when the planner
    // did not attach a hint. Preserve the binding so downstream never treats it
    // as a missing target; execution and prerequisites remain authoritative.
    const person=view.entities.find(entity=>entity.id===goal.target_entities[0]&&entity.components.character);
    if(person)bindings.push({role:'person',mention:String(person.components.identity?.name??person.id),
      entity_id:person.id,status:'bound'});
    availability='runtime_gap';
  }
  else availability='runtime_gap';
  // Upstream entity references are authoritative for people, items, scene
  // objects and locations alike.  Planner omissions must not erase them.
  for(const targetId of goal.target_entities){
    const targetBinding=bindTargetEntity(view,targetId);
    if(targetBinding&&!bindings.some(binding=>binding.entity_id===targetId))bindings.push(targetBinding);
  }
  if(goal.target_entities.some(id=>bindTargetEntity(view,id))&&bindings.some(binding=>binding.status!=='bound'))availability='needs_binding';
  if(required_capabilities.some(capability=>!view.capabilities.includes(capability)))availability='capability_gap';
  else if(availability==='ready'&&completion.kind!=='environment_resolved'&&bindings.some(binding=>binding.status!=='bound'))availability='needs_binding';
  return {bindings,required_capabilities,completion,availability,evidence_refs:[]};
}

/** Program-owned contract layer shared by manual requests and authored choices. It does not execute goals. */
export function compileGoalContract(view:PublicView,plan:AgentPlan,source:GoalSource):AgentPlan{
  const compiled:AgentPlan=structuredClone(plan);
  const speechGoals=compiled.goals.filter(goal=>goal.operation_hint==='talk'||goal.type==='WORLD_SPEECH');
  const recipients=source.semanticGoal?.targets.filter(target=>target.role==='audience')??[];
  // A global Semantic audience can own one speech stage. With multiple speech
  // stages the planner must keep each stage's recipient roles separate.
  if(speechGoals.length===1&&recipients.length){
    speechGoals[0].speech_recipients=recipients.map(target=>{
      const bound=bind(view,'person',target.reference);
      // An ID never grants permission to retarget an ambiguous/unknown label.
      if(target.entity_id&&bound.entity_id!==target.entity_id)return target.reference;
      return String(view.entities.find(entity=>entity.id===bound.entity_id)?.components.identity?.name??target.reference);
    });
  }
  for(const goal of compiled.goals){
    // The semantic owner may already have bound a real person. A planner that
    // omitted the id must not make the goal look unbound downstream.
    if(source.semanticGoal?.targets.length&&!goal.target_entities.length){
      const upstream=[...new Set(source.semanticGoal.targets.flatMap(target=>target.entity_id?[target.entity_id]:[]))]
        .filter(id=>view.entities.some(entity=>entity.id===id)||view.locations.some(location=>location.id===id));
      if(upstream.length)goal.target_entities=upstream.slice(0,12);
    }
    // A validated same-scene compound is settled by Core as local freeform
    // steps. Its walk is not a map transition even if the planner used MOVE.
    if(compiled.local_compound&&goal.type==='WORLD_ACTION'&&goal.operation_hint==='move')
      goal.operation_hint='activity';
    goal.contract=stepContract(view,goal,source);
    if(goal===speechGoals[0]&&speechGoals.length===1&&recipients.length){
      const mismatch=recipients.some((target,index)=>target.entity_id&&
        goal.contract!.bindings.filter(binding=>binding.role==='person')[index]?.entity_id!==target.entity_id);
      if(mismatch)goal.contract.availability='needs_binding';
    }
    if(goal.result_ref&&goal.contract.completion.kind==='conversation_attempted'){
      goal.contract.availability='runtime_gap';goal.contract.completion.person_id=null;
      goal.contract.bindings=goal.contract.bindings.filter(binding=>binding.role!=='person');
    }
    // Semantic hints may come from the model; only the program's unique public binding is authoritative.
    if(goal.operation_hint){
      const boundIds=goal.contract.bindings.filter(binding=>binding.status==='bound'&&binding.entity_id).map(binding=>binding.entity_id!);
      const preserved=goal.target_entities.filter(id=>boundIds.includes(id));
      goal.target_entities=[...new Set([...preserved,...(preserved.length?[]:boundIds)])].slice(0,12);
    }
  }
  const availability=compiled.goals.map(goal=>goal.contract!.availability);
  let executionAvailability:PlanContract['execution_availability']=availability.includes('capability_gap')?'capability_gap':
    availability.includes('runtime_gap')?'runtime_gap':availability.includes('needs_binding')?'needs_binding':'ready';
  // A single exploratory goal cannot certify a visibly multi-clause objective.
  const unresolvedInteraction=compiled.goals.length===1&&!compiled.local_compound&&
    ['WORLD_ACTION','WORLD_SPEECH','WORLD_GOAL'].includes(compiled.goals[0].type)&&
    hasInteractionDependentClause(view,source.text);
  if((hasMultipleClauses(source.text)||unresolvedInteraction)&&compiled.goals.length===1&&!compiled.local_compound&&
     (unresolvedInteraction||compiled.goals[0].type==='WORLD_GOAL'||
       ['move','purchase','presence_query'].includes(compiled.goals[0].operation_hint??'')))
    executionAvailability='runtime_gap';
  compiled.contract={source:source.kind,original_intent:source.text,offer_id:source.offerId??null,
    execution_mode:compiled.local_compound||(compiled.goals.length===1&&executionAvailability!=='runtime_gap')?'atomic_local':'staged',
    ...(unresolvedInteraction?{unresolved_compound:true}:{}),
    source_revision:view.revision,last_observed_revision:view.revision,execution_availability:executionAvailability};
  return agentPlanSnapshotSchema.parse(compiled) as AgentPlan;
}

/** A rejected generated plan can be repaired before any world write. Capability gaps
 * remain terminal here: a different label cannot create a missing capability. */
export function recoverablePlanAdmission(plan:AgentPlan){
  const unfinishedCompound=plan.goals.length===1&&!plan.local_compound&&
    (hasMultipleClauses(plan.contract?.original_intent??'')||Boolean(plan.contract?.unresolved_compound))&&
    plan.goals[0].side_effect_level==='world'&&plan.contract?.execution_availability==='runtime_gap';
  const goal=unfinishedCompound?plan.goals[0]:plan.goals.find(entry=>entry.side_effect_level==='world'&&entry.operation_hint&&
    entry.operation_hint!=='other'&&(entry.contract?.availability==='needs_binding'||
      entry.contract?.availability==='runtime_gap'&&entry.contract.completion.kind==='unsupported'));
  if(!goal)return null;
  const binding=goal.contract?.bindings.find(entry=>entry.status!=='bound');
  const availability=goal.contract?.availability;
  return {goal,code:availability==='needs_binding'?'plan_binding_invalid':unfinishedCompound?'plan_compound_incomplete':'plan_contract_unexecutable',
    issue:{path:`goals.${goal.goal_id}.${binding?'referent':'operation_hint'}`,
      code:binding&&availability==='needs_binding'?'unresolved_binding':unfinishedCompound?'missing_compound_step':'unexecutable_contract',
      expected:binding?.role==='destination'?'已登记地图地点，或改用能验证同场景行动的契约':
        unfinishedCompound?'分别保留原始请求中的行动及依赖步骤；同场景行动可使用现有局部复合候选':
          '与原始玩家目标和公开世界状态一致的可执行步骤契约',
      message:binding?`目标“${binding.mention}”作为 ${binding.role} 的绑定状态为 ${binding.status}；不得编造 ID 或把普通场景物件当作地图地点。`:
        unfinishedCompound?'原始请求含多个行动，单一步骤没有分别证明它们已经完成。':
          `步骤的执行可用性为 ${availability}，完成要求为 ${goal.contract?.completion.kind??'unsupported'}。`}};
}

export function sameGoalShape(plan:AgentPlan){return {mode:plan.contract?.execution_mode,
  goals:plan.execution_order.map(id=>{const goal=plan.goals.find(item=>item.goal_id===id)!;return {
    id:goal.goal_id,type:goal.type,text:goal.normalized_goal,depends_on:goal.depends_on,
    operation:goal.operation_hint??null,completion:goal.contract?.completion,
    bindings:goal.contract?.bindings,required_capabilities:goal.contract?.required_capabilities};})};}
