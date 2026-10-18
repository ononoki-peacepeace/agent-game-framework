import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {AIRuntime} from '../src/ai/runtime.js';
import {readProfile} from '../src/ai/profiles.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {worldCandidateIssues} from '../src/ai/world-initializer-repair.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';

const profile=await readProfile('content/profiles/default.json');
const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
function candidate(month:number,date:number,weekday:number,minute:number){
  const value=structuredClone(base);
  value.opening_time={minute,calendar:{...value.opening_time.calendar,anchor_month:month,anchor_date:date,anchor_weekday:weekday,source:'世界设定中的开局日历'}};
  value.opening=`${month}月${date}日周${['一','二','三','四','五','六','日'][weekday-1]}，${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}，你来到中央广场。`;
  return value;
}
function ai(value:unknown){return new AIRuntime({name:'controlled',generate:async()=>({data:structuredClone(value)})});}

describe('new world canonical opening clock',()=>{
  it('honors an explicit opening date and clock through save, reload and UI',async()=>{
    const value=candidate(10,11,7,20*60+30);
    const save=await ai(value).initialize('港湾小镇。开局为10月11日周日20:30。',profile);
    const restored=validateSave(JSON.parse(JSON.stringify(save)));
    expect(restored.runtime.time).toEqual({day:1,minute:1230});
    expect(restored.calendar?.anchor_month).toBe(10);
    expect(restored.last_turn?.narrative).toContain('10月11日周日');
    expect(publicView(restored).time_label).toBe('10月11日 周日 20:30');
  });
  it('accepts different model-selected starts when the player did not prescribe one',async()=>{
    const a=await ai(candidate(4,16,3,8*60+20)).initialize('春季的港湾生活',profile);
    const b=await ai(candidate(9,23,6,17*60+10)).initialize('秋季的港湾生活',profile);
    expect(publicView(a).time_label).toBe('4月16日 周三 08:20');
    expect(publicView(b).time_label).toBe('9月23日 周六 17:10');
    expect(a.runtime.time).not.toEqual(b.runtime.time);
  });
  it('rejects a contradictory opening and a mismatch with explicit player time',()=>{
    const value=candidate(10,11,7,1230);
    value.opening='10月11日周一，上午九点，你来到中央广场。';
    expect(worldCandidateIssues(value).map(issue=>issue.code)).toEqual(expect.arrayContaining(['canonical_weekday_mismatch','canonical_time_mismatch']));
    value.opening=candidate(10,11,7,1230).opening;
    expect(worldCandidateIssues(value,'开局为10月11日20:00。').map(issue=>issue.code)).toContain('explicit_opening_time_mismatch');
    expect(worldCandidateIssues(value,'开局设为10月11日周六晚上八点半。').map(issue=>issue.code)).toContain('explicit_opening_weekday_mismatch');
    expect(worldCandidateIssues(value,'开局设为10月11日周日晚上八点半。')).toEqual([]);
    expect(worldCandidateIssues(value,'开局设为十月十一日周日晚上八点半。')).toEqual([]);
  });
  it('preserves the legacy default for older blueprints without changing existing saves',()=>{
    const old=structuredClone(base);delete old.opening_time;
    const save=newSave(compileWorld(worldInitializationSchema.parse(old),profile));
    expect(publicView(validateSave(JSON.parse(JSON.stringify(save)))).time_label).toBe('1月1日 周一 09:00');
    expect(worldCandidateIssues(old,'',true).map(issue=>issue.code)).toContain('opening_time_missing');
  });
});
