import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {buildNpcAgentContext,decideNpc,applyNpcDecision,type NpcDecision} from '../src/agent/npc-agent.js';
import {executeAction} from '../src/core/runtime.js';
import type {GameService} from '../src/server/service.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonStore} from '../src/storage/json-store.js';
import {AIRuntime} from '../src/ai/runtime.js';

const folders:string[]=[];
afterEach(async()=>{for(const path of folders.splice(0))await rm(path,{recursive:true,force:true});});

function fixture(balance:number,quantity:number){
 const save=newSave(demo);save.definition.events=[];
 const npc=save.entities.find(e=>e.id==='npc_lin')!,peer=save.entities.find(e=>e.id==='npc_qiao')!;
 const item=save.entities.find(e=>e.components.item)!;
 npc.components.wallet={balances:{credit:balance}};npc.components.inventory={items:{[item.id]:quantity}};
 peer.components.wallet={balances:{credit:987654321}};peer.components.inventory={items:{[item.id]:87654321}};
 const state=emptyNpcAgentState();state.goals=[{id:'long_goal',description:'维持本人的日常准备',horizon:'long',status:'active',origin:'fixture',priority:6}];
 state.plans=[{id:'blocked',goal_id:'long_goal',intention:'原先的方法',status:'active',execution:{steps:[{type:'HOLD',target_id:null,description:'等待准备',duration_minutes:2,speech:null}],
  cursor:0,not_before:null,condition:null,last_accounted_at:{...save.runtime.time},time_credit_minutes:0,last_request_id:null,blocked_reason:'core_rejected'}}];
 save.npc_agent_state={npc_lin:state};return {save:validateSave(save),itemId:item.id};
}
const context=(save:ReturnType<typeof newSave>)=>buildNpcAgentContext(save,'npc_lin',{kind:'world_event',description:'核对当前资源再决定怎样继续自己的目标'});
it.each([[0,1],[23,7]])('projects the actual own balance %i and possession quantity %i without peer resources', (balance,quantity)=>{
 const {save,itemId}=fixture(balance,quantity),before=structuredClone(save),view=context(save);
 expect(view).toHaveProperty('own_wallet',{balances:{credit:balance}});
 expect(view.own_possessions.find(item=>item.id===itemId)).toHaveProperty('quantity',quantity);
 expect(JSON.stringify(view)).not.toMatch(/987654321|87654321/);expect(save).toEqual(before);
 expect(publicView(save).entities.find(e=>e.id==='npc_lin')?.components.wallet).toBeUndefined();
});
it('distinguishes an absent wallet from a confirmed zero and tracks changed or exhausted holdings',()=>{
 const {save,itemId}=fixture(23,7),npc=save.entities.find(e=>e.id==='npc_lin')!;
 delete npc.components.wallet;expect(context(save)).toHaveProperty('own_wallet',null);
 npc.components.wallet={balances:{credit:0}};npc.components.inventory={items:{[itemId]:0}};
 const view=context(save);expect(view).toHaveProperty('own_wallet',{balances:{credit:0}});expect(view.own_possessions.some(item=>item.id===itemId)).toBe(false);
});
it('rebuilds own resources from persisted state after JsonStore recreation',async()=>{
 const {save,itemId}=fixture(23,7),path=await mkdtemp(join(tmpdir(),'agf-npc-resources-'));folders.push(path);
 await new JsonStore(path).write(save);const loaded=(await new JsonStore(path).read())!;
 const view=context(loaded);expect(view).toHaveProperty('own_wallet',{balances:{credit:23}});
 expect(view.own_possessions.find(item=>item.id===itemId)).toHaveProperty('quantity',7);expect(context(save)).toEqual(view);
});
it('passes only own resources and their interpretation through the actual NPC runtime prompt',async()=>{
 const {save}=fixture(23,7),prompts:string[]=[];
 const ai=new AIRuntime({name:'fixture',generate:async request=>{
  prompts.push(request.prompt);return {data:{kind:'no_action',speech:null,vote_target:null,intent:'核对资源后暂不行动',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'保留长期目标，未消费资源'}};
 }});
 await decideNpc({ai} as GameService,save,'npc_lin',{kind:'world_event',description:'本人资源核对'});
 expect(prompts).toHaveLength(1);expect(prompts[0]).toContain('own_wallet');expect(prompts[0]).toContain('quantity');expect(prompts[0]).toContain('不得推定余额为零');
 expect(prompts[0]).not.toMatch(/987654321|87654321/);
});
it.each([0,23])('lets the owner revise one blocked plan using current resources without changing its long goal (balance=%i)',async balance=>{
 const {save}=fixture(balance,1),before=structuredClone(save);
 const service={ai:{npcDecision:async(_profile:unknown,value:ReturnType<typeof context>)=>{
  const wallet=(value as unknown as {own_wallet?:{balances:Record<string,number>}}).own_wallet;
  if(!wallet)throw Error('own resource facts unavailable');
  const low=wallet.balances.credit===0;
  const decision:NpcDecision={kind:'no_action',speech:null,social_response:null,vote_target:null,intent:low?'先盘点现有物品':'先核对准备安排',proposed_action:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],
   plan_updates:[{plan_id:'blocked',status:'abandoned'}],plan_proposals:[{id:'resource_revision',goal_id:'long_goal',intention:low?'按现有物资调整方法':'保留资源核对安排',
    steps:[{type:'HOLD',target_id:null,description:low?'盘点现有物品':'核对准备安排',duration_minutes:2,speech:null}]}],decision_summary:'依据本人的当前资源换一种方法，保留长期目标'};
  return decision;
 }}} as unknown as GameService;
 const decision=await decideNpc(service,save,'npc_lin',{kind:'world_event',description:'本人的资源发生变化'});expect(save).toEqual(before);
 applyNpcDecision(save,'npc_lin','resources-review',decision);
 let after=executeAction(save,{type:'WAIT',parameters:{minutes:3}},randomUUID()).save;
 expect(after.npc_agent_state!.npc_lin.goals).toEqual(before.npc_agent_state!.npc_lin.goals);
 expect(after.npc_agent_state!.npc_lin.plans.find(p=>p.id==='resource_revision')!.status).toBe('completed');
 expect(after.entities.find(e=>e.id==='npc_lin')!.components.wallet).toEqual(before.entities.find(e=>e.id==='npc_lin')!.components.wallet);
 after=executeAction(after,{type:'WAIT',parameters:{minutes:3}},randomUUID()).save;
 expect(after.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD')).toHaveLength(1);validateSave(after);
});
