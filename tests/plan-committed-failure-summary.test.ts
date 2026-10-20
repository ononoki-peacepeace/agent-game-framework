import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executePlan} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import type {GoalInput} from '../src/agent/plan-schema.js';
import {ProviderError} from '../src/ai/failures.js';

afterEach(()=>vi.restoreAllMocks());
const goal:GoalInput={goal_id:'wait',type:'WORLD_ACTION',normalized_goal:'等一分钟',depends_on:[],condition:null,branch:null,
 temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]};
it.each(['contract','provider'] as const)('does not deny a saved WAIT when later response processing fails: %s',async kind=>{
 const f=await sparseSetup(),before=await f.service.current();before.definition.events=[];await f.store.write(before);
 const interpret=vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'WAIT',parameters:{minutes:1}});
 vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你等了一分钟。',speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
 const turn=f.service.turn.bind(f.service),fault=vi.spyOn(f.service,'turn').mockImplementation(async(...args)=>{
  await turn(...args);throw kind==='contract'?new Error('contract response processing failed after commit'):
   new ProviderError('timeout','controlled post-commit failure','post-commit response incomplete');
 });
 const body={input:'等一分钟',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
 const result=await executePlan(f.service,body,validatePlan({goals:[goal]})),after=await f.service.current();
 expect(result.outcome).toMatchObject({type:'engine_failure',receipt_ids:[after.resolution_receipts![0].request_id]});
 expect(result.story).toBe('你等了一分钟。');expect(result.results?.[0].summary).toContain('世界状态已更新');
 expect(result.results?.[0].summary).not.toMatch(/世界状态没有改变|安全重试|尚未提交|稍后从当前状态重试/);
 expect(result.presentation).toBe('failure');expect(after.resolution_receipts).toHaveLength(1);
 expect(after.runtime.time.minute-before.runtime.time.minute).toBe(1);expect(interpret).toHaveBeenCalledOnce();
 fault.mockRestore();
 await executePlan(f.service,{...body,expected_revision:after.state_revision},validatePlan({goals:[goal]}));
 expect(await f.store.read()).toEqual(after);expect(interpret).toHaveBeenCalledOnce();
});
