import {describe,expect,it,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';

const understanding=(scopes:('narration'|'dialogue'|'assistant')[],tone:'mature'|null,mode:'allow'|null=null,topics:('adult_intimacy')[]=[])=>({
  understood:['调整当前世界的表达或题材范围'],requested_change:'调整表达或题材范围',target_surfaces:[],unresolved:[],entities:[],
  likely_workflow:'behavior_config',style_target:'world',side_effect_class:'configuration',confidence:.95,
  configuration_kind:mode==='allow'&&!tone?'topic':'style',
  correction:null,clarification:{needed:false,question:'',examples:[]},response_hint:null,
  narrative_preference:{scopes,tone,mode,topics},
});

describe('System style target scope',()=>{
  it.each([
    ['把当前世界整体的叙事和对白风格设得更成熟一些。',['narration','dialogue']],
    ['所有人物的对白可以更成人化一点，但还是按各自性格说话。',['dialogue']],
  ] as const)('stores world style for %s without requesting a character',async(input,scopes)=>{
    const f=await sparseSetup(),before=await f.service.current();
    (f.ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      if(data&&typeof data==='object'&&'existing' in data)return {decision:'discussion',category:null,title:'',
        trigger_semantics:'',preferred_behavior:'',anti_pattern:'',scope:null,reason:'style setting',invariant_conflict:false} as never;
      if(data&&typeof data==='object'&&'player_request' in data)return understanding([...scopes],'mature') as never;
      return null;
    });
    const answer=await handleSystemInput(f.service,{input}),after=await f.service.current();
    expect(answer.category).toBe('BEHAVIOR_CONFIGURATION');
    expect(answer.message).not.toContain('人物名字');
    expect(after.behavior_config.map(rule=>[rule.scope,rule.op,rule.value])).toEqual(scopes.map(scope=>[scope,'tone','mature']));
    expect(after.entities).toEqual(before.entities);
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(after.resolution_receipts).toEqual(before.resolution_receipts);
  });

  it('keeps an explicitly named character style on the persona path',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    npc.components.identity!.name='田边和也';await f.store.write(save);
    (f.ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(f.ai,'systemAgent').mockResolvedValue({
      ...understanding([],null),style_target:'character',configuration_kind:'character_persona',entities:['田边和也'],narrative_preference:null,
    } as never);
    const answer=await handleSystemInput(f.service,{input:'把田边和也的说话风格改得更冷淡。'});
    const after=await f.service.current();
    expect(answer.category).toBe('CHARACTER_PERSONA');
    expect(after.entities.find(entity=>entity.id===npc.id)?.components.character?.speech_style).toContain('冷淡');
    expect(after.behavior_config).toEqual(save.behavior_config);
  });

  it('treats an unspecified adult topic allowance as a topic clarification, not a persona change',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    (f.ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      if(data&&typeof data==='object'&&'existing' in data)return {decision:'discussion',category:null,title:'',
        trigger_semantics:'',preferred_behavior:'',anti_pattern:'',scope:null,reason:'topic setting',invariant_conflict:false} as never;
      if(data&&typeof data==='object'&&'player_request' in data)return understanding([],null,'allow') as never;
      return null;
    });
    const answer=await handleSystemInput(f.service,{input:'允许当前世界出现成人题材。'});
    expect(answer.category).toBe('BEHAVIOR_CONFIGURATION');
    expect(answer.clarification).toBe('content_topics');
    expect(answer.message).not.toContain('人物名字');
    expect(await f.service.current()).toEqual(before);
  });

  it('saves explicit future NPC response guidance as a patch, not a character style',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    (f.ai.adapter as {name:string}).name='controlled-model';
    vi.spyOn(f.ai,'systemAgent').mockImplementation(async(_schema,_profile,data)=>{
      if(data&&typeof data==='object'&&'existing' in data)return {decision:'create',category:'narration',title:'NPC 对话收尾',
        trigger_semantics:'NPC replies',preferred_behavior:'End replies according to character and scene.',
        anti_pattern:'Do not end every reply with a question.',scope:'world',reason:'future guidance',invariant_conflict:false} as never;
      if(data&&typeof data==='object'&&'player_request' in data)return {
        ...understanding(['dialogue'],'mature'),configuration_kind:'behavior_patch',
      } as never;
      return null;
    });
    const answer=await handleSystemInput(f.service,{input:'以后 NPC 不要每次最后都反问我。'}),after=await f.service.current();
    expect(answer.category).toBe('AI_BEHAVIOR_FEEDBACK');
    expect((await f.service.behaviorGuidance()).at(-1)).toMatchObject({scope:'world',category:'narration'});
    expect(after.behavior_config).toEqual(before.behavior_config);
    expect(after.entities).toEqual(before.entities);
  });
});
