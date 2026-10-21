import {randomUUID} from 'node:crypto';
import {demo,MemoryStore} from '../helpers.js';
import {newSave,validateSave} from '../../src/core/state.js';
import {GameService} from '../../src/server/service.js';
import {AIRuntime} from '../../src/ai/runtime.js';
import {MockAIAdapter} from '../../src/ai/mock.js';
import {ProviderError} from '../../src/ai/failures.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../../src/agent/scene-interaction.js';
import type {SavePackage} from '../../src/core/schema.js';
import type {ActionInput} from '../../src/shared/contracts.js';

export const narrativeWorldKinds=['commerce','relationships','autonomy'] as const;
export type NarrativeWorldKind=typeof narrativeWorldKinds[number];
export async function prepareNarrativeWorld(kind:NarrativeWorldKind){
 const world=structuredClone(demo);world.events=[];world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
 if(kind!=='commerce'){
  world.enabled_modules=world.enabled_modules.filter(module=>module!=='commerce');
  world.entities=world.entities.filter(entity=>!entity.components.shop);
  for(const entity of world.entities)delete entity.components.wallet;
 }
 if(kind!=='autonomy'){
  // condition is owned by the routine module even in a world without active life schedules.
  delete world.routine_rules;
 }
 if(kind==='relationships'){
  world.map!.locations=world.map!.locations.filter(location=>location.id!=='market');
  world.map!.routes=world.map!.routes.filter(route=>route.from!=='market'&&route.to!=='market');
  world.ruleset.relationship_dimensions.familiarity.event_deltas={contact:1};
 }
 if(kind==='autonomy'){
  world.map!.routes=[{from:'square',to:'station',travel_minutes:2,conditions:[]},
   {from:'station',to:'square',travel_minutes:2,conditions:[]},
   {from:'station',to:'market',travel_minutes:3,conditions:[]},
   {from:'market',to:'station',travel_minutes:3,conditions:[]}];
  world.events=[{id:'mira_arrived',hook:'on_location_enter',location_id:'station',actor_scope:'any',probability:1,
   once:true,set_flag:'mira_arrived',public_text:'',interrupt_automation:false}];
  const at=structuredClone(world.runtime.time);
  world.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:2,minimum_gap_minutes:60,replenishment:false};
  world.background_incidents=[{id:'shift_handoff',title:'普通交接',summary:'既有岗位安排',source:'WORLD_PACKAGE',created_at:at,
   earliest_activation:at,latest_activation:{...at,minute:at.minute+20},activation_flags:['mira_arrived'],activation_chance:1,
   participants:['npc_mira'],locations:['station'],stages:[{id:'done',earliest_after_minutes:0,latest_after_minutes:null,
    required_flags:[],actor_id:'npc_mira',effects:[{kind:'set_flag',flag:'shift_handoff_done'}],
    exposures:[{id:'local_record',channel:'same_location',location_id:'station',npc_id:null,
     text:'N4_REMOTE_SHIFT_RECORD',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
 }
 // These are common corpus actors/objects, while module graphs and causal rules above differ.
 for(const entity of world.entities)if(entity.components.character)entity.components.location={location_id:'square'};
 const lin=world.entities.find(entity=>entity.id==='npc_lin')!,mira=structuredClone(lin);
 mira.id='npc_mira';mira.components.identity!.name='米拉';mira.components.location={location_id:kind==='autonomy'?'square':'station'};
 world.entities.push(mira,{id:'qa_paper',type:'item',components:{identity:{name:'纸片',description:'已有物品',avatar_id:null},
  location:{location_id:'square'},item:{weight:.01,stackable:false,tracking:'tracked',condition:'intact'},discovery:{known_to_player:true}}});
 let initial=newSave(world);
 if(kind==='autonomy'){
  recordNpcActivityPlans(initial,sceneResultSchema.parse({understanding:'米拉本人安排',narrative:'米拉准备按已有安排前往车站。',dialogue:'我去车站交接，之后准备四分钟。',
   speech_events:[{speaker_id:'npc_mira',utterance:'我去车站交接，之后准备四分钟。',provenance:'npc_response'}],effects:[],
   npc_activity_intents:[{npc_id:'npc_mira',speech_index:0,destination_id:'station',readiness:'ready',condition:null,plan_id:null,
    steps:[{type:'MOVE',target_id:'station',description:'前往岗位',duration_minutes:null,speech:null},
     {type:'HOLD',target_id:null,description:'进行交接准备',duration_minutes:4,speech:null}],not_before:null}]}),randomUUID(),'square');
 }
 const store=new MemoryStore();await store.write(validateSave(initial));
 const ai=new AIRuntime(new MockAIAdapter());
 ai.narrate=async()=>{throw new ProviderError('refusal','offline-world-witness','Use canonical receipt prose');};
 const service=new GameService(store,ai,world);initial=await service.current();
 const act=async(action:ActionInput)=>{const current=await service.current();await service.turn({game_id:current.game_id,
  expected_revision:current.state_revision,request_id:randomUUID(),action});};
 if(kind==='commerce'){
  await act({type:'MOVE',target_id:'market',parameters:{}});
  await act({type:'BUY',target_id:'corner_shop',parameters:{item_id:'water',quantity:1}});
  await act({type:'MOVE',target_id:'square',parameters:{}});
 }else if(kind==='relationships')await act({type:'TALK',target_id:'npc_lin',parameters:{topic:'确认已有约定'}});
 else await act({type:'WAIT',parameters:{minutes:6}});
 const save=await service.current();
 return {kind,initial,save,evidence:save.resolution_receipts!.filter(receipt=>
  !initial.resolution_receipts?.some(old=>old.request_id===receipt.request_id))};
}

export function corpusSave(base:SavePackage,sample:{condition?:'intact'|'damaged'|'destroyed';category:string}){
 const save=structuredClone(base);save.entities.find(entity=>entity.id==='qa_paper')!.components.item!.condition=sample.condition??'intact';
 if(sample.category==='sensory')save.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state={awareness:'unaware',
  alert_to_ids:[],restrained_by:null,posture:'standing',eyes:'closed',transients:[]};
 return validateSave(save);
}
