import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {executeAction} from '../src/core/runtime.js';
import {newSave} from '../src/core/state.js';
import {demo} from './helpers.js';
import {WorldBlockedError,gameOutcome,engineOutcome} from '../src/agent/outcome.js';

const openLane=(destination:string|null,continuation:'none'|'natural_interaction_if_available'='none')=>({
  kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination,continuation},
}) as never;
const call=async(f:Awaited<ReturnType<typeof sparseSetup>>,input:string,lane:never)=>{
  const before=await f.service.current();
  const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
    expected_revision:before.state_revision,input},undefined,null,false,lane);
  return {before,result,after:await f.service.current()};
};

describe('game outcomes remain distinct from engine failures',()=>{
  it('carries a discriminated outcome and never chooses severity from narrative prose',()=>{
    expect(gameOutcome('completed_no_result','search').type).toBe('game');
    expect(engineOutcome('provider_failure','planner').type).toBe('engine_failure');
  });

  it('treats a closed destination as a canonical world block without changing time',()=>{
    const save=newSave(demo),station=save.definition.map!.locations.find(location=>location.id==='station')!;
    station.lifecycle={origin:'authored',status:'closed',visibility:'public',source_ref:'test'} as never;
    const before=structuredClone(save.runtime.time);
    expect(()=>executeAction(save,{type:'MOVE',target_id:'station'},randomUUID(),'player',()=>0.5))
      .toThrow(WorldBlockedError);
    expect(save.runtime.time).toEqual(before);
  });

  it('keeps a committed MOVE when the refreshed destination has nobody to meet',async()=>{
    let calls=0;
    const f=await sparseSetup(async request=>{
      const schema=request.schema as {properties?:Record<string,unknown>};
      if(schema.properties?.decision){calls++;return {data:{decision:calls===1?'transaction':'done',
        transaction:calls===1?{kind:'move',destination:'河岸车站',minutes:null,reason:'前往'}:null,
        reason:null,question:null}};}
      if(request.role==='narrator')return {data:{narrative:'你走到河岸车站。',speaker:null,dialogue:null,
        choices:[],patches:[]}};
      throw Error('unexpected call');
    });
    const save=await f.service.current();for(const entity of save.entities)
      if(entity.id!==save.player_state.entity_id&&entity.components.character)entity.components.location={location_id:'square'};
    await f.store.write(save);
    const {before,result,after}=await call(f,'去河岸车站，找到人就交谈',openLane('河岸车站','natural_interaction_if_available'));
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress',goal_status:'unresolved'});
    expect(result.presentation).toBe('story');
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.resolution_receipts?.some(receipt=>receipt.semantic_action==='TALK')).toBe(false);
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(result.message).toContain('没有可以交谈的人');
    expect(result.message).not.toMatch(/runtime_gap|capability|schema|transaction/);
  });

  it('commits a destination search and skips an absent conditional pickup',async()=>{
    const f=await sparseSetup(async request=>{
      if((request.schema as {properties?:Record<string,unknown>}).properties?.decision)
        return {data:{decision:'done',transaction:null,reason:null,question:null}};
      throw Error('unexpected call');
    });
    vi.spyOn(f.ai,'freeform').mockResolvedValue({narrative:'你查找了一阵，没有找到目标。',minutes:3,
      target_id:null,facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,
      required_conditions:[],blocker:null,resolution:{type:'DETERMINISTIC',domain:'perception',band:'normal',
        visibility:'public',stakes:'寻找目标',stages:[],evidence_ids:[]}} as never);
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你在车站找了一阵，没有找到目标。',speaker:null,
      dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],
      mechanical_claims:[]} as never);
    const before=await f.service.current();
    const {result,after}=await call(f,'去河岸车站找一枚紫铜徽章，找到才拿起。',
      {kind:'world_action',interaction_lane:'open_goal',open_goal_context:{destination:'河岸车站',
        continuation:'none',search_query:'紫铜徽章',travel_after_discovery:false}} as never);
    expect(after.resolution_receipts?.map(receipt=>receipt.semantic_action)).toEqual(['MOVE','寻找紫铜徽章']);
    expect(after.runtime.time.minute).toBeGreaterThan(before.runtime.time.minute);
    expect(result.outcome).toMatchObject({type:'game',kind:'partial_progress'});
    expect(result.presentation).toBe('story');
    expect(after.entities.find(entity=>entity.id==='player')?.components.inventory).toEqual(
      before.entities.find(entity=>entity.id==='player')?.components.inventory);
    expect(result.message).not.toMatch(/schema|capability|runtime_gap/);
  });

  it('classifies a planning provider failure as engine failure without inventing a search result',async()=>{
    const f=await sparseSetup(async request=>{
      if((request.schema as {properties?:Record<string,unknown>}).properties?.decision)throw Error('provider unavailable');
      throw Error('unexpected call');
    });
    const {before,result,after}=await call(f,'在附近找找能见到的人',openLane(null));
    expect(result.outcome).toMatchObject({type:'engine_failure',code:'provider_failure'});
    expect(result.presentation).toBe('failure');
    expect(result.message).not.toContain('provider unavailable');
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });
  it('reports earlier committed steps when a later open-goal transaction cannot finish narration',async()=>{
    let steps=0;
    const f=await sparseSetup(async request=>{
      if((request.schema as {properties?:Record<string,unknown>}).properties?.decision){
        steps++;
        return {data:{decision:'transaction',transaction:steps===1?
          {kind:'move',destination:'河岸车站',minutes:null,reason:'前往'}:
          {kind:'wait',destination:null,minutes:5,reason:'查看后续变化'},reason:null,question:null}};
      }
      throw Error('unexpected call');
    });
    const narration=vi.spyOn(f.ai,'narrate').mockImplementation(async(_save,action)=>{
      if(action.type==='WAIT')throw Error('narrator unavailable');
      return {narrative:'你来到河岸车站。',speaker:null,dialogue:null,choices:[],context_actions:[],
        patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]} as never;
    });
    const {before,result,after}=await call(f,'先去车站，再等待看看后续情况',openLane(null));
    expect(narration).toHaveBeenCalledTimes(2);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='MOVE')).toHaveLength(1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.semantic_action==='WAIT')).toHaveLength(0);
    expect(result.outcome).toMatchObject({type:'engine_failure',committed_steps:[expect.any(String)],
      receipt_ids:[expect.any(String)]});
    expect(result.message).toContain('前面已经结算');
    expect(result.message).not.toContain('这一回合没有完成安全结算');
  });
});
