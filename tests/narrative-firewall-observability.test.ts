import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {NarrativePatternError,validateResolvedNarrative} from '../src/core/narrative-firewall.js';

const proposal={narrative:'模型建议',minutes:2,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'普通活动',stages:[],evidence_ids:[]}};
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

describe('Narrative Firewall pattern diagnostics',()=>{
  it('retains the rejection and reports a bounded match without retaining the whole narration',async()=>{
    const {service}=await sparseSetup(),save=await service.current();
    const receipt=executeFreeform(save,'简单整理一下房间',proposal,randomUUID()).save.resolution_receipts!.at(-1)!;
    const prose=`${'平静的环境描写。'.repeat(35)}你把小物件放进背包。${'随后继续观察环境。'.repeat(35)}`;
    let error:unknown;
    try{validateResolvedNarrative(receipt,narration(prose),false);}catch(caught){error=caught;}
    expect(error).toBeInstanceOf(NarrativePatternError);
    const pattern=error as NarrativePatternError;
    expect(pattern.message).toBe('场景描写超出了已结算的世界事实，本回合尚未提交，可以安全重试。');
    expect(pattern.patternKind).toBe('inventory');
    expect(pattern.matchIndex).toBeGreaterThan(0);
    expect(pattern.snippet).toContain('放进');
    expect(pattern.snippet.length).toBeLessThanOrEqual(100);
    expect(pattern.snippet).not.toBe(prose);
    expect(pattern.snippet).not.toContain('\n');
    expect(()=>validateResolvedNarrative(receipt,narration('你在原地简单整理了一会儿。'),false)).not.toThrow();
    expect(()=>validateResolvedNarrative(receipt,narration('你完成了作业第2页。'),false)).toThrow();
  });

  it('logs all rejected attempts with effects and the same trace while leaving the turn uncommitted',async()=>{
    const {service,ai}=await sparseSetup(),before=await service.current();
    vi.spyOn(ai,'freeform').mockResolvedValue(proposal);
    const narrate=vi.spyOn(ai,'narrate')
      .mockResolvedValueOnce(narration('你把纸屑放进背包。'))
      .mockResolvedValueOnce(narration('你走到门口。'))
      .mockResolvedValueOnce(narration('你完成了作业第2页。'));
    const requestId=randomUUID();
    await expect(service.turn({game_id:before.game_id,expected_revision:before.state_revision,
      request_id:requestId,input:'简单整理一下房间'},undefined,undefined,undefined,false,
      undefined,undefined,true)).rejects.toThrow('场景描写超出了已结算的世界事实');
    expect(narrate).toHaveBeenCalledTimes(3);
    const logs=service.logger.entries({event:'narrative.mechanical_claim_discarded'})
      .filter(entry=>entry.request_id===requestId);
    expect(logs).toHaveLength(3);
    expect(logs.map(entry=>entry.metadata.retry)).toEqual([false,true,true]);
    expect(logs.map(entry=>entry.metadata.pattern_kind)).toEqual(['inventory','position','progress']);
    expect(logs.map(entry=>entry.metadata.allowed_effects)).toEqual([
      ['time','activity'],['time','activity'],['time','activity']]);
    expect(logs.every(entry=>typeof entry.trace_id==='string'&&entry.trace_id===logs[0].trace_id)).toBe(true);
    expect(logs.every(entry=>typeof entry.metadata.match_index==='number'&&
      typeof entry.metadata.snippet==='string'&&(entry.metadata.snippet as string).length<=100)).toBe(true);
    const after=await service.current();
    expect(after.state_revision).toBe(before.state_revision);
    expect(after.runtime.time).toEqual(before.runtime.time);
  });
});
