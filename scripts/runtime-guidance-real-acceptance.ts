// Bounded DeepSeek Flash acceptance. All worlds and provider history live in a disposable temp directory.
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {handleSystemInput} from '../src/system/agent.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {MemoryStore,demo} from '../tests/helpers.js';
import type {WorldPackage,SavePackage} from '../src/core/schema.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(!config||config.provider!=='deepseek'){
  console.log('RUNTIME_GUIDANCE_REAL_NOT_RUN: DeepSeek is not configured');process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'agf-runtime-guidance-real-'));
const onlyBackground=process.argv.includes('--background');
const onlyDoor=process.argv.includes('--door'),onlyReadOnly=process.argv.includes('--read-only');
const output=resolve(onlyBackground?'.tmp/runtime-guidance-real-background.json':
  onlyDoor?'.tmp/runtime-guidance-real-final-door.json':
  onlyReadOnly?'.tmp/runtime-guidance-real-final-read-only.json':'.tmp/runtime-guidance-real-acceptance.json');
const provider=new AIProviderManager(root,config),original=provider.generate.bind(provider),maxCalls=36;
const report:{at:string;provider:string;max_calls:number;calls:any[];cases:any[];error:string|null}={
  at:new Date().toISOString(),provider:'deepseek',max_calls:maxCalls,calls:[],cases:[],error:null};
provider.generate=async request=>{
  if(report.calls.length>=maxCalls)throw Error('REAL_ACCEPTANCE_CALL_BUDGET_EXCEEDED');
  const entry:any={index:report.calls.length+1,role:request.role,prompt_chars:request.prompt.length,
    exemplar_ids:[...request.prompt.matchAll(/Framework example ([\w.]+)/g)].map(match=>match[1]),
    patch_ids:[...request.prompt.matchAll(/Player advisory ([0-9a-f-]{36})/g)].map(match=>match[1])};
  report.calls.push(entry);
  try{const result=await original(request);entry.result=result.data;entry.usage=result.usage??null;return result;}
  catch(error){entry.error=error instanceof Error?error.message:String(error);throw error;}
};
const ai=new AIRuntime(provider);
function seededWorld(kind:'door'|'room'|'ordinary'):WorldPackage{
  const world=structuredClone(demo);
  if(kind==='ordinary')return world;
  world.map!.locations.push({id:'unit_a',name:'走廊尽头的房间',description:'一间有门的房间',tags:[],position:{x:51,y:46}});
  world.map!.routes.push({from:'square',to:'unit_a',travel_minutes:1,conditions:[]},
    {from:'unit_a',to:'square',travel_minutes:1,conditions:[]});
  world.entities.push({id:'unit_door',type:'object',components:{identity:{name:'走廊尽头的门',description:'房门',avatar_id:null},
    location:{location_id:'square'},interactable:{kind:'door',leads_to:'unit_a',knockable:true,access:'private'}}});
  world.entities.push({id:'new_resident',type:'character',components:{identity:{name:'许知夏',description:'住在房间里的成年人',avatar_id:null},
    character:{role:'住户',traits:[]},location:{location_id:'unit_a'},
    residence:{home_location_id:'unit_a',door_id:'unit_door',tenure:'tenant',answer_policy:'always'},
    discovery:{known_to_player:false}}});
  return world;
}
async function fixture(kind:'door'|'room'|'ordinary'){
  const world=seededWorld(kind),store=new MemoryStore(),save=newSave(world);
  await store.write(save);return new GameService(store,ai,world);
}
async function agentCase(id:string,service:GameService,input:string){
  const before=await service.current(),start=report.calls.length;
  try{
    const result=await handleAgentInput(service,{game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input});
    const after=await service.current();
    const record={id,input,plan:result.plan??null,response:result.message,revision_delta:after.state_revision-before.state_revision,
      time_before:before.runtime.time,time_after:after.runtime.time,
      new_receipts:(after.resolution_receipts??[]).slice((before.resolution_receipts??[]).length),
      known_new_resident:publicView(after).entities.some(entity=>entity.id==='new_resident'),
      calls:report.calls.slice(start)};
    report.cases.push(record);
    console.log(JSON.stringify({id,revision_delta:record.revision_delta,receipts:record.new_receipts.map(receipt=>receipt.semantic_action),
      plan_status:result.plan?.status??null,calls:report.calls.length-start}));
  }catch(error){report.cases.push({id,input,error:error instanceof Error?error.message:String(error),calls:report.calls.slice(start)});
    console.log(JSON.stringify({id,error:error instanceof Error?error.message:String(error)}));}
}
function backgroundSeed(save:SavePackage){
  const now=structuredClone(save.runtime.time),cause={underlying_pressure:'商店岗位空缺',actor_motivation:'维持营业',
    resource_constraint:'人手不足',historical_cause:'前员工离职',social_relationship:'店主认识求职者',
    trigger:'招聘结束',unintended_consequence:'新员工调整了营业安排'};
  save.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,
    minimum_gap_minutes:0,replenishment:true};
  save.definition.background_incidents=[{id:'vacancy',title:'商店岗位空缺',summary:'旧员工已离开，店主需要补人',
    source:'WORLD_PACKAGE',created_at:now,earliest_activation:now,latest_activation:null,activation_flags:[],
    activation_chance:1,participants:['npc_qiao'],locations:['market'],causal_basis:cause,
    stages:[{id:'ended',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',
      effects:[],exposures:[],terminal:'resolved'}]}];
  save.background_state={version:1,incidents:[{id:'vacancy',status:'resolved',stage_index:0,activated_at:now,
    ended_at:now,missed:true,player_exposed:false,activation_roll:{sample:0,probability:1,passed:true},delivered_exposure_ids:[]}],
    event_log:[],exposure_log:[],npc_status:{},macro_arcs:[],pending_display_ids:[],last_evaluation:now,
    needs_generation:true,last_terminal_at:now,last_activation_at:now};
  return validateSave(save);
}
await mkdir(resolve('.tmp'),{recursive:true});
try{
  if(onlyDoor)await agentCase('deferred_knock_final',await fixture('door'),'敲走廊尽头的门，跟实际开门的人聊聊。');
  else if(onlyReadOnly)await agentCase('nonexistent_person_final',await fixture('ordinary'),'听说镇上新来了个叫陆远的人，这事是真的吗？');
  else if(!onlyBackground){
  await agentCase('deferred_knock',await fixture('door'),'敲走廊尽头的门，跟实际开门的人聊聊。');
  await agentCase('deferred_scene',await fixture('room'),'进入走廊尽头的房间，再与在那里遇到的人打招呼。');
  const systemService=await fixture('ordinary'),systemBefore=await systemService.current(),systemStart=report.calls.length;
  const feedback=await handleSystemInput(systemService,{input:'以后处理连续行动时，别把准备步骤当成我最终想完成的事。',
    request_id:randomUUID(),game_id:systemBefore.game_id,expected_revision:systemBefore.state_revision});
  const patches=await systemService.behaviorGuidance(),patch=patches.at(-1);
  report.cases.push({id:'behavior_feedback',response:feedback,patch:patch??null,calls:report.calls.slice(systemStart)});
  console.log(JSON.stringify({id:'behavior_feedback',category:feedback.category,patch:patch?.id??null}));
  await agentCase('patch_transfer',systemService,'先绕去车站看下时刻表，再回广场把随身的东西整理好。');
  if(patch){await systemService.setBehaviorPatchEnabled(patch.id,false);
    await agentCase('patch_disabled',systemService,'到街角商店打听营业时间，再返回原处。');}
  await agentCase('nonexistent_person',await fixture('ordinary'),'听说镇上新来了个叫陆远的人，这事是真的吗？');
  for(const [id,input] of [
    ['blind_weather','如果下雨，明早的计划会受影响吗？'],
    ['blind_inventory','我把钥匙忘在某个地方了吗？'],
    ['blind_social','我能不能邀请昨天碰到的人一起参加活动？'],
  ])await agentCase(id,await fixture('ordinary'),input);
  }
  if(!onlyDoor&&!onlyReadOnly){
  const store=new MemoryStore(),seed=backgroundSeed(newSave(demo));await store.write(seed);
  const worldService=new GameService(store,ai,seed.definition),before=await worldService.current(),start=report.calls.length;
  try{
    await worldService.turn({game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),
      action:{type:'WAIT',parameters:{minutes:1}}});
    let after=await worldService.current();
    const generated=(after.definition.background_incidents??[]).slice((before.definition.background_incidents??[]).length);
    const progression:{revision:number;time:SavePackage['runtime']['time'];characters:string[]}[]=[];
    for(let step=0;step<8&&!after.entities.some(entity=>entity.components.world_resident);step++){
      await worldService.turn({game_id:after.game_id,expected_revision:after.state_revision,
        request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:120}}});
      after=await worldService.current();
      progression.push({revision:after.state_revision,time:after.runtime.time,
        characters:after.entities.filter(entity=>entity.components.world_resident).map(entity=>entity.id)});
    }
    const entered=after.entities.filter(entity=>entity.components.world_resident);
    const hiddenBeforeEncounter=entered.every(entity=>!publicView(after).entities.some(visible=>visible.id===entity.id));
    if(entered.length){await worldService.turn({game_id:after.game_id,expected_revision:after.state_revision,
      request_id:randomUUID(),action:{type:'MOVE',target_id:'market',parameters:{}}});after=await worldService.current();}
    const reloaded=await new GameService(store,ai,seed.definition).current();
    report.cases.push({id:'background_continuation',proposal:report.calls.slice(start).find(call=>call.role==='gm_reasoning')?.result??null,
      new_incidents:generated,progression,new_characters:entered,hidden_before_encounter:hiddenBeforeEncounter,
      visible_after_encounter:entered.map(entity=>({id:entity.id,visible:publicView(after).entities.some(item=>item.id===entity.id)})),
      reload_character_count:entered.map(entity=>reloaded.entities.filter(item=>item.id===entity.id).length),
      revision_delta:after.state_revision-before.state_revision,time_before:before.runtime.time,time_after:after.runtime.time,
      calls:report.calls.slice(start)});
    console.log(JSON.stringify({id:'background_continuation',new_incidents:generated.length,
      new_characters:entered.length,hidden_before_encounter:hiddenBeforeEncounter,
      visible_after_encounter:entered.map(entity=>publicView(after).entities.some(item=>item.id===entity.id))}));
  }catch(error){report.cases.push({id:'background_continuation',error:error instanceof Error?error.message:String(error),calls:report.calls.slice(start)});}
  }
}catch(error){report.error=error instanceof Error?error.message:String(error);}
finally{await writeFile(output,JSON.stringify(report,null,2),'utf8');await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({report:output,call_count:report.calls.length,error:report.error}));
