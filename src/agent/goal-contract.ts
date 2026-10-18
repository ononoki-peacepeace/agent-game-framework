import type {PublicView} from '../shared/contracts.js';
import {agentPlanSnapshotSchema,type AgentPlan,type AtomicGoal,type PlanContract,type StepContract} from './plan-schema.js';
import {currentTrace} from '../observability/trace.js';
import type {GoalSpec} from '../system/goals.js';

export interface GoalSource {kind:'manual'|'choice';text:string;offerId?:string|null;semanticGoal?:GoalSpec|null}
/** Syntax only selects the semantic planner; it never invents an action or evidence. */
export const hasMultipleClauses=(text:string)=>/[，,；;]\s*(?:再|然后|接着|顺便|同时|以及)/.test(text)||
  /(?:^|[，,；;])\s*先.{1,100}?(?:再|然后|接着)(?=\S)/.test(text);
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

function talkPerson(view:PublicView,goal:AtomicGoal,source:GoalSource){
  // A stage-owned recipient is not the set of every person mentioned in the
  // original compound request (e.g. asking A about B). Bind once, validate later.
  const suggested=goal.referent?.trim();
  if(suggested){
    const person=bind(view,'person',suggested);
    // A non-person referent (a held item, a place, or an unknown label) must not
    // short-circuit pronoun/target resolution; it falls through to those rules.
    if(person.status==='bound'||person.status==='ambiguous')return person;
  }
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const here=player?.components.location?.location_id;
  const people=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character);
  const explicit=people.filter(entity=>{
    const name=String(entity.components.identity?.name??'');
    return name.length>=2&&source.text.includes(name);
  });
  if(explicit.length>1)return {role:'person',mention:source.text.slice(0,120),entity_id:null,status:'ambiguous'} as const;
  if(explicit.length===1)return bind(view,'person',String(explicit[0].components.identity?.name));
  const focus=people.find(entity=>entity.id===view.interaction_context?.target_entity_id&&
    entity.components.location?.location_id===here);
  const pronoun=source.text.match(/他|她|它|对方/);
  if(pronoun){
    if(focus?.components.identity?.name)return bind(view,'person',String(focus.components.identity.name));
    const present=people.filter(entity=>entity.components.location?.location_id===here);
    if(present.length===1&&present[0].components.identity?.name)
      return bind(view,'person',String(present[0].components.identity.name));
    return {role:'person',mention:pronoun[0],entity_id:null,
      status:present.length>1?'ambiguous':'unresolved'} as const;
  }
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
  else availability='runtime_gap';
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
    if(goal.operation_hint)goal.target_entities=goal.contract.bindings.filter(binding=>
      binding.role==='person'&&binding.status==='bound'&&binding.entity_id).map(binding=>binding.entity_id!);
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

export function sameGoalShape(plan:AgentPlan){return {mode:plan.contract?.execution_mode,
  goals:plan.execution_order.map(id=>{const goal=plan.goals.find(item=>item.goal_id===id)!;return {
    id:goal.goal_id,type:goal.type,text:goal.normalized_goal,depends_on:goal.depends_on,
    operation:goal.operation_hint??null,completion:goal.contract?.completion,
    bindings:goal.contract?.bindings,required_capabilities:goal.contract?.required_capabilities};})};}
