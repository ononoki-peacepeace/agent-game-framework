import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {sparseSetup} from './sparse-fixture.js';
import {ProviderError} from '../src/ai/failures.js';
import {normalizeProviderCollections} from '../src/ai/provider-schema.js';
import {narrativeResultSchema} from '../src/ai/contracts.js';
import {TurnProgress} from '../src/client/TurnProgress.js';

describe('failed narration keeps the last authoritative result',()=>{
  it('feeds the rejected Narrator field error and output into one bounded repair without replaying MOVE',async()=>{
    let narratorCalls=0;
    const {service,store,calls}=await sparseSetup(async request=>{
      if(request.role==='routine_compiler')return {data:(await import('./sparse-fixture.js')).sparsePlan};
      if(request.role!=='narrator')throw Error('unexpected provider role');
      narratorCalls++;
      return {data:narratorCalls===1?{...{
        narrative:'你走向河岸车站。',speaker:null,dialogue:null,choices:[],context_actions:[],
        patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
      },scene_beats:'invalid beats'}:{
        narrative:'你抵达河岸车站。',speaker:null,dialogue:null,choices:[],context_actions:[],
        patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[],
      }};
    });
    const before=await service.current(),write=vi.spyOn(store,'write'),requestId=randomUUID();
    const view=await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,action:{type:'MOVE',target_id:'station',parameters:{}}});
    const narratorRequests=calls.filter(call=>call.role==='narrator');
    expect(narratorRequests).toHaveLength(2);
    expect(narratorRequests[0]?.prompt).not.toContain('schema_feedback');
    expect(narratorRequests[1]?.prompt).toContain('schema_feedback');
    expect(narratorRequests[1]?.prompt).toContain('scene_beats');
    expect(narratorRequests[1]?.prompt).toContain('invalid beats');
    expect(narratorRequests[1]?.prompt).toContain('不可信数据');
    expect(write).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(before.state_revision+1);
    expect(view.last_turn?.narrative).toContain('河岸车站');
    expect((await service.current()).resolution_receipts?.filter(receipt=>receipt.request_id===requestId&&receipt.commit_status==='committed')).toHaveLength(1);
  });
  it('accepts a provider null for an absent optional scene sequence',()=>{
    const candidate={narrative:'你仍在原处。',speaker:null,dialogue:null,scene_beats:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
    expect(narrativeResultSchema.parse(normalizeProviderCollections('narrator',candidate)).scene_beats).toEqual([]);
  });
  it('retries invalid narration once, then commits one grounded MOVE without replay',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    const narrator=vi.spyOn(ai,'narrate').mockRejectedValue(new ProviderError('schema','scene_beats invalid','invalid narrator'));
    const write=vi.spyOn(store,'write');
    const requestId=randomUUID();
    const view=await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,action:{type:'MOVE',target_id:'station',parameters:{}}});
    expect(narrator).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(before.state_revision+1);
    expect(view.last_turn?.narrative).toContain('河岸车站');
    expect(view.last_turn?.narrative).not.toContain('station');
    const after=await service.current();
    expect(after.resolution_receipts?.filter(item=>item.request_id===requestId&&item.commit_status==='committed')).toHaveLength(1);
    expect(service.logger.entries({event:'narrative.safe_fallback'}).some(item=>item.request_id===requestId)).toBe(true);
  });
  it('leaves the last successful turn intact when a later unreceipted action fails',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    const narrator=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'你抵达河岸车站。',
      speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,
      item_claims:[],stable_locations:[],mechanical_claims:[]} as never);
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),action:{type:'MOVE',target_id:'station',parameters:{}}});
    const successful=await service.current(),writes=vi.spyOn(store,'write');
    narrator.mockRejectedValue(new Error('narrator unavailable'));
    await expect(service.turn({game_id:successful.game_id,expected_revision:successful.state_revision,
      request_id:randomUUID(),action:{type:'WAIT',parameters:{minutes:5}}})).rejects.toThrow('尚未结算');
    const after=await service.current();
    expect(after.state_revision).toBe(successful.state_revision);
    expect(after.runtime.time).toEqual(successful.runtime.time);
    expect(after.last_turn).toEqual(successful.last_turn);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('non-spoiler progress',()=>{
  it('shows a bounded estimate, but never claims completion, while a model stage is still running',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',state:'running',
      phase:'narrating',history:['interpreting','narrating'],committedRevision:null}}));
    expect(html).toContain('正在处理');
    expect(html).toContain('展开详情');
    // The player now sees an estimate; it must be visible, non-zero and strictly below completion.
    const shown=Number(/aria-valuenow="(\d+)"/.exec(html)?.[1]);
    expect(Number.isFinite(shown)).toBe(true);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(html).toContain('估算进度');
    expect(html).toContain(`style="width:${shown}%"`);
    expect(html).not.toContain('NPC 内心');
  });
  it('shows 100 once the request finished processing, while still labelling partial success',()=>{
    const base={requestId:'r',gameId:'g',path:'input' as const,phase:'finalizing' as const,history:['interpreting','finalizing'],committedRevision:4};
    expect(renderToStaticMarkup(createElement(TurnProgress,{value:{...base,state:'completed'}}))).toContain('aria-valuenow="100"');
    const partial=renderToStaticMarkup(createElement(TurnProgress,{value:{...base,state:'partial'}}));
    expect(partial).toContain('部分完成');
    // A partial result also finished processing, so the bar reaches 100 without claiming full success.
    expect(partial).toContain('aria-valuenow="100"');
    expect(partial).not.toContain('已完成');
  });
  it('keeps direct actions below completion until their response arrives',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'a',gameId:'g',path:'action',
      state:'running',phase:'submitted',history:['submitted'],committedRevision:null}}));
    expect(html).toContain('请求已发送');
    expect(html).not.toContain('aria-valuenow="100"');
  });
});
