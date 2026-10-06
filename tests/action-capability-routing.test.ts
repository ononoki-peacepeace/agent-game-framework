import {afterEach,describe,expect,it,vi} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {MemoryStore} from './helpers.js';
import {sparseWorld} from './sparse-fixture.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {makeCompiledChoiceOffers} from '../src/core/choice-offer.js';
import {compileGoalContract} from '../src/agent/goal-contract.js';
import {validatePlan} from '../src/agent/planner.js';
import {publicView} from '../src/core/state.js';

const temporal={scope:'now' as const,day_offset:0,window:'any' as const};
const narration={narrative:'你照着实际结算的结果完成了这一步。',speaker:null,dialogue:null,choices:[],
  context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
const goal=(id:string,text:string,hint:NonNullable<GoalInput['operation_hint']>,referent:string|null,
  type:GoalInput['type']='WORLD_ACTION',depends_on:string[]=[]):GoalInput=>({goal_id:id,type,normalized_goal:text,
  operation_hint:hint,referent,depends_on,condition:null,branch:null,temporal_scope:temporal,target_entities:[]});

const running:{server:Server;directory:string}[]=[];
afterEach(async()=>{for(const item of running.splice(0)){
  await new Promise<void>(resolve=>item.server.close(()=>resolve()));
  await rm(item.directory,{recursive:true,force:true});
}});

async function setup(plan:(input:string)=>{goals:GoalInput[]},speechTarget:string|null='npc_qiao',
  initialLocation='market',disableCommerce=false,endConversation=false){
  const world=sparseWorld(),player=world.entities.find(entity=>entity.id==='player')!;
  if(disableCommerce)world.enabled_modules=world.enabled_modules.filter(id=>id!=='commerce');
  player.components.location={location_id:initialLocation};
  (player.components.wallet as {balances:Record<string,number>}).balances.credit=12400;
  world.entities.find(entity=>entity.id==='bread')!.components.identity!.name='幕内便当';
  world.entities.find(entity=>entity.id==='notebook')!.components.location={location_id:'market'};
  const shop=world.entities.find(entity=>entity.id==='corner_shop')!;
  (shop.components.shop as {prices:Record<string,{buy:number;sell:number}>}).prices.bread.buy=498;
  const ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unexpected model call');}});
  const planned=vi.spyOn(ai,'planGoals').mockImplementation(async (_view,input)=>plan(input));
  vi.spyOn(ai,'systemAgent').mockImplementation(async()=>({destination:'WORLD_INTENT',confidence:0.99,
    clarification:null,speech_target_id:speechTarget,world_input:endConversation?'我要结束这次交谈':null,
    resolved_input:null,end_conversation:endConversation}) as never);
  vi.spyOn(ai,'narrate').mockResolvedValue(narration);
  const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'普通活动',minutes:2,target_id:null,
    facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
    resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'普通活动',stages:[],evidence_ids:[]}});
  const service=new GameService(new MemoryStore(),ai,world);await service.newGame();
  const directory=await mkdtemp(join(tmpdir(),'agf-action-capability-'));
  const server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');running.push({server,directory});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await (await fetch(`${base}/api/session`)).json()).token;
  const input=async(text:string,choiceOfferId?:string)=>{
    const before=await service.current();
    const requestId=randomUUID();
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
      body:JSON.stringify({request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision,input:text,
        ...(choiceOfferId?{choice_offer_id:choiceOfferId}:{})})});
    return {response,body:await response.json(),before,after:await service.current(),requestId};
  };
  return {service,input,planned,freeform,ai,base,token};
}

describe('registered Action capability through the ordinary HTTP input',()=>{
  it('does not let conversation context turn an authorized purchase into TALK or Freeform',async()=>{
    const env=await setup(input=>({goals:[goal('buy',input,'purchase','幕内便当')]}));
    const {response,body,before,after,requestId}=await env.input('买一份幕内便当。');
    expect(response.ok,JSON.stringify(body)).toBe(true);
    expect(env.planned).toHaveBeenCalledTimes(1);
    expect(body.plan?.goals[0].contract?.completion.kind).toBe('purchase');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
    expect(after.resolution_receipts?.some(receipt=>receipt.semantic_action==='TALK'||receipt.semantic_action==='FREEFORM_ACTION')).toBe(false);
    const actor=(save:typeof after)=>save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const store=(save:typeof after)=>save.entities.find(entity=>entity.id==='corner_shop')!;
    expect((actor(before).components.wallet as {balances:Record<string,number>}).balances.credit-
      (actor(after).components.wallet as {balances:Record<string,number>}).balances.credit).toBe(498);
    expect(((store(before).components.shop as {stock:Record<string,number>}).stock.bread)-
      ((store(after).components.shop as {stock:Record<string,number>}).stock.bread)).toBe(1);
    expect((actor(after).components.inventory as {items:Record<string,number>}).items.bread).toBe(1);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(env.freeform).not.toHaveBeenCalled();
    const trace=env.service.logger.entries({limit:1000}).filter(entry=>entry.request_id===requestId);
    const events=new Set(trace.map(entry=>entry.event));
    for(const event of ['agent.context_route','agent.goal_compiled','agent.tool_candidates',
      'agent.tool_selected','agent.parameters_bound','agent.action_selected','save.commit','agent.completion_checked'])
      expect(events.has(event),event).toBe(true);
    expect(new Set(trace.map(entry=>entry.trace_id)).size).toBe(1);
  });
  it('uses MOVE rather than TALK for an explicit destination during a conversation',async()=>{
    const env=await setup(()=>{throw Error('exact public destination should not require model planning');});
    const {body,after}=await env.input('去中央广场');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('square');
    expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('MOVE');
    expect(env.freeform).not.toHaveBeenCalled();
  });
  it('uses public presence evidence without turning observation into speech or movement',async()=>{
    const env=await setup(input=>({goals:[goal('observe',input,'presence_query','乔宁','WORLD_QUERY')]}));
    const {body,before,after}=await env.input('看看乔宁在不在');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(body.plan?.goals[0].result?.observation?.value).toBe('present');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('uses the conversational listener only after the current intent is classified as speech',async()=>{
    const env=await setup(input=>({goals:[goal('speak',input,'talk',null,'WORLD_SPEECH')]}));
    const {body,after}=await env.input('你好');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('TALK');
    expect(after.resolution_receipts?.at(-1)?.target_id).toBe('npc_qiao');
  });
  it('settles an ordinary activity with activity evidence rather than a registered trade',async()=>{
    const env=await setup(input=>({goals:[goal('activity',input,'activity',null)]}));
    const {body,after}=await env.input('伸个懒腰');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.resolution_receipts?.at(-1)?.activity?.occurred).toBe(true);
    expect(after.resolution_receipts?.at(-1)?.effects).toContain('activity');
    expect(env.freeform).toHaveBeenCalledTimes(1);
  });
  it('extends the same typed candidate path to a registered item action',async()=>{
    const env=await setup(input=>({goals:[{...goal('take',input,'item_move','笔记本'),item_destination:'held'}]}));
    const {body,before,after}=await env.input('拿起笔记本');
    expect(body.plan?.goals[0].contract?.completion).toMatchObject({kind:'item_location',item_id:'notebook',to:'held'});
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('MOVE_ITEM');
    expect((before.entities.find(entity=>entity.id==='player')?.components.inventory as {items:Record<string,number>}).items.notebook).toBeUndefined();
    expect((after.entities.find(entity=>entity.id==='player')?.components.inventory as {items:Record<string,number>}).items.notebook).toBe(1);
    expect(after.entities.find(entity=>entity.id==='notebook')?.components.location).toBeUndefined();
  });
  it('clicks a compiled Choice without reinterpreting its text and uses the same BUY evidence',async()=>{
    const text='买一份幕内便当。';
    const env=await setup(input=>({goals:[goal('buy',input,'purchase','幕内便当')]}));
    const save=await env.service.current(),offers=await makeCompiledChoiceOffers(save,[text],[],env.ai);
    expect(offers).toHaveLength(1);
    save.last_turn={narrative:'你站在店里。',speaker:null,dialogue:null,choices:[text],choice_offers:offers,context_actions:[]};
    await env.service.storage.write(save);
    const plannedBefore=env.planned.mock.calls.length;
    const {body,after}=await env.input(text,offers[0].id);
    expect(env.planned.mock.calls.length).toBe(plannedBefore);
    expect(body.plan?.contract?.source).toBe('choice');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY')).toHaveLength(1);
  });
  it('advances a cross-location graph, observes an independent NPC, and waits for a product choice',async()=>{
    const text='去街角商店买点吃的，顺便看看乔宁在不在。';
    const env=await setup(()=>({goals:[
      goal('move','前往街角商店','move','街角商店'),
      goal('buy','购买食物','purchase','食物','WORLD_ACTION',['move']),
      goal('observe','确认乔宁是否在店里','presence_query','乔宁','WORLD_QUERY',['move']),
    ]}),null,'square');
    const {body,after}=await env.input(text);
    expect(body.plan?.goals.map((entry:{status:string})=>entry.status)).toEqual(['completed','waiting_for_player','completed']);
    expect(after.entities.find(entity=>entity.id==='player')?.components.location?.location_id).toBe('market');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.resolution_receipts?.some(receipt=>receipt.semantic_action==='BUY')).toBe(false);
    expect(after.active_goal?.plan.status).toBe('waiting_for_player');
    const independent=await env.input('去中央广场');
    expect(independent.after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(2);
    expect(independent.after.active_goal?.plan.goals[1].status).toBe('waiting_for_player');
  });
  it('asks for product selection without charging',async()=>{
    const env=await setup(input=>({goals:[goal('buy',input,'purchase',null)]}));
    const waiting=await env.input('买点吃的');
    expect(waiting.body.plan?.status).toBe('waiting_for_player');
    expect(waiting.after.resolution_receipts?.some(receipt=>receipt.semantic_action==='BUY')??false).toBe(false);
    expect((waiting.after.entities.find(entity=>entity.id==='player')?.components.wallet as
      {balances:Record<string,number>}).balances.credit).toBe(12400);
  });
  it('reports an unavailable registered capability without falling back to invented trade prose',async()=>{
    const env=await setup(input=>({goals:[goal('buy',input,'purchase','幕内便当')]}),null,'market',true);
    const {body,before,after}=await env.input('买一份幕内便当。');
    expect(body.presentation).toBe('failure');
    expect(body.plan?.goals[0].contract?.availability).toBe('capability_gap');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(env.freeform).not.toHaveBeenCalled();
  });
  it('routes paraphrases of the same authorized purchase to the same Action',async()=>{
    for(const text of ['买一份幕内便当。','请给我一份幕内便当，我要付款。']){
      const env=await setup(input=>({goals:[goal('buy',input,'purchase','幕内便当')]}));
      const {body,after}=await env.input(text);
      expect(body.plan?.goals[0].status,text).toBe('completed');
      expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='BUY'),text).toHaveLength(1);
    }
  });
  it('preserves an explicit contextual TALK click without a second semantic plan',async()=>{
    const env=await setup(()=>{throw Error('explicit action must bypass semantic planning');});
    const before=await env.service.current();
    const response=await fetch(`${env.base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',
      'X-Game-Token':env.token},body:JSON.stringify({request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,action:{type:'TALK',target_id:'npc_qiao',parameters:{topic:'你好'}}})});
    expect(response.ok).toBe(true);
    expect((await env.service.current()).resolution_receipts?.at(-1)?.semantic_action).toBe('TALK');
    expect(env.planned).not.toHaveBeenCalled();
    const afterTalk=await env.service.current();
    const buy=await fetch(`${env.base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',
      'X-Game-Token':env.token},body:JSON.stringify({request_id:randomUUID(),game_id:afterTalk.game_id,
      expected_revision:afterTalk.state_revision,action:{type:'BUY',target_id:'corner_shop',
        parameters:{item_id:'bread',quantity:1}}})});
    expect(buy.ok).toBe(true);
    expect((await env.service.current()).resolution_receipts?.at(-1)?.semantic_action).toBe('BUY');
    expect(env.planned).not.toHaveBeenCalled();
  });
  it('binds a pronoun and a newly purchased held item for the same Choice and manual request',async()=>{
    const choice='请他帮忙把便当加热一下';
    const plan=(input:string)=>({goals:[input.includes('买')?
      goal('buy',input,'purchase','幕内便当'):
      {...goal('ask','向乔宁开口请他帮忙把幕内便当加热一下','talk','幕内便当','WORLD_SPEECH')} ]});
    for(const clicked of [true,false]){
      const env=await setup(plan);
      await env.input('你好');
      const bought=await env.input('买一份幕内便当。');
      expect(bought.after.interaction_context?.target_entity_id).toBe('npc_qiao');
      expect((bought.after.entities.find(entity=>entity.id==='player')?.components.inventory as
        {items:Record<string,number>}).items.bread).toBe(1);
      let offerId:string|undefined;
      if(clicked){
        const save=await env.service.current();
        const offers=await makeCompiledChoiceOffers(save,[choice],[],env.ai);
        expect(offers).toHaveLength(1);
        expect(offers[0].availability_at_generation).not.toBe('UNSUPPORTED');
        expect(offers[0].goal_contract?.goals[0].contract?.bindings).toEqual([
          expect.objectContaining({role:'person',entity_id:'npc_qiao',status:'bound'}),
          expect.objectContaining({role:'item',entity_id:'bread',status:'bound'}),
        ]);
        save.last_turn={narrative:'你站在店里。',speaker:null,dialogue:null,choices:[choice],choice_offers:offers,context_actions:[]};
        await env.service.storage.write(save);
        offerId=offers[0].id;
      }
      const priorCalls=env.planned.mock.calls.length;
      const result=await env.input(choice,offerId);
      expect(result.body.plan?.goals[0].status,JSON.stringify(result.body)).toBe('completed');
      expect(result.body.plan?.goals[0].contract?.completion).toMatchObject({kind:'conversation_attempted',person_id:'npc_qiao'});
      expect(result.after.resolution_receipts?.at(-1)?.semantic_action).toBe('TALK');
      expect(result.after.resolution_receipts?.at(-1)?.target_id).toBe('npc_qiao');
      expect((result.after.entities.find(entity=>entity.id==='player')?.components.inventory as
        {items:Record<string,number>}).items.bread).toBe(1);
      expect(result.after.resolution_receipts?.at(-1)?.effects).not.toContain('inventory');
      expect(env.planned.mock.calls.length-priorCalls).toBe(clicked?0:1);
    }
  });
  it('does not guess when a pronoun or held item has multiple valid referents',async()=>{
    const env=await setup(input=>({goals:[goal('ask',input,'talk','便当','WORLD_SPEECH')]}));
    const save=await env.service.current();
    const npc=save.entities.find(entity=>entity.id==='npc_qiao')!;
    save.entities.push({...structuredClone(npc),id:'npc_second',components:{...structuredClone(npc.components),identity:{name:'林晴'}}});
    const item=save.entities.find(entity=>entity.id==='bread')!;
    save.entities.push({...structuredClone(item),id:'second_bento',components:{...structuredClone(item.components),identity:{name:'牛肉便当'}}});
    const player=save.entities.find(entity=>entity.id==='player')!;
    (player.components.inventory as {items:Record<string,number>}).items.bread=1;
    (player.components.inventory as {items:Record<string,number>}).items.second_bento=1;
    const input='请他帮忙把便当加热一下';
    const proposed=validatePlan({goals:[goal('ask',input,'talk','便当','WORLD_SPEECH')]});
    const contract=compileGoalContract(publicView(save),proposed,{kind:'manual',text:input});
    expect(contract.goals[0].contract?.bindings).toEqual([
      expect.objectContaining({role:'person',entity_id:null,status:'ambiguous'}),
      expect.objectContaining({role:'item',entity_id:null,status:'ambiguous'}),
    ]);
    expect(contract.contract?.execution_availability).toBe('needs_binding');
    const offers=await makeCompiledChoiceOffers(save,[input],[],env.ai);
    expect(offers[0]?.availability_at_generation).toBe('UNSUPPORTED');
  });
  it('uses the only present character for a pronoun when no conversation is active',async()=>{
    const env=await setup(()=>({goals:[]}));
    const save=await env.service.current();
    const player=save.entities.find(entity=>entity.id==='player')!;
    (player.components.inventory as {items:Record<string,number>}).items.bread=1;
    const input='请他帮忙把便当加热一下';
    const proposed=validatePlan({goals:[goal('ask',input,'talk','便当','WORLD_SPEECH')]});
    const contract=compileGoalContract(publicView(save),proposed,{kind:'manual',text:input});
    expect(contract.goals[0].contract?.bindings).toEqual([
      expect.objectContaining({role:'person',entity_id:'npc_qiao',status:'bound'}),
      expect.objectContaining({role:'item',entity_id:'bread',status:'bound'}),
    ]);
  });
  it('keeps the explicit end-conversation signal when speech uses the shared contract runner',async()=>{
    const env=await setup(input=>({goals:[goal('speak',input,'talk',null,'WORLD_SPEECH')]}),
      'npc_qiao','market',false,true);
    const {body,after}=await env.input('我要结束这次交谈');
    expect(body.plan?.goals[0].status).toBe('completed');
    expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe('TALK');
    expect(after.interaction_context?.status).toBe('ended');
  });
});
