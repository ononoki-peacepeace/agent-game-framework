import {it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import * as core from '../src/core/runtime.js';
import {settleAutonomousNpcTurn,decideNpc,type NpcDecision} from '../src/agent/npc-agent.js';
import type {GameService} from '../src/server/service.js';
afterEach(()=>vi.restoreAllMocks());
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保留安排',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'此时不行动',social_response:null});
function paired(type:'MOVE'|'INSPECT'|'TALK'|'HOLD'='MOVE'):NpcDecision{
 const target=type==='MOVE'?'market':type==='TALK'?'npc_qiao':null;
 const text='处理自己当前的普通安排',speech=type==='TALK'?'我来说明一下自己的安排。':null;
 return {...quiet(),kind:'proposed_action',speech,proposed_action:{type,target_id:target,reason:text,duration_minutes:type==='HOLD'?8:null},
  goal_proposals:[{id:'own_goal',description:text,horizon:'short',priority:4}],
  plan_proposals:[{id:'own_plan',goal_id:'own_goal',intention:text,steps:[{type,target_id:target,description:text,speech,duration_minutes:type==='HOLD'?8:null}]}]};
}
function fixture(decision=paired()){
 const save=newSave(demo);save.definition.events=[];
 if(decision.proposed_action?.type==='TALK')save.entities.find(e=>e.id==='npc_qiao')!.components.location=
   structuredClone(save.entities.find(e=>e.id==='npc_lin')!.components.location);
 return {save,service:{ai:{npcDecision:async(_p:unknown,c:any)=>c.npc_id==='npc_lin'?decision:quiet()}} as unknown as GameService};
}
async function advance(f:ReturnType<typeof fixture>,minutes:number,id=randomUUID()){
 const before=structuredClone(f.save.runtime.time);
 return (await settleAutonomousNpcTurn(f.service,core.executeAction(f.save,{type:'WAIT',parameters:{minutes}},id).save,before,id)).save;
}
it.each(['MOVE','INSPECT','TALK','HOLD'] as const)('shares one %s receipt with the first plan step',async(type)=>{
 const f=fixture(paired(type)),before=structuredClone(f.save.runtime.time),after=await advance(f,180);
 const plan=after.npc_agent_state!.npc_lin.plans[0],execution=plan.execution!;
 expect(execution.cursor).toBe(1);expect(plan.status).toBe('completed');
 const receipt=after.resolution_receipts!.find(r=>r.request_id===execution.last_receipt_id)!;
 expect(receipt).toMatchObject({actor_id:'npc_lin',semantic_action:type,commit_status:'committed'});
 expect(after.npc_agent_state!.npc_lin.goals[0].status).toBe('completed');
 expect(after.runtime.time.minute-before.minute).toBe(180);
 const reloaded=validateSave(JSON.parse(JSON.stringify(after)));f.save=reloaded;
 const next=await advance(f,2);
 expect(next.resolution_receipts!.filter(r=>r.request_id===receipt.request_id)).toHaveLength(1);
 expect(next.npc_agent_state!.npc_lin.plans[0].execution!.last_receipt_id).toBe(receipt.request_id);
});
it('continues the remaining plan steps without repeating the immediate MOVE',async()=>{
 const decision=paired();decision.plan_proposals[0].steps!.push(paired('HOLD').plan_proposals[0].steps![0]);
 const f=fixture(decision),after=await advance(f,180),first=after.npc_agent_state!.npc_lin.plans[0].execution!.last_receipt_id;
 f.save=validateSave(JSON.parse(JSON.stringify(after)));const next=await advance(f,8);
 expect(next.npc_agent_state!.npc_lin.plans[0].status).toBe('completed');
 expect(next.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
 expect(next.resolution_receipts!.some(r=>r.request_id===first)).toBe(true);
});
it('uses the single authoritative MOVE route cost rather than requiring the direct-edge estimate',async()=>{
 const f=fixture();const direct=f.save.definition.map!.routes.find(r=>r.from==='square'&&r.to==='market')!;
 direct.travel_minutes=40;
 f.save.definition.map!.routes=f.save.definition.map!.routes.filter(r=>!(r.from==='square'&&r.to==='station'||r.from==='station'&&r.to==='market'));
 f.save.definition.map!.routes.push({...structuredClone(direct),from:'square',to:'station',travel_minutes:1},
   {...structuredClone(direct),from:'station',to:'market',travel_minutes:1});
 const after=await advance(f,180),execution=after.npc_agent_state!.npc_lin.plans[0].execution!;
 expect(execution.cursor).toBe(1);
 expect(after.resolution_receipts!.find(r=>r.request_id===execution.last_receipt_id)!.time_cost).toBeLessThan(40);
});
it.each(['target','type','duration','focus','speech','future','condition','lane'] as const)('rejects a genuine or unprovable %s conflict',async(field)=>{
 const d=paired(field==='focus'?'INSPECT':field==='speech'?'TALK':field==='duration'?'HOLD':'MOVE'),f=fixture(d);
 if(field==='target')d.plan_proposals[0].steps![0].target_id='station';
 if(field==='type')d.plan_proposals[0].steps![0].type='INSPECT';
 if(field==='duration')d.plan_proposals[0].steps![0].duration_minutes=9;
 if(field==='focus')d.plan_proposals[0].steps![0].description='另一个调查范围';
 if(field==='speech')d.plan_proposals[0].steps![0].speech='另一句话';
 if(field==='future')d.plan_proposals[0].not_before={...f.save.runtime.time,minute:f.save.runtime.time.minute+1};
 if(field==='condition')d.plan_proposals[0].condition='先获得既有岗位的许可';
 await expect(decideNpc(f.service,f.save,'npc_lin',{kind:field==='lane'?'direct_scene':'world_event',description:'自己的安排'})).rejects.toThrow('NPC_IMMEDIATE_PLAN_CONFLICT');
 expect(f.save.npc_agent_state?.npc_lin?.plans??[]).toHaveLength(0);
});
it('leaves a first step pending when the paid time window is insufficient',async()=>{
 const f=fixture(paired('HOLD'));f.save.runtime.time.minute+=180;
 const after=await advance(f,1);expect(after.npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(0);
 expect(after.npc_agent_state!.npc_lin.plans[0].execution!.last_receipt_id).toBeUndefined();
 f.save=after;const next=await advance(f,8);expect(next.npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(1);
});
it('does not consume a plan step on Core rejection and later settles it once',async()=>{
 const f=fixture(),original=core.executeAction;
 vi.spyOn(core,'executeAction').mockImplementation((...args)=>{if(args[7]==='npc_lin'&&(args[1] as any).type==='MOVE')throw Error('isolated Core rejection');return original(...args);});
 const after=await advance(f,180),plan=after.npc_agent_state!.npc_lin.plans[0];
 expect(plan.execution).toMatchObject({cursor:0,blocked_reason:'core_rejected'});
 expect(after.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(0);
 vi.restoreAllMocks();f.save=after;const next=await advance(f,20);
 expect(next.npc_agent_state!.npc_lin.plans[0].execution!.cursor).toBe(1);
 expect(next.resolution_receipts!.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(1);
});
