import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {agentPresentation} from '../src/client/agent-presentation.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const goal=(id:string,text:string,depends_on:string[]=[]):GoalInput=>({goal_id:id,type:'WORLD_ACTION',normalized_goal:text,
 depends_on,condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]});
it.each(['world','provider'] as const)('shows the %s stop and unexecuted remainder after an earlier authoritative WAIT',async reason=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];
 before.definition.map!.locations.find(p=>p.id==='station')!.lifecycle={origin:'world_event',status:'closed',visibility:'public',source_ref:'fixture',creation_reason:'既有事件关闭此处',recorded_at:{...before.runtime.time}};
 await f.store.write(before);
 vi.spyOn(f.ai,'interpret').mockImplementation(async(_save,input)=>{
  if(input==='等一分钟')return {type:'WAIT',parameters:{minutes:1}};
  if(reason==='provider')throw new ProviderError('timeout','offline fixture','interpret failed');
  return {type:'MOVE',target_id:'station',parameters:{companions:'none'}};
 });
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你等了一分钟。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],presence_claims:[]});
 const plan=validatePlan({goals:[goal('wait','等一分钟'),goal('move','去河岸车站',['wait']),goal('later','到了之后等五分钟',['move'])]});
 const result=await executePlan(f.service,{input:'等一分钟，再去河岸车站，到了之后等五分钟',game_id:before.game_id,
  expected_revision:before.state_revision,request_id:randomUUID()},plan);
 const after=await f.service.current();
 expect(result.results?.map(g=>g.status)).toEqual(['completed',reason==='world'?'blocked':'failed','skipped']);
 expect(result.outcome).toMatchObject(reason==='world'?{type:'game',kind:'blocked_by_world',goal_status:'partial'}:{type:'engine_failure',receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(after.resolution_receipts?.map(r=>r.semantic_action)).toEqual(['WAIT']);
 expect(result.story).toBe('你等了一分钟。');
 if(reason==='world'){
  expect(result.message).toContain('去河岸车站');expect(result.message).toContain('无法进入');
  expect(result.message).toContain('到了之后等五分钟');expect(result.message).toMatch(/尚未执行|没有执行/);
  expect(result.presentation).toBe('story');
 }else {expect(result.message).toContain('前面已经结算');expect(result.presentation).toBe('failure');}
 const shown=agentPresentation(f.service.project(before),result);
 expect(shown.agentReply?.message).toBe(result.message);
 expect(agentPresentation(result.view!,result).agentReply?.message).toBe(result.message);
 expect(result.message).not.toMatch(/schema|Core|receipt|provider|world_action:/);
});
