import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fresh} from './helpers.js';
import {executeFreeform} from '../src/core/freeform.js';
import {enumeratedInspectionItems} from '../src/core/completion-evidence.js';

const input='检查鞋底、身体疲劳眩晕、湿滑地面';
const perception=(facts:string[]=[],inspection_results?:{item:string;result:'found'|'nothing'|'blocked'|'not_checked';detail:string}[])=>({narrative:'你环顾四周。',minutes:2,target_id:null,facts,inspection_results,relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,visibility:'public' as const,
    stakes:'逐项检查自身与环境',stages:[],evidence_ids:[]}});

describe('P0-C enumerated self-inspection completion',()=>{
  it('splits the named items from a single inspection sentence',()=>{
    expect(enumeratedInspectionItems(input)).toEqual(['鞋底','身体疲劳眩晕','湿滑地面']);
    expect(enumeratedInspectionItems('观察房间').length).toBeLessThan(2);
    expect(enumeratedInspectionItems('检查自己的鞋底、伤势、疲劳和地面'))
      .toEqual(['鞋底','伤势','疲劳','地面']);
    expect(enumeratedInspectionItems('查看当前环境和有哪些人在活动'))
      .toEqual(['当前环境和有哪些人在活动']);
  });

  it('does not claim an occurred activity when the listed items are not covered',()=>{
    const save=fresh(),turn=executeFreeform(save,input,perception([]),randomUUID());
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('activity');
    expect(turn.facts.join('，')).toContain('本次观察没有逐项确认');
    expect(turn.facts.join('，')).toContain('鞋底');
  });

  it('records an occurred activity only when every listed item has a finding',()=>{
    const save=fresh(),turn=executeFreeform(save,input,perception(['鞋底沾有泥土','身体感到疲惫','地面有水迹']),randomUUID());
    expect(turn.save.resolution_receipts?.at(-1)?.effects).toContain('activity');
    expect(turn.facts.join('，')).not.toContain('没有逐项确认');
  });

  it('keeps the settled observation in an isolated save and never mutates the input',()=>{
    const save=fresh(),before=JSON.stringify(save);
    const turn=executeFreeform(save,input,perception([]),randomUUID());
    expect(JSON.stringify(save)).toBe(before);
    expect(turn.save.state_revision).toBe(save.state_revision);
  });

  it('records nothing as completed and blocked items as partial',()=>{
    const save=fresh(),requestId=randomUUID();
    const turn=executeFreeform(save,input,perception([], [
      {item:'鞋底',result:'nothing',detail:'没有泥土'},
      {item:'身体疲劳眩晕',result:'found',detail:'感到疲惫'},
      {item:'湿滑地面',result:'blocked',detail:'光线不足'}]),requestId);
    const receipt=turn.save.resolution_receipts?.find(entry=>entry.request_id===requestId);
    expect(receipt?.inspection_status).toBe('partial');
    expect(receipt?.inspection_results).toEqual(expect.arrayContaining([
      expect.objectContaining({item:'鞋底',result:'nothing'}),
      expect.objectContaining({item:'湿滑地面',result:'blocked'})]));
    expect(receipt?.effects).not.toContain('activity');
  });
});
