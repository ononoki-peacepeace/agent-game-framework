import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {makeChoiceOffers,checkChoiceOffer} from '../src/core/choice-offer.js';
import {handleChoiceInput} from '../src/agent/executor.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {validateSave} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';
import {createApp} from '../src/server/app.js';
import {distinctChoiceIndices} from '../src/ai/choice-diversity.js';

const storageText='把木片放进小袋';
const activityText='休息五分钟';
const genericProposal=(minutes=5)=>({narrative:'候选',minutes,target_id:null,facts:[],relationship:null,item_move:null,
  storage_move:null,completion_quote:null,required_conditions:[],resolution:{type:'DETERMINISTIC' as const,
    domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}});
const narration={narrative:'你在这里休息了一会儿。',speaker:null,dialogue:null,choices:[activityText],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],choice_semantics:[]};
function addItem(save:SavePackage,id:string,name:string,container=false){
  const location=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
  save.entities.push({id,type:'item',components:{identity:{name,description:'普通测试物品',avatar_id:null},
    location:{location_id:location},item:{weight:0.2,stackable:false,container,tracking:'tracked'}}});
}
async function offered(text:string,withItems=false){
  const f=await sparseSetup(),save=await f.service.current();
  if(withItems){addItem(save,'test_wood','木片');addItem(save,'test_pouch','小袋',true);}
  const offers=makeChoiceOffers(save,[text],[{index:0,intent_key:'act',consequence_key:'perform',target_id:null}]);
  save.last_turn={narrative:'眼前的普通场景。',speaker:null,dialogue:null,choices:offers.map(offer=>offer.text),
    choice_offers:offers,context_actions:[]};
  await f.store.write(save);
  return {...f,save,offer:offers[0]};
}
function request(save:SavePackage,input:string){return {request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input};}
function mockActivity(f:Awaited<ReturnType<typeof offered>>){
  vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
  vi.spyOn(f.ai,'freeform').mockResolvedValue(genericProposal());
  vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
  return vi.spyOn(f.ai,'planGoals');
}

describe('Phase 4 structured choice offers',()=>{
  it('persists a lightweight offer with a stable ID and no bound entity ID',async()=>{
    const f=await offered(storageText,true),loaded=validateSave(await f.service.current());
    expect(f.offer).toMatchObject({id:expect.any(String),text:storageText,source_revision:f.save.state_revision,
      intent_key:'act',action_kind:'WORLD_ACTION',availability_at_generation:'CONDITIONALLY_EXECUTABLE'});
    expect(loaded.last_turn?.choices).toEqual([storageText]);
    expect(loaded.last_turn?.choice_offers?.[0].id).toBe(f.offer.id);
    expect(JSON.stringify(f.offer)).not.toContain('test_wood');
    expect(JSON.stringify(f.offer)).not.toContain('test_pouch');
  });
  it('projects internal entity references in both visible choice text and offer text',async()=>{
    const f=await offered(activityText,true),save=await f.service.current();
    const text='看一眼test_wood';
    save.last_turn!.choices=[text];save.last_turn!.choice_offers![0].text=text;
    await f.store.write(save);
    const view=await f.service.view();
    expect(view?.last_turn?.choices).toEqual(['看一眼木片']);
    expect(view?.last_turn?.choice_offers?.[0].text).toBe('看一眼木片');
    expect(view?.last_turn?.choice_offers?.[0].id).toBe(f.offer.id);
  });
  it('executes offer semantics without a second Planner pass and generates the next offer batch',async()=>{
    const f=await offered(activityText),planner=mockActivity(f),interpreter=vi.spyOn(f.ai,'interpret');
    const result=await handleChoiceInput(f.service,request(f.save,activityText),f.offer.id);
    const after=await f.service.current();
    expect(result.plan?.goals).toMatchObject([{normalized_goal:activityText,status:'completed'}]);
    expect(planner).not.toHaveBeenCalled();
    expect(interpreter).not.toHaveBeenCalled();
    expect(after.state_revision).toBe(f.save.state_revision+1);
    expect(after.last_turn?.choice_offers?.[0]).toMatchObject({text:activityText,source_revision:after.state_revision});
    expect(after.last_turn?.choice_offers?.[0].goal_contract?.contract).toMatchObject({
      source:'choice',original_intent:activityText,source_revision:after.state_revision,last_observed_revision:after.state_revision});
    expect(after.last_turn?.choice_offers?.[0].id).not.toBe(f.offer.id);
    await expect(handleChoiceInput(f.service,request(after,activityText),f.offer.id)).rejects.toThrow('失效');
  });
  it('rebinding allows a later revision when conditions still hold',async()=>{
    const f=await offered(activityText),planner=mockActivity(f);
    const later=await f.service.current();later.state_revision++;await f.store.write(later);
    const result=await handleChoiceInput(f.service,request(later,activityText),f.offer.id);
    expect(result.plan?.status).toBe('completed');expect(planner).not.toHaveBeenCalled();
  });
  it('rejects an absent item or moved container before any turn or time change',async()=>{
    for(const missing of ['test_wood','test_pouch']){
      const f=await offered(storageText,true),changed=await f.service.current();
      if(missing==='test_wood')changed.entities=changed.entities.filter(entity=>entity.id!==missing);
      else changed.entities.find(entity=>entity.id===missing)!.components.location!.location_id='station';
      changed.state_revision++;await f.store.write(changed);
      const before=await f.service.current();
      await expect(handleChoiceInput(f.service,request(before,storageText),f.offer.id)).rejects.toThrow();
      expect(await f.service.current()).toEqual(before);
    }
  });
  it('does not offer storage with missing canonical entities or downgrade it to activity',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(makeChoiceOffers(save,[storageText])).toEqual([]);
    expect(classifyChoiceExecution(save,storageText)).toBe('NOT_EXECUTABLE');
    expect(makeChoiceOffers(save,[activityText])).toHaveLength(1);
  });
  it('filters unsupported persistent-progress promises without filtering ordinary activity',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(makeChoiceOffers(save,['把剩下的作业全部做完'])).toEqual([]);
    expect(makeChoiceOffers(save,['继续写一会儿作业'])).toHaveLength(1);
  });
  it('loads text-only legacy choices and checks current binding before planning',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    save.last_turn={narrative:'旧场景',speaker:null,dialogue:null,choices:[storageText],context_actions:[]};
    await f.store.write(save);
    expect((await f.service.current()).last_turn?.choices).toEqual([storageText]);
    await expect(handleChoiceInput(f.service,request(save,storageText),null,true)).rejects.toThrow('不可执行');
    expect((await f.service.current()).state_revision).toBe(save.state_revision);
  });
  it('keeps a valid legacy text-only choice executable through the established path',async()=>{
    const f=await offered(activityText),save=await f.service.current();
    delete save.last_turn!.choice_offers;await f.store.write(save);
    mockActivity(f);
    const result=await handleChoiceInput(f.service,request(save,activityText),null,true);
    expect(result.plan?.status).toBe('completed');
    expect((await f.service.current()).state_revision).toBe(save.state_revision+1);
  });
  it('rejects forged display text and missing offer IDs without guessing a new action',async()=>{
    const f=await offered(activityText),planner=vi.spyOn(f.ai,'planGoals');
    await expect(handleChoiceInput(f.service,request(f.save,'去别的地方'),f.offer.id)).rejects.toThrow('不一致');
    await expect(handleChoiceInput(f.service,request(f.save,activityText),randomUUID())).rejects.toThrow('失效');
    expect(planner).not.toHaveBeenCalled();
    expect((await f.service.current()).state_revision).toBe(f.save.state_revision);
  });
  it('retains the Phase 3 single candidate path for eligible local compound offers',async()=>{
    const text='走到厨房，再休息一会儿',f=await offered(text),steps=f.offer.step_hints;
    expect(steps).toHaveLength(2);
    const planner=mockActivity(f),freeform=vi.spyOn(f.ai,'freeform');
    const result=await handleChoiceInput(f.service,request(f.save,text),f.offer.id);
    expect(result.plan?.status).toBe('completed');
    expect(result.plan?.local_compound?.steps).toEqual(steps);
    expect(freeform).toHaveBeenCalledTimes(2);
    expect((await f.service.current()).state_revision).toBe(f.save.state_revision+1);
    expect(planner).not.toHaveBeenCalled();
  });
  it('rebinds a named public target and rejects it after removal',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const target=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    const name=String(target.components.identity?.name),text=`向${name}说句话`;
    const offers=makeChoiceOffers(save,[text],[{index:0,intent_key:'talk',consequence_key:'speak',target_id:target.id}]);
    expect(offers[0].target_mentions).toEqual([name]);
    save.last_turn={narrative:'场景',speaker:null,dialogue:null,choices:[text],choice_offers:offers,context_actions:[]};
    await f.store.write(save);
    const changed=await f.service.current();changed.entities=changed.entities.filter(entity=>entity.id!==target.id);
    changed.state_revision++;await f.store.write(changed);
    expect(()=>checkChoiceOffer(changed,offers[0])).toThrow('目标目前不可用');
  });
  it('executes a speech offer with the newly bound character through TALK rather than reinterpreting text',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const target=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    target.components.location={location_id:save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id};
    const text=`对${target.components.identity?.name}说：你好`;
    const offer=makeChoiceOffers(save,[text],[{index:0,intent_key:'talk',consequence_key:'greet',target_id:target.id}])[0];
    expect(offer.action_kind).toBe('WORLD_SPEECH');
    save.last_turn={narrative:'场景',speaker:null,dialogue:null,choices:[text],choice_offers:[offer],context_actions:[]};
    await f.store.write(save);
    const interpret=vi.spyOn(f.ai,'interpret'),narrate=vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration,choices:[]});
    const result=await handleChoiceInput(f.service,request(save,text),offer.id);
    expect(result.plan?.status).toBe('completed');
    expect(interpret).not.toHaveBeenCalled();
    expect(narrate.mock.calls[0][1]).toMatchObject({type:'TALK',target_id:target.id});
  });
  it('keeps semantic indices attached to their original choices after filtering',()=>{
    const meanings=[{index:0,intent_key:'a',consequence_key:'a',target_id:null},
      {index:1,intent_key:'b',consequence_key:'b',target_id:null}];
    expect(distinctChoiceIndices(['相同文字','相同文字'],meanings,new Set([1]))).toEqual([1]);
  });
  it('identifies the offer over HTTP and refuses tampered text without a state write',async()=>{
    const f=await offered(activityText);mockActivity(f);
    const server=createApp(f.service).listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
      const token=(await(await fetch(base+'/api/session')).json()).token;
      const post=async(input:string)=>{
        const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
          body:JSON.stringify({...request(f.save,input),choice_offer_id:f.offer.id})});
        return {status:response.status,body:await response.json()};
      };
      const rejected=await post('去另一个地方');
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect((await f.service.current()).state_revision).toBe(f.save.state_revision);
      const accepted=await post(activityText);
      expect(accepted.status).toBe(200);
      expect(accepted.body.view.last_turn.choice_offers[0].id).not.toBe(f.offer.id);
    }finally{server.close();}
  });
});
