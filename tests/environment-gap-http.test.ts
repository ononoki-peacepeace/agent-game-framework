import {afterEach,describe,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';
import {validateSave} from '../src/core/state.js';
import type {EnvironmentAssessment} from '../src/core/environment-schema.js';
import {executeAction} from '../src/core/runtime.js';
import {ensureOrdinaryItem,putItemInInventory,setItemCondition} from '../src/modules/inventory.js';
import {ProviderError} from '../src/ai/failures.js';

// Synthetic decisions go through production HTTP/Semantic/Plan/Freeform/Core,
// never a real provider. No full historical environmental response was retained.
const resources:{path:string;servers:Server[]}[]=[];
afterEach(async()=>{for(const r of resources.splice(0)){
  for(const s of r.servers)await new Promise<void>(done=>s.close(()=>done()));
  await rm(r.path,{recursive:true,force:true});
}});
function jsonValue(prompt:string,field:string){
  const at=prompt.indexOf(`"${field}":`);if(at<0)return null;
  const from=prompt.indexOf(':',at)+1;
  for(let end=from+1;end<=prompt.length;end++){
    try{return JSON.parse(prompt.slice(from,end));}catch{}
  }
  return null;
}
async function setup(overrides:Partial<EnvironmentAssessment>={},hint='environment_query',forcePlanner=false){
  const path=await mkdtemp(join(tmpdir(),'agf-environment-http-')),resource={path,servers:[] as Server[]};resources.push(resource);
  const world=sparseWorld();world.meta.description='现代城市的公共办公楼，采用现代生活设施。';
  world.map!.locations.find(l=>l.id==='square')!.description='公共办公室设有来访登记桌，供电正常，桌面干净。';
  let input='',name='充电器',intent:'observe'|'take_if_available'='observe',assessments=0,bindings=0;
  let failAssessment=false,invalidAssessment=false,badQuote=false,badBasis=false,failNarrator=false,narrations=0;
  const stages:string[]=[];
  const assessment:EnvironmentAssessment={authorized_intent:'observe',scope_complete:true,classification:'ordinary_item',existence:'present',ownership:'unclaimed',
    world_compatible:true,scene_compatible:true,contradicts_known:false,resource_advantage:false,weight:.2,
    description:'普通办公用品，不含额外线索。',basis:[{source:'scene',quote:'公共办公室'}],same_as:null,...overrides};
  const ai=new AIRuntime({name:'environment-http-reconstruction',generate:async request=>{
    const p=(request.schema as any).properties??{};
    stages.push(p.interaction_lane?'semantic':p.preserved?'semantic_fidelity':p.goals?'planner':p.verdict?'goal_alignment':
      p.resolution?'freeform':p.classification?'environment_adjudication':p.grounded?'narrative_audit':request.role);
    if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
      answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,interaction_lane:'world_transaction',player_speech_mode:'none',
      goal_spec:{objective:input,play_action:'other',targets:[],desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
        temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,external_artifact:false,multi_step:forcePlanner,ambiguity:null}}};
    if(p.preserved)return {data:{preserved:true,reason:'保持原始授权'}};
    if(p.verdict)return {data:{verdict:'aligned',explanation:'执行有界检查而非保证获得物品'}};
    if(p.grounded)return {data:{grounded:true,reports_result:true,reason:'正文只复述本次权威检查结果',unsupported_claims:[]}};
    if(p.goals)return {data:{goals:[{goal_id:'query',type:'WORLD_ACTION',normalized_goal:input,
      operation_hint:hint,referent:name,item_destination:hint==='item_move'?'held':null,target_entities:[],depends_on:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}};
    if(p.resolution){bindings++;return {data:{narrative:'检查普通环境对象',minutes:2,target_id:null,
      environment_query:{name,source_quote:badQuote&&bindings===1?'另一条输入':input,intent},facts:[],relationship:null,item_move:null,required_conditions:[],
      resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:'检查对象存在与可取得性',stages:[],evidence_ids:[]}}};}
    if(p.classification){assessments++;
      if(failAssessment)throw new ProviderError('timeout','isolated','isolated timeout');
      if(invalidAssessment&&assessments===1)return {data:{...assessment,authorized_intent:intent,weight:'invalid'}};
      if(badBasis&&assessments===1)return {data:{...assessment,authorized_intent:intent,basis:[{source:'scene',quote:'不存在的海盗船'}]}};
      if(invalidAssessment){expect(request.prompt).toContain('weight');expect(request.prompt).toContain('previous_output');}
      if(badBasis){expect(request.prompt).toContain('unbound_context');expect(request.prompt).toContain('previous_output');}
      return {data:{...assessment,authorized_intent:assessment.authorized_intent==='invalid'?'invalid':intent}};
    }
    if(request.role==='narrator'){
      narrations++;
      if(failNarrator)throw new ProviderError('timeout','isolated','isolated narrator timeout');
      const receipt=jsonValue(request.prompt,'resolution_receipt');
      return {data:{narrative:receipt?.canonical_facts?.slice(0,2).join(' ')??'你检查了当前环境。',speaker:null,dialogue:null,
        choices:[],context_actions:[],patches:[],item_claims:[],stable_locations:[],mechanical_claims:[]}};
    }
    throw Error('unexpected isolated request '+Object.keys(p).join(','));
  }});
  const store=new JsonStore(path),service=new GameService(store,ai,world);await service.newGame();
  const open=async(svc=service)=>{
    const server=createApp(svc,undefined,undefined,join(path,'assets')).listen(0,'127.0.0.1');resource.servers.push(server);
    await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`;
    const {token}=await (await fetch(base+'/api/session')).json() as any;
    return async(route:string,body:unknown)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
      return {status:r.status,data:await r.json() as any};};
  };
  const post=await open();
  const query=async(take=false,objectName='充电器',http=post)=>{
    name=objectName;intent=take?'take_if_available':'observe';
    input=take?`我检查桌上是否有${name}，有的话拿起来。`:`我想确认这间办公室有没有${name}。`;
    const before=await service.current(),body={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input};
    const response=await http('/api/input',body),after=await service.current();
    return {before,after,body,response,receipt:after.resolution_receipts?.findLast(r=>r.semantic_action===input)};
  };
  return {service,store,ai,post,query,open,assessment,assessments:()=>assessments,bindings:()=>bindings,
    narrations:()=>narrations,stages,
    fail:()=>{failAssessment=true;},invalid:()=>{invalidAssessment=true;},badQuote:()=>{badQuote=true;},badBasis:()=>{badBasis=true;},
    failNarrator:()=>{failNarrator=true;}};
}
const generated=(s:Awaited<ReturnType<GameService['current']>>)=>s.entities.filter(e=>(e.components.item?.tags as string[]|undefined)?.includes('gap_generated'));
const expectCommitted=(q:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['query']>>)=>{
  expect(q.response.status).toBe(200);
  expect(q.response.data.outcome?.type,JSON.stringify({message:q.response.data.message,outcome:q.response.data.outcome})).not.toBe('engine_failure');
  expect(q.after.state_revision,JSON.stringify(q.response.data.message)).toBeGreaterThan(q.before.state_revision);
  expect(q.receipt?.commit_status).toBe('committed');expect(q.receipt?.environment).toBeDefined();
};

describe('ordinary world-gap adjudication -> Core -> inventory -> durable HTTP transaction',()=>{
  it('creates one mundane item and takes it only after actual authorization; retries are idempotent',async()=>{
    const f=await setup({},'environment_query',true),q=await f.query(true);expectCommitted(q);
    expect(f.stages).toContain('planner');
    expect(q.receipt!.environment).toMatchObject({status:'present',taken:true,reason:'taken'});
    const [item]=generated(q.after);expect(item).toBeDefined();
    expect(q.after.entities.find(e=>e.id==='player')!.components.inventory?.items).toHaveProperty(item.id,1);
    expect(item.components.item?.owner_id).toBe('player');expect(item.components.location).toBeUndefined();
    expect(q.after.runtime.time.minute-q.before.runtime.time.minute).toBe(2);
    expect(f.narrations()).toBe(1);expect(q.after.last_turn?.narrative).toContain('并将这件物品收好');
    if(process.env.AGF_WRITE_QA_EVIDENCE==='1')await writeFile(join(process.cwd(),'docs/qa-world-gap-offline-evidence.json'),JSON.stringify({
      kind:'offline_http_reconstruction',real_provider:false,input:q.body.input,stages:f.stages,
      provider_calls:f.stages.length,runtime_counter:f.ai.metrics.requests,revision_before:q.before.state_revision,revision_after:q.after.state_revision,
      time_before:q.before.runtime.time,time_after:q.after.runtime.time,receipt:q.receipt,
      resolution:q.after.environment_state,narrative:q.after.last_turn?.narrative,
      item:{id:item.id,name:item.components.identity.name,owner:item.components.item?.owner_id,inventory_quantity:1},
    },null,2));
    const calls=f.ai.metrics.requests;await f.post('/api/input',q.body);
    expect(f.ai.metrics.requests).toBe(calls);expect((await f.service.current()).state_revision).toBe(q.after.state_revision);
    expect((await f.store.read())!.environment_state).toEqual(q.after.environment_state);
  });
  it('absence is a successful inspection with time, receipt, stable negative decision and no item',async()=>{
    const f=await setup({existence:'absent'}),q=await f.query(true);expectCommitted(q);
    expect(q.receipt!.environment).toMatchObject({status:'absent',taken:false,reason:'not_found'});
    expect(generated(q.after)).toHaveLength(0);expect(q.after.runtime.time.minute-q.before.runtime.time.minute).toBe(2);
    f.assessment.existence='present';const again=await f.query(true);expectCommitted(again);
    expect(again.receipt?.environment?.status).toBe('absent');expect(generated(again.after)).toHaveLength(0);
    expect(again.after.environment_state?.resolutions).toHaveLength(1);
  });
  it('observation creates no possession; later legal pickup reuses the exact entity',async()=>{
    const f=await setup(),q=await f.query();expectCommitted(q);const [item]=generated(q.after);
    expect(item.components.location?.location_id).toBe('square');
    const taken=await f.query(true);expectCommitted(taken);expect(generated(taken.after)).toHaveLength(1);
    expect(taken.receipt!.environment?.entity_id).toBe(item.id);
  });
  it('a later authoritative item takes precedence over an old negative observation',async()=>{
    const f=await setup({existence:'absent'}),q=await f.query();expectCommitted(q);
    const s=structuredClone(q.after);s.entities.push({id:'delivered_charger',type:'item',components:{
      identity:{name:'充电器',description:'后来合法送到的普通物品'},item:{weight:.2,stackable:false}}});
    putItemInInventory(s,'delivered_charger');
    const delivered=executeAction(s,{type:'MOVE_ITEM',parameters:{item_id:'delivered_charger',to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    await f.store.write(delivered);const later=await f.query(true);expectCommitted(later);
    expect(later.receipt?.environment).toMatchObject({status:'present',entity_id:'delivered_charger',taken:true});
    expect(generated(later.after)).toHaveLength(0);
  });
  it('supports the existing unresolved item_move contract without inventing an item ID',async()=>{
    const f=await setup({},'item_move',true),q=await f.query(true);expectCommitted(q);expect(f.stages).toContain('planner');
    expect(q.receipt?.environment?.taken).toBe(true);
  });
  it('keeps nonportable scenery as a persistent detail, not inventory or a new map area',async()=>{
    const f=await setup({classification:'environment_detail',ownership:'shared'}),q=await f.query(true,'墙面装饰');expectCommitted(q);
    expect(generated(q.after)).toHaveLength(0);expect(q.receipt?.environment?.reason).toBe('permission_required');
    expect(f.service.project(q.after).locations.find(l=>l.id==='square')?.description).toContain('墙面装饰');
    expect(q.after.map_state).toEqual(q.before.map_state);
    expect(q.after.entities.find(e=>e.id==='player')?.components.scene_position).toEqual(q.before.entities.find(e=>e.id==='player')?.components.scene_position);
  });
  it.each(['protected','scarce_resource','valuable','hazardous','consumable'] as const)('never materializes %s',async classification=>{
    const f=await setup({classification}),q=await f.query(true);expectCommitted(q);
    expect(q.receipt?.environment).toMatchObject({status:'unresolved',taken:false});expect(generated(q.after)).toHaveLength(0);
    expect(q.after.gm_state).toEqual(q.before.gm_state);
  });
  it.each([{world_compatible:false},{scene_compatible:false},{contradicts_known:true},{resource_advantage:true},{ownership:'private' as const}])('refuses unsupported context %j',async flags=>{
    const f=await setup(flags),q=await f.query(true);expectCommitted(q);expect(generated(q.after)).toHaveLength(0);
    expect(q.receipt?.environment?.status).toBe('unresolved');
  });
  it('uses the actual world era and allows absence without inventing modern resources',async()=>{
    const f=await setup({existence:'absent',world_compatible:false,basis:[{source:'world',quote:'古代山村'}]});
    const s=await f.service.current();s.definition.meta.description='古代山村中的石屋，尚无电力设施。';
    s.definition.map!.locations.find(l=>l.id==='square')!.description='石屋中只有木桌和长凳。';await f.store.write(s);
    const q=await f.query(true);expectCommitted(q);expect(q.receipt?.environment?.status).toBe('absent');expect(generated(q.after)).toHaveLength(0);
  });
  it('never promotes free assessor prose into an extra clue or world secret',async()=>{
    const f=await setup({description:'旁边的暗格藏着一份未公开的秘密证据。'}),q=await f.query(true);expectCommitted(q);
    expect(q.after.last_turn?.narrative).not.toContain('暗格');
    expect(JSON.stringify(q.after.environment_state)).not.toContain('秘密证据');
    expect(q.after.gm_state).toEqual(q.before.gm_state);
  });
  it('does not duplicate a real remotely held object or reveal its owner/location',async()=>{
    const f=await setup(),s=await f.service.current();
    s.entities.push({id:'real_charger',type:'item',components:{identity:{name:'充电器',description:'已登记的私人物品'},item:{weight:.2,stackable:false,owner_id:'npc_lin'}}});
    s.entities.find(e=>e.id==='npc_lin')!.components.inventory={items:{real_charger:1}};await f.store.write(s);
    const q=await f.query(true);expectCommitted(q);expect(generated(q.after)).toHaveLength(0);
    expect(q.receipt!.environment).toMatchObject({status:'unresolved',entity_id:null,taken:false});
    expect(q.after.entities.find(e=>e.id==='npc_lin')?.components.inventory).toEqual({items:{real_charger:1}});
  });
  it('a visible owned object needs permission in both natural input and direct Core MOVE_ITEM',async()=>{
    const f=await setup(),s=await f.service.current();s.entities.push({id:'owned_charger',type:'item',components:{
      identity:{name:'充电器',description:'已登记的私人物品'},item:{weight:.2,stackable:false,owner_id:'npc_lin'},location:{location_id:'square'}}});await f.store.write(s);
    const q=await f.query(true);expectCommitted(q);expect(q.receipt?.environment?.reason).toBe('permission_required');
    expect(()=>executeAction(q.after,{type:'MOVE_ITEM',parameters:{item_id:'owned_charger',to:'held'}},randomUUID())).toThrow('属于其他人物');
    expect(()=>ensureOrdinaryItem(q.after,'充电器',.2)).not.toThrow();
  });
  it('new aliases cannot clone a resolved object, and taking it elsewhere cannot replenish the original spot',async()=>{
    const f=await setup(),q=await f.query(true);expectCommitted(q);const [record]=q.after.environment_state!.resolutions;
    f.assessment.same_as=record.id;const alias=await f.query(true,'电源适配器');expectCommitted(alias);
    expect(generated(alias.after)).toHaveLength(1);expect(alias.receipt?.environment?.entity_id).toBe(record.entity_id);
    expect(alias.after.environment_state!.resolutions[0].aliases).toContain('电源适配器');
    const moved=structuredClone(alias.after);const item=moved.entities.find(e=>e.id===record.entity_id)!;
    const inventory=moved.entities.find(e=>e.id==='player')!.components.inventory! as {items:Record<string,number>;placements?:Record<string,string|null>};
    delete inventory.items[record.entity_id!];delete inventory.placements?.[record.entity_id!];
    item.components.location={location_id:'market'};delete item.components.item!.owner_id;await f.store.write(moved);
    const again=await f.query(true);expectCommitted(again);expect(generated(again.after)).toHaveLength(1);
    expect(again.receipt?.environment?.taken).toBe(false);
  });
  it('location resource budget is persistent and does not refill after item pickup',async()=>{
    const f=await setup();
    for(const name of ['普通夹子','便签夹','橡皮块']){const q=await f.query(true,name);expectCommitted(q);}
    const q=await f.query(true,'纸质书签');expectCommitted(q);expect(generated(q.after)).toHaveLength(3);
    expect(q.receipt?.environment).toMatchObject({status:'unresolved',taken:false,reason:'budget'});
  });
  it('cannot sell generated resources even if a shop later acquires a price entry',async()=>{
    const f=await setup(),q=await f.query(true);expectCommitted(q);const [item]=generated(q.after);
    const s=structuredClone(q.after),shop=s.entities.find(e=>e.components.shop)!;shop.components.location={location_id:'square'};
    (shop.components.shop!.prices as any)[item.id]={buy:10,sell:5};
    expect(()=>executeAction(s,{type:'SELL',target_id:shop.id,parameters:{item_id:item.id,quantity:1}},randomUUID())).toThrow('不参与经济交易');
  });
  it('Save/Reload/Undo restores item, decision, ownership and time together',async()=>{
    const f=await setup(),q=await f.query(true);expectCommitted(q);
    const reloaded=new GameService(new JsonStore(f.store.directory),f.ai,sparseWorld());
    const saved=await reloaded.current();expect(saved.environment_state).toEqual(q.after.environment_state);
    const post=await f.open(reloaded),calls=f.stages.length;
    expect((await post('/api/input',q.body)).status).toBe(200);expect(f.stages.length).toBe(calls);
    expect(generated(await reloaded.current())).toHaveLength(1);
    const undo=await post('/api/undo',{request_id:randomUUID(),game_id:saved.game_id,expected_revision:saved.state_revision});
    expect(undo.status).toBe(200);const restored=await reloaded.current();
    expect(restored.runtime.time).toEqual(q.before.runtime.time);expect(restored.environment_state).toEqual(q.before.environment_state);
    expect(restored.entities).toEqual(q.before.entities);expect(validateSave(restored)).toBeDefined();
  });
  it('Undo of a later interaction preserves an earlier negative fact despite a changed proposal',async()=>{
    const f=await setup({existence:'absent'}),first=await f.query(true);expectCommitted(first);
    f.assessment.existence='present';const second=await f.query(true,'便签夹');expectCommitted(second);
    const undone=await f.post('/api/undo',{request_id:randomUUID(),game_id:second.after.game_id,expected_revision:second.after.state_revision});
    expect(undone.status).toBe(200);expect((await f.service.current()).environment_state).toEqual(first.after.environment_state);
    const again=await f.query(true);expectCommitted(again);expect(again.receipt?.environment?.status).toBe('absent');
    expect(generated(again.after)).toHaveLength(0);
  });
  it('closed-loop raw Core actions can drop, retake and transfer the same generated entity',async()=>{
    const f=await setup(),start=await f.service.current();
    start.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:'square'};await f.store.write(start);
    const first=await f.query(true);expectCommitted(first);const id=generated(first.after)[0].id;
    const action=async(value:unknown)=>{const s=await f.service.current();const r=await f.post('/api/action',{
      request_id:randomUUID(),game_id:s.game_id,expected_revision:s.state_revision,action:value});expect(r.status,JSON.stringify(r.data)).toBe(200);};
    await action({type:'MOVE_ITEM',parameters:{item_id:id,to:'scene'}});
    const again=await f.query(true);expectCommitted(again);expect(again.receipt?.environment?.entity_id).toBe(id);
    await action({type:'TRANSFER_ITEM',target_id:'npc_lin',parameters:{item_id:id}});
    const final=await f.query(true);expectCommitted(final);expect(generated(final.after)).toHaveLength(1);
    expect(final.receipt?.environment?.taken).toBe(false);
    expect(final.after.entities.find(e=>e.id==='npc_lin')?.components.inventory?.items).toHaveProperty(id,1);
  });
  it('destruction retains the original decision and cannot refresh a replacement',async()=>{
    const f=await setup(),q=await f.query(true);expectCommitted(q);const s=structuredClone(q.after),id=generated(s)[0].id;
    setItemCondition(s,id,'destroyed',randomUUID());await f.store.write(s);
    const again=await f.query(true);expectCommitted(again);expect(generated(again.after)).toHaveLength(1);
    expect(again.receipt?.environment?.taken).toBe(false);expect(again.after.entities.find(e=>e.id===id)?.components.item?.condition).toBe('destroyed');
  });
  it('shared mundane objects do not become private property through the raw item action',async()=>{
    const f=await setup({ownership:'shared'}),q=await f.query(true);expectCommitted(q);
    const [item]=generated(q.after);expect(item).toBeDefined();expect(q.receipt?.environment?.reason).toBe('permission_required');
    expect(()=>executeAction(q.after,{type:'MOVE_ITEM',parameters:{item_id:item.id,to:'held'}},randomUUID())).toThrow('共同设施');
  });
  it('a missing biography possession is not silently repaired by environmental materialization',async()=>{
    const f=await setup(),s=await f.service.current();s.entities.find(e=>e.id==='player')!.components.identity.description='随身只有相机和外套。';
    await f.store.write(s);const q=await f.query(true,'相机');expectCommitted(q);
    expect(q.receipt?.environment?.status).toBe('unresolved');expect(generated(q.after)).toHaveLength(0);
  });
  it('protected committed facts cannot be materialized even if a reconstruction assessor misclassifies them',async()=>{
    const f=await setup(),s=await f.service.current();
    s.gm_state.hidden_truth={version:1,commitments:[{id:'sealed_truth',commitment:'HARD_TRUTH',statement:'某张凭证卡涉及受保护的事件。',
      seed_constraint:null,source:'GM_DECLARED',created_event_ref:null,evidence:[],known_by:[]}]};await f.store.write(s);
    const q=await f.query(true,'凭证卡');expectCommitted(q);expect(generated(q.after)).toHaveLength(0);
    expect(q.after.gm_state).toEqual(q.before.gm_state);expect(q.receipt?.environment?.status).toBe('unresolved');
  });
  it('the global resource budget survives moving to a fresh location',async()=>{
    const f=await setup(),s=await f.service.current();s.environment_state={resolutions:[]};
    for(let i=0;i<24;i++){
      const loc='budget_loc_'+Math.floor(i/3),id='item_budget_'+i;
      if(i%3===0)s.definition.map!.locations.push({id:loc,name:'预算地点'+i,description:'既有公共地点',tags:[],known_by_default:false});
      s.entities.push({id,type:'item',components:{identity:{name:'既有补全物品'+i,description:'日常物品'},
        location:{location_id:loc},item:{weight:.1,stackable:false,tags:['gap_generated','non_tradeable']}}});
      s.environment_state.resolutions.push({id:'env_budget_'+i,name:'既有补全物品'+i,aliases:[],location_id:loc,status:'present',
        classification:'ordinary_item',entity_id:id,description:'既有普通物品',take_allowed:true,source_request_id:randomUUID(),at:{day:1,minute:0}});
    }
    await f.store.write(s);const q=await f.query(true);expectCommitted(q);
    expect(generated(q.after)).toHaveLength(24);expect(q.receipt?.environment?.reason).toBe('budget');
  });
  it('rejects incomplete action scope without losing an independent action or advancing time',async()=>{
    const f=await setup({scope_complete:false}),q=await f.query(true);
    expect(q.after.state_revision).toBe(q.before.state_revision);expect(q.after.runtime.time).toEqual(q.before.runtime.time);
    expect(generated(q.after)).toHaveLength(0);
  });
  it('repairs a malformed source quote before adjudication, and repairs only a bad assessment basis',async()=>{
    const f=await setup();f.badQuote();const q=await f.query(true);expectCommitted(q);
    expect(f.bindings()).toBe(2);expect(f.assessments()).toBe(1);
    const other=await setup();other.badBasis();const result=await other.query(true);expectCommitted(result);
    expect(other.bindings()).toBe(1);expect(other.assessments()).toBe(2);
  });
  it('a post-Core Narrator timeout never leaves an item without its commit receipt',async()=>{
    const f=await setup();f.failNarrator();const q=await f.query(true);
    expectCommitted(q);expect(q.receipt?.environment?.taken).toBe(true);
    expect(generated(q.after)).toHaveLength(1);expect(q.after.last_turn?.narrative).toContain('并将这件物品收好');
    const calls=f.ai.metrics.requests;await f.post('/api/input',q.body);
    expect(f.ai.metrics.requests).toBe(calls);expect((await f.service.current()).state_revision).toBe(q.after.state_revision);
  });
  it('bounded schema correction repairs only adjudication; transport failure never regenerates/reexecutes',async()=>{
    const f=await setup();f.invalid();const q=await f.query(true);expectCommitted(q);expect(f.assessments()).toBe(2);expect(f.bindings()).toBe(1);
    const broken=await setup();broken.fail();const failure=await broken.query(true);
    expect(failure.after.state_revision).toBe(failure.before.state_revision);expect(broken.assessments()).toBe(1);
    expect(generated(failure.after)).toHaveLength(0);expect(failure.after.environment_state).toBeUndefined();
  });
});
