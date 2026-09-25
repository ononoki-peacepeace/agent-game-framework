import {it,expect} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemAction,handleSystemInput} from '../src/system/agent.js';
import {startFeatureGuide,advanceFeatureGuide,featureRequirement,featureGuideMessage} from '../src/system/feature-guide.js';

const guideOf=(result:{guide?:unknown})=>result.guide as {proposal_id:string;revision:number;status:string;subject:string;options:{label:string;action?:{type:'FEATURE_GUIDE_OPTION'|'CONFIRM_FEATURE_PROPOSAL'|'CANCEL_FEATURE_PROPOSAL';proposal_id:string;proposal_revision:number;option_id:string}}[];draft:string[];understood:string[]}|null|undefined;

it('a vague development wish asks exactly one experience question and offers a delegate option',async()=>{
  const f=await sparseSetup();
  const before=await f.service.current();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const guide=guideOf(first as never)!;
  expect(guide.status).toBe('asking');
  expect(guide.options.map(option=>option.label).join(' ')).toContain('我不知道，你帮我选');
  expect(String(first.message)).toContain('你希望');
  for(const leak of ['hook','schema','migration','capability','rollback','component']) expect(String(first.message)).not.toContain(leak);
  // The guide stage itself never touches the canonical world.
  expect(await f.service.current()).toEqual(before);
});

it('“我不知道，你帮我选” produces a small reversible MVP and asks to start',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const second=await handleSystemInput(f.service,{input:'我不知道，你帮我选',session_id:first.session!.session_id});
  const guide=guideOf(second as never)!;
  expect(guide.status).toBe('proposing');
  expect(guide.draft.length).toBeGreaterThanOrEqual(3);
  expect(guide.options.map(option=>option.label)).toContain('开始制作');
  expect(await f.service.current()).toEqual(await f.service.current());
});

it('confirmation hands the minimal plan to a real development request',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const second=await handleSystemInput(f.service,{input:'我不知道，你帮我选',session_id:first.session!.session_id});
  const third=await handleSystemInput(f.service,{input:'开始制作',session_id:second.session!.session_id});
  expect(third.directive).toMatchObject({kind:'extension_development'});
  const request=String(third.directive!.request);
  expect(request).toContain('第一版就做这些');
  expect(request).toContain('只做最小可用版本');
  expect(guideOf(third as never)?.status).toBe('confirmed');
  expect(third.session?.status).toBe('completed');
});

it('a bound proposal action bypasses general NLU and stale replay cannot confirm anything',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const second=await handleSystemInput(f.service,{input:'我不知道，你帮我选',session_id:first.session!.session_id});
  const guide=guideOf(second as never)!,option=guide.options.find(entry=>entry.action?.type==='CONFIRM_FEATURE_PROPOSAL')!;
  const callsBefore=f.calls.length;
  const action={...option.action!,session_id:second.session!.session_id};
  const confirmed=await handleSystemAction(f.service,action);
  expect(f.calls).toHaveLength(callsBefore);
  expect(confirmed.directive).toMatchObject({kind:'extension_development'});
  expect(String(confirmed.directive?.request)).toContain('第一版就做这些');
  expect(String(confirmed.message)).not.toContain('制作什么');
  const stale=await handleSystemAction(f.service,action);
  expect(stale.category).toBe('STALE_ACTION');
  expect(stale.directive).toBeUndefined();
  expect(stale.message).toContain('方案已经变化');
  expect(f.calls).toHaveLength(callsBefore);
});

it('a concrete request that reuses existing data skips the guide entirely',async()=>{
  const f=await sparseSetup();
  const r=await handleSystemInput(f.service,{input:'人物页显示好感度'});
  expect(guideOf(r as never)).toBeUndefined();
  expect(r.directive).toMatchObject({kind:'extension_development'});
  expect(String(r.directive!.request)).toContain('character_page');
});

it('an idea-less request is offered a few distinguishable directions',async()=>{
  const f=await sparseSetup();
  const r=await handleSystemInput(f.service,{input:'我想加一个很牛逼的系统，但我不知道是什么'});
  const guide=guideOf(r as never)!;
  expect(guide.status).toBe('asking');
  expect(guide.options.length).toBeGreaterThanOrEqual(3);
  expect(new Set(guide.options.map(option=>option.label)).size).toBe(guide.options.length);
  expect(String(r.message)).not.toContain('UNKNOWN');
});

it('correction and cancellation stay inside the guide and never replay an old plan',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const corrected=await handleSystemInput(f.service,{input:'其实我更希望它影响成长上限',session_id:first.session!.session_id});
  expect(guideOf(corrected as never)?.status).toBe('proposing');
  const cancelled=await handleSystemInput(f.service,{input:'算了，不做了',session_id:corrected.session!.session_id});
  expect(cancelled.session?.status).toBe('cancelled');
  expect(cancelled.session?.guide ?? null).toBeNull();

  const next=await handleSystemInput(f.service,{input:'人物页显示好感度'});
  expect(guideOf(next as never)).toBeUndefined();
  expect(next.directive).toMatchObject({kind:'extension_development'});
});

it('a new development request starts a new guide instead of continuing the old one',async()=>{
  const f=await sparseSetup();
  const first=await handleSystemInput(f.service,{input:'我想加个潜力系统'});
  const other=await handleSystemInput(f.service,{input:'我想加个赌博玩法',session_id:first.session!.session_id});
  expect(other.session?.session_id).not.toBe(first.session?.session_id);
  expect(guideOf(other as never)?.subject).toContain('赌博');
});

it('guide helpers stay player-level and bounded',()=>{
  const guide=startFeatureGuide('我想加个潜力系统');
  expect(guide.subject).toBe('潜力');
  const proposed=advanceFeatureGuide(guide,'我不知道，你帮我选');
  expect(featureGuideMessage(proposed)).toContain('剩下交给我');
  expect(featureRequirement(proposed)).toContain('只做最小可用版本');
  // The requirement goes to the development workspace; the *player* copy must stay free of engineering words.
  for(const leak of ['hook','schema','migration','capability','canonical','component']) expect(featureGuideMessage(proposed)).not.toContain(leak);

});
