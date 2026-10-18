import {describe,it,expect,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {roleplayPolicyFragment} from '../src/narrative/policy.js';
import {shallowUnderstanding} from '../src/system/understanding.js';
import {behaviorSummary,behaviorFragment} from '../src/ai/behavior.js';

describe('System narrative preferences',()=>{
  it('stores adult style and allowed world topics as separate normalized meanings',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const input='语言风格以及叙事要求可以 NSFW，因为角色都是成年人，所以世界里可以出现暴力犯罪、恋爱、成年角色之间的性关系等情节。';
    const answer=await handleSystemInput(f.service,{input}),after=await f.service.current();
    expect(answer.workflow).toBe('behavior_config');
    expect(answer.clarification??null).toBeNull();
    expect(answer.message).toContain('允许出现不代表强制生成');
    expect(answer.message).not.toContain('没有这个模块');
    expect(after.behavior_config.map(rule=>[rule.scope,rule.op,rule.value])).toEqual([
      ['narration','tone','mature'],['dialogue','tone','mature']]);
    expect(after.definition.roleplay_config?.content_allowances).toEqual(['violence','crime','romance','adult_intimacy']);
    expect(after.behavior_config.every(rule=>rule.value!==input)).toBe(true);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
    expect(roleplayPolicyFragment('narrator',after.definition.roleplay_config!)).toContain('允许不是要求出现');
    expect(roleplayPolicyFragment('narrator',after.definition.roleplay_config!)).toContain('人物年龄');
  });

  it('does not turn a demand for guaranteed events into an allowance or event',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const answer=await handleSystemInput(f.service,{input:'请把世界配置成每回合必须出现暴力犯罪情节。'}),after=await f.service.current();
    expect(answer.message).toContain('不能强制');
    expect(after).toEqual(before);
  });

  it('changes only style when no world topic is requested',async()=>{
    const f=await sparseSetup();
    await handleSystemInput(f.service,{input:'请把旁白文风改得更成人向。'});
    const after=await f.service.current();
    expect(after.behavior_config).toMatchObject([{scope:'narration',op:'tone',value:'mature'}]);
    expect(after.definition.roleplay_config?.content_allowances).toEqual([]);
  });

  it('changes only world topic allowance when no style is requested',async()=>{
    const f=await sparseSetup();
    const answer=await handleSystemInput(f.service,{input:'请把世界题材范围设置为允许暴力与犯罪情节。'});
    const after=await f.service.current();
    expect(answer.message).toContain('世界题材允许范围');
    expect(after.behavior_config).toEqual([]);
    expect(after.definition.roleplay_config?.content_allowances).toEqual(['violence','crime']);
  });

  it('applies combined requests once without changing world mechanics',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    expect(shallowUnderstanding('请让旁白更成熟，并允许这个世界涉及政治与创伤题材。',f.service.project(before)).narrative_preference)
      .toMatchObject({tone:'mature',scopes:['narration'],mode:'allow',topics:['politics','trauma']});
    await handleSystemInput(f.service,{input:'请让旁白更成熟，并允许这个世界涉及政治与创伤题材。'});
    const after=await f.service.current();
    expect(after.behavior_config).toMatchObject([{scope:'narration',op:'tone',value:'mature'}]);
    expect(after.definition.roleplay_config?.content_allowances).toEqual(['politics','trauma']);
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.runtime.receipts).toEqual(before.runtime.receipts);
  });

  it('does not treat a question about game content as configuration',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    await handleSystemInput(f.service,{input:'我们来讨论这个世界是否可以出现暴力犯罪吗？'});
    expect(await f.service.current()).toEqual(before);
  });

  it('uses the same structured preference even if model labels it as a module',async()=>{
    const f=await sparseSetup();
    (f.ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      if(data&&typeof data==='object'&&'player_request' in data)return {
        understood:['调整叙事偏好'],requested_change:'允许世界涉及犯罪题材',target_surfaces:[],unresolved:[],entities:[],
        likely_workflow:'module_management',side_effect_class:'configuration',confidence:0.9,correction:null,
        clarification:{needed:false,question:'',examples:[]},response_hint:null,
        narrative_preference:{scopes:[],tone:null,mode:'allow',topics:['crime']},
      } as never;
      return null;
    });
    const answer=await handleSystemInput(f.service,{input:'请允许这个世界涉及犯罪题材。'});
    expect(answer.workflow).toBe('behavior_config');
    expect(answer.message).not.toContain('模块');
    expect((await f.service.current()).definition.roleplay_config?.content_allowances).toEqual(['crime']);
  });

  it('renders a legacy raw style sentence as a normalized tone without rewriting the save',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),raw='只是想让叙述和对话风格更成人向';
    save.behavior_config=[{scope:'narration',op:'constraint',value:raw,raw,application:'per_message',enabled:true,created_at:'2026-10-03T11:19:09Z'}];
    const before=structuredClone(save);
    expect(behaviorSummary(save.behavior_config)).toBe('旁白/叙述 · 成熟克制');
    expect(behaviorFragment(save,'narrator').join(' ')).not.toContain(raw);
    expect(save).toEqual(before);
  });
});
