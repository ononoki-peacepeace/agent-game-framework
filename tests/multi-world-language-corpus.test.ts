import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {demo} from './helpers.js';
import {sparseWorld} from './sparse-fixture.js';
import {newSave,validateSave} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';

// Candidates are declared fixtures. No model-interpretation or independent-review claim.
const corpus=JSON.parse(await readFile(new URL('../docs/multi-world-language-corpus.v1.json',import.meta.url),'utf8')) as {
 cases:{id:string;world:'trade'|'relations'|'continuity';boundary:string;input:string;setup?:string;expect:string}[]};
type Case=typeof corpus.cases[number];
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const entity=(s:SavePackage,id:string)=>s.entities.find(e=>e.id===id)!;
const wallet=(s:SavePackage)=>entity(s,'player').components.wallet as {balances:Record<string,number>};
const inventory=(s:SavePackage)=>entity(s,'player').components.inventory as {items:Record<string,number>};
const shop=(s:SavePackage)=>entity(s,'corner_shop').components.shop as {stock:Record<string,number>;prices:Record<string,{buy:number}>};
const relations=(s:SavePackage)=>entity(s,'player').components.relationships as {entries:Record<string,Record<string,number>>};
const playerReceipts=(s:SavePackage)=>s.resolution_receipts?.filter(r=>r.actor_id===s.player_state.entity_id)??[];
const goal=(id:string,text:string,operation:GoalInput['operation_hint'],referent:string,type:GoalInput['type']='WORLD_ACTION'):GoalInput=>({
 goal_id:id,type,normalized_goal:text,operation_hint:operation,referent,target_entities:[],depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'}});
function goals(c:Case):GoalInput[]{
 let steps:GoalInput[];
 if(c.world==='trade'){
  const move=goal('move','去街角商店','move','街角商店');
  const buy=goal('buy',c.boundary==='ambiguity'?'买点东西':'购买一份面包','purchase',c.boundary==='ambiguity'?'商品':'面包');
  buy.depends_on=['move'];steps=[move,buy];
 }else if(c.world==='relations'){
  steps=[goal('talk',c.boundary==='normal'||c.boundary==='restart_replay'||c.boundary==='technical_failure'?c.input:'向林舟问好','talk','林舟','WORLD_SPEECH')];
  if(c.boundary==='partial_failure')steps.push({...goal('second','向乔宁问好','talk','乔宁','WORLD_SPEECH'),depends_on:['talk']});
 }else steps=[c.boundary==='ambiguity'?goal('move',c.input,'move','那里'):
  c.boundary==='world_refusal'?goal('move','去河岸车站','move','河岸车站'):
  goal('hold','留在广场整理值班记录十分钟','activity','整理值班记录')];
 if(c.boundary.startsWith('condition_')){
  const familiar=c.world==='relations',id=c.world==='continuity'?'npc_qiao':'npc_lin';
  const check={...goal('condition',familiar?'判断我和林舟是否熟悉':`判断${id==='npc_lin'?'林舟':'乔宁'}是否在这里`,undefined,id,'CONDITIONAL_INTENT'),
   condition:{kind:familiar?'familiar' as const:'present' as const,entity_id:id,description:familiar?'我和林舟比较熟':`${id==='npc_lin'?'林舟':'乔宁'}在这里`}};
  steps[0].depends_on=['condition'];steps[0].branch='then';steps.unshift(check);
 }
 return steps;
}
function seed(c:Case){
 const w=c.world==='continuity'?sparseWorld():structuredClone(demo);w.events=[];
 if(c.world==='relations'){
  w.enabled_modules=w.enabled_modules.filter(m=>m!=='commerce');w.entities=w.entities.filter(e=>e.id!=='corner_shop');
  w.ruleset.relationship_dimensions={familiarity:{min:0,max:100,initial:0,event_deltas:{contact:1}}};
 }
 let s=newSave(w);s.runtime.time={day:1,minute:540};
 entity(s,'player').components.location={location_id:'square'};entity(s,'npc_lin').components.location={location_id:'square'};
 entity(s,'npc_qiao').components.location={location_id:'station'};
 if(c.world==='relations')entity(s,'player').components.relationships={entries:{npc_lin:{familiarity:c.boundary==='condition_true'?60:0}}};
 if(c.setup==='zero funds')wallet(s).balances.credit=0;
 if(c.setup==='two people named Lin'){
  entity(s,'npc_qiao').components.identity.name='林舟';entity(s,'npc_qiao').components.location={location_id:'square'};
 }
 if(c.setup==='Lin absent')entity(s,'npc_lin').components.location={location_id:'station'};
 if(c.setup==='Qiao present')entity(s,'npc_qiao').components.location={location_id:'square'};
 if(c.setup==='no usable route')s.definition.map!.routes=[];
 if(c.world==='continuity'){
  // Different active structure: actual routine calendar, executable NPC departure and timed offscreen state machine.
  recordNpcActivityPlans(s,sceneResultSchema.parse({understanding:'已授权的值班出发',narrative:'林舟准备去市场。',
   dialogue:'我去市场。',speech_events:[{speaker_id:'npc_lin',utterance:'我去市场。',provenance:'npc_response'}],effects:[],
   npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',readiness:'ready',condition:null,plan_id:null}]}),randomUUID(),'square');
  s.npc_daily_last_at=structuredClone(s.runtime.time);s.npc_autonomy_last_at=structuredClone(s.runtime.time);
  s.definition.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:180,replenishment:false};
  s.definition.background_incidents=[{id:'handover',title:'远处值班交接',summary:'车站岗位按时交接',source:'WORLD_PACKAGE',causal_parent_id:null,
   causal_source_refs:[],created_at:s.runtime.time,earliest_activation:s.runtime.time,latest_activation:null,activation_flags:[],activation_chance:1,
   participants:['npc_qiao'],locations:['station'],causal_basis:{underlying_pressure:'岗位需要交接',actor_motivation:'完成值班',resource_constraint:'交接需要时间',
    historical_cause:'既有岗位安排',social_relationship:'值班同事',trigger:'交接时间到来',unintended_consequence:'记录留在车站'},
   stages:[{id:'start',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',effects:[{kind:'set_flag',flag:'corpus_handover_started'}],exposures:[],terminal:'none'},
    {id:'finish',earliest_after_minutes:5,latest_after_minutes:null,required_flags:[],actor_id:'npc_qiao',effects:[{kind:'set_flag',flag:'corpus_handover_finished'}],
     exposures:[{id:'notice',channel:'public_notice',location_id:'station',npc_id:null,text:'远处交接记录已经签收。',interrupt:false,open_loop_label:null}],terminal:'resolved'}]}];
  delete s.background_state;
  if(c.boundary==='partial_failure'){
   entity(s,'player').components.opportunities={entries:{corpus_meeting:{status:'accepted',title:'已接受的值班会面'}}};
   s.routine_meta={version:1,calendar_issue:null,migration_ids:[],scheduled_tasks:[{id:'corpus_meeting',label:'已接受的值班会面',at:1981,window:'exact',status:'accepted',source:'prior appointment',resolved:false}]};
  }
 }
 return validateSave(s);
}
async function setup(c:Case){
 const semanticInputs:string[]=[];
 const ai=new AIRuntime({name:'fixed-corpus-offline',generate:async r=>{
  const p=(r.schema as {properties?:Record<string,unknown>}).properties??{};
  if('preserved' in p)return {data:{preserved:true,reason:'固定原句和候选'}};
  if('aligned' in p)return {data:{aligned:true,reason:'固定候选保留原句'}};
  if('verdict' in p)return {data:{verdict:'aligned',explanation:'固定原句和完整计划'}};
  if('domain' in p){
   const input=JSON.parse(r.prompt.split('\n\n').at(-1)!).input;semanticInputs.push(input);
   if(c.boundary==='technical_failure')throw new ProviderError('timeout','offline fixture','固定语料技术故障');
   return {data:{domain:'world',kind:'world_action',confidence:.99,answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null}};
  }
  throw new Error(`Unexpected offline call ${r.role}/${Object.keys(p).join(',')}`);
 }});
 vi.spyOn(ai,'planGoals').mockResolvedValue({goals:goals(c)});
 const interpretations:string[]=[];
 vi.spyOn(ai,'interpret').mockImplementation(async(_view,input)=>{
  interpretations.push(input);
  if(c.world==='relations')return {type:'TALK',target_id:input.includes('乔宁')&&!input.includes('林舟')?'npc_qiao':'npc_lin',parameters:{topic:input}};
  return {type:'HOLD',parameters:{minutes:10,activity:'整理值班记录'}};
 });
 vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('refusal','offline fixture','固定降级描写'));
 vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'未结算的活动候选',minutes:10,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'整理值班记录',stages:[],evidence_ids:[]}});
 vi.spyOn(ai,'npcDecision').mockResolvedValue({kind:'no_action',speech:null,vote_target:null,intent:'保持已有计划',proposed_action:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'无新增行动',social_response:null});
 const directory=await mkdtemp(join(tmpdir(),'agf-language-corpus-')),store=new JsonStore(directory),initial=seed(c);await store.write(initial);
 let service=new GameService(store,ai,initial.definition),server:Server|undefined;
 const close=async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}};
 cleanups.push(async()=>{await close();await rm(directory,{recursive:true,force:true});});
 const start=async()=>{server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');};
 const before=await service.current();await start();
 if(c.world==='trade'&&c.boundary==='partial_failure'){
  const turn=service.turn.bind(service);vi.spyOn(service,'turn').mockImplementation(async(...args)=>{
   if((args[0] as {action?:{type?:string}}).action?.type==='BUY')throw new ProviderError('timeout','offline fixture','固定购买技术故障');return turn(...args);
  });
 }
 const body={input:c.input,game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 const post=async()=>{
  const base=`http://127.0.0.1:${(server!.address() as {port:number}).port}`;
  const {token}=await (await fetch(base+'/api/session')).json() as {token:string};
  const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as Record<string,any>};
 };
 return {before,post,semanticInputs,interpretations,get service(){return service;},async replay(){
  const after=await service.current(),bytes=await readFile(join(directory,'current.json'));await close();
  const replayAI=new AIRuntime({name:'replay-no-generation',generate:async()=>{throw Error('Replay generated');}});
  service=new GameService(new JsonStore(directory),replayAI,initial.definition);await start();const result=await post();
  expect(await service.current()).toEqual(after);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(replayAI.metrics.requests).toBe(0);return result;
 }};
}

describe('fixed multi-world natural-language corpus v1 (controlled offline candidates)',()=>{
 it('pins all original cases and required structural boundary groups',()=>{
  expect(corpus.cases).toHaveLength(24);expect(new Set(corpus.cases.map(c=>c.id)).size).toBe(24);
  for(const world of ['trade','relations','continuity'])expect(corpus.cases.filter(c=>c.world===world).map(c=>c.boundary).sort())
   .toEqual(['normal','ambiguity','world_refusal','technical_failure','restart_replay','condition_false','condition_true','partial_failure'].sort());
 });
 it.each(corpus.cases)('$id $world/$boundary: $input',async c=>{
  const f=await setup(c),result=await f.post(),after=await f.service.current(),receipts=playerReceipts(after),kinds=receipts.map(r=>r.semantic_action);
  await writeFile(join(process.cwd(),'.agent-runtime/codex/logs',`corpus-${c.id}.json`),JSON.stringify({result,before:f.before,after,interpretations:f.interpretations},null,2));
  expect(f.semanticInputs).toContain(c.input);
  if(c.boundary==='technical_failure'){
   expect(result.status).toBeGreaterThanOrEqual(400);expect(after).toEqual(f.before);return;
  }
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  if(c.boundary==='condition_false'||(c.world!=='trade'&&['ambiguity','world_refusal'].includes(c.boundary))){
   expect(receipts).toHaveLength(0);expect(after.runtime.time).toEqual(f.before.runtime.time);
   expect(after.entities).toEqual(f.before.entities);expect(after.npc_agent_state).toEqual(f.before.npc_agent_state);
   expect(after.background_state).toEqual(f.before.background_state);
  }else if(c.world==='trade'){
   const purchased=['normal','restart_replay','condition_true'].includes(c.boundary);
   expect(kinds).toEqual(purchased?['MOVE','BUY']:['MOVE']);
   expect(entity(after,'player').components.location?.location_id).toBe('market');
   const beforeItems=inventory(f.before).items.bread??0,items=inventory(after).items.bread??0;
   expect(items-beforeItems).toBe(purchased?1:0);
   const oldShop=shop(f.before),nextShop=shop(after);
   expect(oldShop.stock.bread-nextShop.stock.bread).toBe(purchased?1:0);
   expect(wallet(f.before).balances.credit-wallet(after).balances.credit).toBe(purchased?oldShop.prices.bread.buy:0);
   if(!purchased)expect(JSON.stringify(result.body)).toMatch(/未|需要|失败|不能|不足|选择/);
   if(c.boundary==='partial_failure')expect(result.body.outcome.type).toBe('engine_failure');
  }else if(c.world==='relations'){
   expect(kinds).toEqual(['TALK']);expect(receipts[0].target_id).toBe('npc_lin');
   const prior=relations(f.before).entries.npc_lin.familiarity;
   expect(relations(after).entries.npc_lin.familiarity).toBe(prior+1);
   expect(relations(after).entries.npc_qiao).toBeUndefined();
   if(c.boundary==='partial_failure')expect(JSON.stringify(result.body)).toMatch(/未|不能|不在|中断/);
  }else{
   const elapsed=c.boundary==='partial_failure'?1:10;expect(receipts).toHaveLength(1);expect(receipts[0].time_cost).toBe(elapsed);
   expect(kinds[0]==='HOLD'||receipts[0].activity?.description.includes('整理值班记录')).toBe(true);
   expect(after.runtime.time).toEqual({day:1,minute:540+elapsed});
   expect(after.last_turn!.narrative).toContain('整理值班记录');expect(after.last_turn!.narrative).toContain(`${elapsed}分钟`);
   expect(after.last_turn!.narrative).not.toContain('远处交接记录已经签收');
   if(elapsed===10){
    expect(entity(after,'npc_lin').components.location?.location_id).toBe('market');
    expect(after.resolution_receipts?.some(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toBe(true);
    expect(after.background_state?.incidents.find(i=>i.id==='handover')?.status).toBe('resolved');
   }else{
    expect(after.background_state?.incidents.find(i=>i.id==='handover')?.status).not.toBe('resolved');
    expect(after.last_turn!.narrative).toContain('已接受的值班会面');expect(after.last_turn!.narrative).not.toMatch(/10分钟|十分钟|完成/);
   }
  }
  if(c.boundary==='restart_replay'||(c.world==='trade'&&c.boundary==='partial_failure'))expect(await f.replay()).toEqual(result);
 },20000);
});
