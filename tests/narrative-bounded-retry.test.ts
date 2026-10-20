import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';

const proposal={narrative:'模型建议',minutes:2,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

describe('bounded Narrator validation retries',()=>{
  it('budgets a sparse no-discovery observation from available facts instead of padding it',async()=>{
    const {service}=await sparseSetup(),save=await service.current(),prompts:string[]=[];
    for(const entity of save.entities)if(entity.id!==save.player_state.entity_id&&
      entity.components.location?.location_id==='square')entity.components.location.location_id='station';
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      prompts.push(request.prompt);return {data:narration('你看了看眼前的房间，暂时没有新的发现。')};
    }});
    const receipt={semantic_action:'观察房间',kind:'DETERMINISTIC' as const,
      outcome:'success' as const,time_cost:2,effects:['time','activity'],
      canonical_facts:['进行了活动：观察房间（2 分钟）。'],
      activity:{description:'观察房间',duration_minutes:2,location_id:null,occurred:true as const},
      request_id:randomUUID(),action_id:randomUUID(),actor_id:save.player_state.entity_id,target_id:null,
      prerequisites:[],check_id:'',rolls:[],commit_status:'pending' as const};
    await ai.narrate(save,{type:'FREEFORM_ACTION',parameters:{},id:randomUUID(),
      actor_id:save.player_state.entity_id,source:'ai',time_cost:2},[],
      receipt as Parameters<AIRuntime['narrate']>[3]);
    expect(prompts[0]).toContain('资料稀疏且没有新发现的观察');
  });
  it('lets the groundedness audit resolve a metaphorical mechanical verb in observation prose',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(
      narration('你把注意力交给眼前的房间，暂时没有发现新的线索。') as never);
    const audit=vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:true,reason:'只是感官修辞',unsupported_claims:[]} as never);
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'观察房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    const after=await service.current();
    expect(audit.mock.calls[0]?.[2]).toMatchObject({suspected_mechanical_claim:{kind:'inventory'}});
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(after.last_turn?.narrative).toContain('把注意力交给');
    expect(after.state_revision).toBe(before.state_revision+1);
  });
  it('rejects literal uncommitted movement before a model audit can authorize it',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(ai,'narrate').mockResolvedValue(narration('你走到尚未登记的门口。') as never);
    const audit=vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:false,reports_result:false,reason:'额外移动',unsupported_claims:['走到尚未登记的门口']} as never);
    const requestId=randomUUID();
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'观察房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    const after=await service.current();
    expect(audit).not.toHaveBeenCalled();
    expect(after.last_turn?.narrative).not.toContain('走到尚未登记的门口');
    expect(service.logger.entries({event:'narrative.safe_fallback'}).filter(entry=>entry.request_id===requestId)).toHaveLength(1);
  });
  it('does not accept concrete unsupported absence even when the audit boolean is inconsistent',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    vi.spyOn(ai,'narrate').mockResolvedValue(narration('你确认屋里没有任何摆设。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:true,reports_result:false,reason:'',
      unsupported_claims:['屋里没有任何摆设']} as never);
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'观察房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    const after=await service.current();
    expect(after.last_turn?.narrative).not.toContain('没有任何摆设');
    expect(after.state_revision).toBe(before.state_revision+1);
  });
  it('rechecks an observation that invents scene facts without replaying the action',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate')
      .mockResolvedValueOnce(narration('你发现房间里有一把未登记的钥匙。') as never)
      .mockResolvedValueOnce(narration('你查看了当前房间，暂时没有新的发现。') as never);
    const audit=vi.spyOn(ai,'systemAgent')
      .mockResolvedValueOnce({grounded:false,reports_result:false,reason:'新增了未登记的物品'} as never)
      .mockResolvedValueOnce({grounded:true,reports_result:true,reason:'只叙述本次观察'} as never);
    const requestId=randomUUID();
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'观察房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    const after=await service.current();
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.length).toBe((before.resolution_receipts?.length??0)+1);
    expect(after.last_turn?.narrative).not.toContain('钥匙');
  });
  it('uses only canonical room facts when observation prose remains ungrounded',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration('窗边有一条未登记的秘密通道。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:false,reports_result:false,reason:'新增未登记的通道'} as never);
    const requestId=randomUUID();
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'观察房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    const after=await service.current();
    expect(narrate).toHaveBeenCalledTimes(3);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.last_turn?.narrative).not.toContain('秘密通道');
    expect(after.last_turn?.narrative).toContain('你仔细观察');
    expect(service.logger.entries({event:'narrative.safe_fallback'}).filter(entry=>entry.request_id===requestId)).toHaveLength(1);
  });
  it('uses the authoritative perception domain for an open-goal search whose action text has no observation prefix',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    (ai.adapter as {name:string}).name='controlled-model';
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue({...proposal,
      resolution:{...proposal.resolution,domain:'perception',visibility:'hidden'}});
    const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration('你走到未登记的暗门前，发现那里有人。') as never);
    vi.spyOn(ai,'systemAgent').mockResolvedValue({grounded:false,reports_result:false,reason:'没有权威事实支持',
      unsupported_claims:['暗门和人物均未登记']} as never);
    const write=vi.spyOn(store,'write');
    const requestId=randomUUID();
    await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'在当前区域自行巡视并寻找其他参与者的可见线索'},
      undefined,undefined,undefined,false,undefined,undefined,true);
    const after=await service.current();
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(narrate).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.request_id===requestId)).toHaveLength(1);
    expect(after.last_turn?.narrative).not.toMatch(/暗门|那里有人|成功|失败/);
    expect(service.logger.entries({event:'narrative.safe_fallback'}).filter(entry=>entry.request_id===requestId)).toHaveLength(1);
  });
  for(const [label,texts] of [
    ['first attempt',['你简单整理了房间。']],
    ['second attempt',['你把纸屑放进背包。','你简单整理了房间。']],
    ['third attempt',['你把纸屑放进背包。','你走到门口。','你简单整理了房间。']],
  ] as const){
    it(`commits once after a valid ${label}`,async()=>{
      const {service,ai,store}=await sparseSetup(),before=await service.current();
      const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
      const snapshots:string[]=[];
      const narrate=vi.spyOn(ai,'narrate').mockImplementation(async save=>{
        snapshots.push(JSON.stringify({time:save.runtime.time,entities:save.entities,
          event_state:save.event_state,resolution_receipts:save.resolution_receipts}));
        return narration(texts[snapshots.length-1] ?? texts.at(-1)!);
      });
      const write=vi.spyOn(store,'write');
      const requestId=randomUUID();
      await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
        request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
        undefined,undefined,true);
      const after=await service.current();
      expect(narrate).toHaveBeenCalledTimes(texts.length);
      if(texts.length>1)expect(narrate.mock.calls[1]?.[4]).toMatchObject({
        pattern_kind:'inventory',allowed_effects:['time','activity'],snippet:expect.stringContaining('放进')});
      if(texts.length>2)expect(narrate.mock.calls[2]?.[4]).toMatchObject({
        pattern_kind:'position',allowed_effects:['time','activity'],snippet:expect.stringContaining('走到')});
      expect(freeform).toHaveBeenCalledTimes(1);
      expect(new Set(snapshots).size).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(after.state_revision).toBe(before.state_revision+1);
      expect(after.runtime.time.minute).toBe(before.runtime.time.minute+2);
      const events=service.logger.entries().filter(entry=>entry.request_id===requestId);
      expect(events.filter(entry=>entry.event==='background_event.evaluated').length).toBeLessThanOrEqual(1);
      expect(events.filter(entry=>entry.event==='rng.roll').length).toBeLessThanOrEqual(1);
      expect(events.filter(entry=>entry.event==='narrative.attempt').map(entry=>entry.metadata.narrator_attempt))
        .toEqual(texts.map((_,index)=>index+1));
      expect(events.filter(entry=>entry.event==='narrative.regenerated')).toHaveLength(texts.length>1?1:0);
      expect(events.filter(entry=>entry.event==='narrative.retry_exhausted')).toHaveLength(0);
    });
  }

  it('abandons after three Firewall rejections without a canonical write',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockResolvedValue(narration('你把纸屑放进背包。'));
    const write=vi.spyOn(store,'write');
    const requestId=randomUUID();
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow('场景描写超出了已结算的世界事实');
    expect(narrate).toHaveBeenCalledTimes(3);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(await service.current()).toEqual(before);
    const events=service.logger.entries().filter(entry=>entry.request_id===requestId);
    expect(events.filter(entry=>entry.event==='background_event.evaluated').length).toBeLessThanOrEqual(1);
    expect(events.filter(entry=>entry.event==='rng.roll').length).toBeLessThanOrEqual(1);
    expect(events.filter(entry=>entry.event==='narrative.retry_exhausted')).toHaveLength(1);
    expect(events.find(entry=>entry.event==='narrative.retry_exhausted')?.metadata.attempts_used).toBe(3);
  });

  it('does not invoke Narrator when deterministic prerequisites fail',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate');
    const write=vi.spyOn(store,'write');
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:randomUUID(),input:'拿起不存在的物品'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow();
    expect(narrate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await service.current()).toEqual(before);
  });

  it('uses settled facts after a provider failure without calling it a Firewall rejection',async()=>{
    const {service,ai,store}=await sparseSetup(),before=await service.current();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate').mockRejectedValue(
      new ProviderError('schema','invalid structured response','provider schema failure'));
    const write=vi.spyOn(store,'write');
    const requestId=randomUUID();
    const view=await service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
      undefined,undefined,true);
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(before.state_revision+1);
    expect(view.last_turn?.narrative).not.toContain('provider schema failure');
    expect((await service.current()).resolution_receipts?.filter(receipt=>receipt.request_id===requestId&&receipt.commit_status==='committed')).toHaveLength(1);
    expect(service.logger.entries({event:'narrative.mechanical_claim_discarded'}).filter(entry=>entry.request_id===requestId)).toHaveLength(0);
  });

  it('supplies only the previous bounded Firewall diagnosis to the next prompt',async()=>{
    const prompts:string[]=[];
    const {service}=await sparseSetup(),save=await service.current();
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      prompts.push(request.prompt);
      return {data:narration('你安静地整理了一会儿。')};
    }});
    const receipt={semantic_action:'简单整理一下房间',kind:'DETERMINISTIC' as const,
      outcome:'success' as const,time_cost:2,effects:['time','activity'] as Array<'time'|'activity'>,
      canonical_facts:['进行了活动：简单整理一下房间（2 分钟）。'],
      activity:{description:'简单整理一下房间',duration_minutes:2,location_id:null,occurred:true as const},
      request_id:randomUUID(),action_id:randomUUID(),actor_id:save.player_state.entity_id,target_id:null,
      prerequisites:[],check_id:'check_test',rolls:[],commit_status:'pending' as const};
    await ai.narrate(save,{type:'FREEFORM_ACTION',parameters:{},id:randomUUID(),actor_id:save.player_state.entity_id,
      source:'ai',time_cost:2},[],receipt as Parameters<AIRuntime['narrate']>[3],{
      reason:'场景描写超出了已结算的世界事实',pattern_kind:'inventory',match_index:18,
      snippet:'把纸屑放进背包',allowed_effects:['time','activity']});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('inventory');
    expect(prompts[0]).toContain('把纸屑放进背包');
    expect(prompts[0]).toContain('allowed_effects');
    expect(prompts[0]).not.toContain('完整旧 response');
  });
});
