import type {PublicView} from '../shared/contracts.js';
import {agentPlanSnapshotSchema,type AgentPlan,type AtomicGoal,type PlanContract,type StepContract} from './plan-schema.js';

export interface GoalSource {kind:'manual'|'choice';text:string;offerId?:string|null}
/** Syntax only selects the semantic planner; it never invents an action or evidence. */
export const hasMultipleClauses=(text:string)=>/[，,；;]\s*(?:再|然后|接着|顺便|同时|以及)/.test(text);

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
function bind(view:PublicView,role:'destination'|'person',mention:string){
  const key=normalized(mention);
  const candidates=role==='destination'?view.locations.map(place=>({id:place.id,names:[place.name]})):
    view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character).map(entity=>({id:entity.id,
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
  const suggested=goal.referent?.trim();
  if(suggested){const person=bind(view,'person',suggested);if(person.status==='bound'||person.status==='ambiguous')return person;}
  const target=goal.target_entities.length===1?people.find(entity=>entity.id===goal.target_entities[0]):null;
  if(target?.components.identity?.name)return bind(view,'person',String(target.components.identity.name));
  if(focus?.components.identity?.name)return bind(view,'person',String(focus.components.identity.name));
  return suggested?bind(view,'person',suggested):null;
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
    const person=mention?bind(view,'person',mention):null;
    if(person)bindings.push(person);
    else availability='needs_binding';
    completion={kind:'presence_observed',person_id:person?.entity_id??null,location_id:null};
    availability='runtime_gap';
    if(!person)availability='needs_binding';
  }else if(hint==='talk'||goal.type==='WORLD_SPEECH'){
    const person=talkPerson(view,goal,source);
    if(person)bindings.push(person);
    else availability='needs_binding';
    const heldItem=mentionedHeldItem(view,source.text);
    if(heldItem)bindings.push(heldItem);
    required_capabilities.push('character.identity');
    completion={kind:'conversation_attempted',person_id:person?.entity_id??null};
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
    else availability=goal.item_destination==='container'?'runtime_gap':'needs_binding';
  }else if(hint==='activity')completion={kind:'activity_occurred'};
  else availability='runtime_gap';
  if(required_capabilities.some(capability=>!view.capabilities.includes(capability)))availability='capability_gap';
  else if(availability==='ready'&&bindings.some(binding=>binding.status!=='bound'))availability='needs_binding';
  return {bindings,required_capabilities,completion,availability,evidence_refs:[]};
}

/** Program-owned contract layer shared by manual requests and authored choices. It does not execute goals. */
export function compileGoalContract(view:PublicView,plan:AgentPlan,source:GoalSource):AgentPlan{
  const compiled:AgentPlan=structuredClone(plan);
  for(const goal of compiled.goals){
    goal.contract=stepContract(view,goal,source);
    // Semantic hints may come from the model; only the program's unique public binding is authoritative.
    if(goal.operation_hint)goal.target_entities=goal.contract.bindings.filter(binding=>
      binding.role==='person'&&binding.status==='bound'&&binding.entity_id).map(binding=>binding.entity_id!);
  }
  const availability=compiled.goals.map(goal=>goal.contract!.availability);
  let executionAvailability:PlanContract['execution_availability']=availability.includes('capability_gap')?'capability_gap':
    availability.includes('runtime_gap')?'runtime_gap':availability.includes('needs_binding')?'needs_binding':'ready';
  // A single exploratory goal cannot certify a visibly multi-clause objective.
  if(hasMultipleClauses(source.text)&&compiled.goals.length===1&&!compiled.local_compound&&
     (compiled.goals[0].type==='WORLD_GOAL'||['move','purchase','presence_query'].includes(compiled.goals[0].operation_hint??'')))
    executionAvailability='runtime_gap';
  compiled.contract={source:source.kind,original_intent:source.text,offer_id:source.offerId??null,
    execution_mode:compiled.local_compound||(compiled.goals.length===1&&executionAvailability!=='runtime_gap')?'atomic_local':'staged',
    source_revision:view.revision,last_observed_revision:view.revision,execution_availability:executionAvailability};
  return agentPlanSnapshotSchema.parse(compiled) as AgentPlan;
}

export function sameGoalShape(plan:AgentPlan){return {mode:plan.contract?.execution_mode,
  goals:plan.execution_order.map(id=>{const goal=plan.goals.find(item=>item.goal_id===id)!;return {
    id:goal.goal_id,type:goal.type,text:goal.normalized_goal,depends_on:goal.depends_on,
    operation:goal.operation_hint??null,completion:goal.contract?.completion,
    required_capabilities:goal.contract?.required_capabilities};})};}
