import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demo} from './helpers.js';
import {newSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保留本人事务',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'继续核对自己的方法',social_response:null});
it.each([1,3])('preserves bounded progress for %i transaction-owned replacements across fresh time intervals',async count=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-plan-replacement-'));
 try{
  const save=newSave(demo);save.definition.events=[];
  save.definition.map!.locations.find(p=>p.id==='market')!.lifecycle={status:'closed',visibility:'public',origin:'existing_detail',creation_reason:'固定测试封闭地点',source_ref:'fixture',recorded_at:save.runtime.time};
  const state=emptyNpcAgentState();state.last_daily_at={...save.runtime.time};state.last_autonomous_at={...save.runtime.time};
  state.goals=[{id:'long_goal',description:'本人持续事务',horizon:'long',status:'active',origin:'self',priority:5}];
  state.plans=[{id:'original',goal_id:'long_goal',intention:'先观察再前往市场',status:'active',execution:{steps:[
   {type:'INSPECT',target_id:null,description:'观察环境',duration_minutes:null,speech:null},
   {type:'MOVE',target_id:'market',description:'前往市场',duration_minutes:null,speech:null}],cursor:0,not_before:null,condition:null,
   last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:null}}];
  const third=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);third.id='npc_mei';third.components.identity.name='梅青';save.entities.push(third);
  save.npc_agent_state={};const ids=['npc_lin','npc_qiao','npc_mei'].slice(0,count);
  for(const id of ids){save.entities.find(e=>e.id===id)!.components.location={location_id:'square'};save.npc_agent_state[id]=structuredClone(state);}
  const store=new JsonStore(directory);await store.write(save);
  const ai=new AIRuntime({name:'replacement-offline',generate:async()=>({data:quiet()})}),service=new GameService(store,ai,save.definition);
  const tx=async(operation:unknown,mutate:(s:typeof save)=>void)=>{
   const now=await service.current();await service.agentTransaction({game_id:now.game_id,expected_revision:now.state_revision,request_id:randomUUID()},operation,mutate);
  };
  for(let i=0;i<3;i++)await tx({wait:i},s=>Object.assign(s,executeAction(s,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save));
  const blocked=await service.current();expect(blocked.npc_agent_state!.npc_lin.plans[0].execution).toMatchObject({cursor:1,blocked_reason:'core_rejected'});
  const replacement:NpcDecision={...quiet(),plan_updates:[{plan_id:'original',status:'abandoned'}],plan_proposals:[{id:'replacement',goal_id:'long_goal',
   intention:'依据当前事实调整方法',steps:[{type:'HOLD',target_id:null,description:'依据当前事实继续本人事务',duration_minutes:2,speech:null},
    {type:'INSPECT',target_id:null,description:'核对本人方法执行后的当前环境',duration_minutes:null,speech:null}]}]};
  for(const id of ids)await tx({owner_review:id},s=>applyNpcDecision(s,id,'replacement-review',replacement));
  await tx({wait_after_replacement:true},s=>Object.assign(s,executeAction(s,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save));
  const first=await service.current();
  if(count===3)expect(ids.some(id=>first.npc_agent_state![id].plans.find(p=>p.id==='replacement')!.execution!.blocked_reason==='action_budget')).toBe(true);
  const prefix=first.resolution_receipts?.filter(r=>r.actor_id!=='player')??[];
  await tx({next_paid_interval:true},s=>Object.assign(s,executeAction(s,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save));
  const after=await service.current();
  expect(after.resolution_receipts?.filter(r=>prefix.some(p=>p.request_id===r.request_id))).toEqual(prefix);
  for(const id of ids){const plan=after.npc_agent_state![id].plans.find(p=>p.id==='replacement')!;
   expect(plan,JSON.stringify({id,plan,receipts:after.resolution_receipts?.filter(r=>r.actor_id===id)})).toMatchObject({status:'completed',execution:{cursor:2}});
   expect(after.resolution_receipts?.filter(r=>r.actor_id===id).map(r=>r.semantic_action)).toEqual(['INSPECT','HOLD','INSPECT']);}
 }finally{await rm(directory,{recursive:true,force:true});}
});
