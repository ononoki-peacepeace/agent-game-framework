import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {settleAutonomousNpcTurn,type NpcDecision} from '../src/agent/npc-agent.js';
import {recordNpcActivityPlans,sceneResultSchema} from '../src/agent/scene-interaction.js';
import type {GameService} from '../src/server/service.js';
const quiet=():NpcDecision=>({kind:'no_action',speech:null,vote_target:null,intent:'保留自己的安排',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'此时无须行动',social_response:null});
function fixture(){const save=newSave(demo),model=structuredClone(save.entities.find(e=>e.id==='npc_lin')!);
 save.definition.events=[];save.entities=save.entities.filter(e=>!e.components.character||e.id===save.player_state.entity_id);
 delete save.entities.find(e=>e.id===save.player_state.entity_id)!.components.relationships;save.npc_agent_state={};
 for(let i=0;i<6;i++){const npc=structuredClone(model);npc.id=`resident_${i}`;npc.components.location={location_id:'square'};delete npc.components.relationships;save.entities.push(npc);}
 return save;}
function fake(){const seen:string[]=[];return {seen,service:{ai:{npcDecision:async(_p:unknown,c:any)=>{seen.push(c.npc_id);return quiet();}}} as unknown as GameService};}
async function advance(save:ReturnType<typeof fixture>,minutes:number,service:GameService){const before=structuredClone(save.runtime.time),id=randomUUID();
 return (await settleAutonomousNpcTurn(service,executeAction(save,{type:'WAIT',parameters:{minutes}},id).save,before,id)).save;}
describe('persisted NPC scheduling debt and long WAIT',()=>{
 it('persists failure separately, gives unserved residents priority and retries before the full cadence',async()=>{
   const ai=fake(),original=ai.service.ai.npcDecision.bind(ai.service.ai);let fail=true;
   ai.service.ai.npcDecision=async(p,c)=>{if(fail){fail=false;ai.seen.push((c as any).npc_id);throw Error('plan_updates: expected array');}return original(p,c);};
   let save=await advance(fixture(),180,ai.service);const first=ai.seen[0];
   expect(save.npc_agent_state![first].last_autonomous_at).toBeUndefined();
   expect(save.npc_agent_state![first].autonomy_retry?.attempts).toBe(1);
   const failedTime=structuredClone(save.runtime.time);save=validateSave(JSON.parse(JSON.stringify(save)));
   for(let i=0;i<5;i++)save=await advance(save,1,ai.service);
   expect(new Set(ai.seen).size).toBe(6);expect(ai.seen.filter(id=>id===first)).toHaveLength(1);
   save=await advance(save,10,ai.service);
   expect(ai.seen.filter(id=>id===first)).toHaveLength(2);
   expect(save.npc_agent_state![first].autonomy_retry).toBeUndefined();
   expect(save.npc_agent_state![first].last_autonomous_at?.minute).toBe(failedTime.minute+15);
 });
 it('uses bounded exponential backoff and never repeats an attempt for the same request',async()=>{
   let calls=0,save=fixture();save.entities=save.entities.filter(e=>!e.id.startsWith('resident_')||e.id==='resident_0');
   const service={ai:{npcDecision:async()=>{calls++;throw Error('invalid output');}}} as unknown as GameService;
   const before=structuredClone(save.runtime.time),requestId=randomUUID();
   save=(await settleAutonomousNpcTurn(service,executeAction(save,{type:'WAIT',parameters:{minutes:180}},requestId).save,before,requestId)).save;
   const retry=JSON.parse(JSON.stringify(save));
   save=(await settleAutonomousNpcTurn(service,save,before,requestId)).save;
   expect(calls).toBe(1);expect(save.npc_agent_state!.resident_0.autonomy_retry).toEqual(retry.npc_agent_state.resident_0.autonomy_retry);
   for(const delay of [15,30,60,120,180]){
     const previous=calls;save=await advance(save,delay-1,service);expect(calls).toBe(previous);
     save=await advance(save,1,service);expect(calls).toBe(previous+1);
   }
   expect(save.npc_agent_state!.resident_0.last_autonomous_at).toBeUndefined();
   expect(save.npc_agent_state!.resident_0.autonomy_retry?.attempts).toBe(6);
 });
 it('does not consume every resident opportunity when only one was serviced',async()=>{const ai=fake();let save=fixture();
 save=await advance(save,180,ai.service);expect(ai.seen).toHaveLength(1);
 save=validateSave(JSON.parse(JSON.stringify(save)));save=await advance(save,1,ai.service);
 expect(new Set(ai.seen).size).toBe(2);
 for(let i=0;i<4;i++)save=await advance(save,1,ai.service);
 expect(new Set(ai.seen).size).toBe(6);
 });
 it('does not erase legacy never-serviced NPCs behind the last global anchor',async()=>{const ai=fake();const save=fixture();
 save.runtime.time.minute+=240;save.npc_autonomy_last_at=structuredClone(save.runtime.time);
 const after=await advance(save,30,ai.service);expect(ai.seen.length).toBeGreaterThan(0);expect(ai.seen.length).toBeLessThanOrEqual(2);
 expect(after.runtime.time.minute).toBe(save.runtime.time.minute+30);
 });
 it('services deferred daily residents without waiting another global hour',async()=>{const ai=fake();let save=fixture();
 save=await advance(save,60,ai.service);save=await advance(save,1,ai.service);
 expect(new Set(save.resolution_receipts?.filter(r=>r.semantic_action==='INSPECT').map(r=>r.actor_id)).size).toBe(4);
 expect(ai.seen).toEqual([]);
 });
 it('uses a long paid interval to complete a multi-edge own plan instead of one edge per player input',async()=>{
 const save=newSave(demo),ai=fake(),scene=sceneResultSchema.parse({understanding:'自己的安排',narrative:'林舟决定去车站。',dialogue:'我去车站办事。',
 speech_events:[{speaker_id:'npc_lin',utterance:'我去车站办事。',provenance:'npc_response'}],effects:[],
 npc_activity_intents:[{npc_id:'npc_lin',speech_index:0,destination_id:'market',readiness:'ready',condition:null,plan_id:null}]});
 // Two real edges, each required; no direct square -> market route.
 const direct=save.definition.map!.routes.find(r=>r.from==='square'&&r.to==='market')!;
 save.definition.map!.routes=save.definition.map!.routes.filter(r=>!(r.from==='square'&&r.to==='market'));
 save.definition.map!.routes.push({...direct,from:'station',to:'market',travel_minutes:6});
 recordNpcActivityPlans(save,scene,randomUUID(),'square');const before=structuredClone(save.runtime.time);
 const result=await advance(save,40,ai.service);
 expect(result.entities.find(e=>e.id==='npc_lin')!.components.location?.location_id).toBe('market');
 expect(result.resolution_receipts?.filter(r=>r.actor_id==='npc_lin'&&r.semantic_action==='MOVE')).toHaveLength(2);
 expect(result.runtime.time.minute-before.minute).toBe(40);expect(ai.seen).toEqual([]);
 });
});
