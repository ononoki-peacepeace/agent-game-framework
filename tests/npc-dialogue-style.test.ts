import {describe,expect,it} from 'vitest';
import {AIRuntime} from '../src/ai/runtime.js';
import {characterContext} from '../src/ai/narrative-health.js';
import {buildNpcAgentContext} from '../src/agent/npc-agent.js';
import {fresh} from './helpers.js';
import {normalizeCharacterCard} from '../src/compat/character-card.js';

describe('live dialogue style boundaries',()=>{
  it('passes the voice and personality without literal sample lines to Narrator, preserving a short refusal',async()=>{
    const save=fresh(),npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    const actor=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    npc.components.location=structuredClone(actor.components.location);
    npc.components.character={role:'研究者',traits:[],personality:'安静独立',speech_style:'直接简短',
      emotional_patterns:['高兴时会主动谈起小事'],verbal_habits:'必须排除的口头禅样本',
      example_dialogues:['必须排除的字面示例台词']};
    npc.components.character_card=JSON.parse(JSON.stringify(normalizeCharacterCard({name:'测试人物',personality:'安静独立',
      mes_example:'旧卡片字面对白不该再次示范',first_mes:'旧卡片开场白不该再次示范'})));
    const before=structuredClone(save),prompts:string[]=[];
    const ai=new AIRuntime({name:'offline-dialogue-fixture',generate:async request=>{
      prompts.push(request.prompt);
      return {data:{narrative:'对方摇了摇头。',speaker:npc.id,dialogue:'今天不想约会。',
        choices:[],context_actions:[],patches:[],interaction:{target_id:npc.id,status:'ended'},
        item_claims:[],stable_locations:[],mechanical_claims:[]}};
    }});
    const result=await ai.narrate(save,{id:'fixture',type:'TALK',actor_id:actor.id,
      target_id:npc.id,parameters:{topic:'想一起出去吗？'}} as never,[]);
    const payload=JSON.parse(prompts[0].split('\n\n').at(-1)!);
    expect(result.dialogue).toBe('今天不想约会。');
    expect(result.interaction?.status).toBe('ended');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('直接简短');
    expect(prompts[0]).toContain('安静独立');
    expect(prompts[0]).not.toContain('必须排除的口头禅样本');
    expect(prompts[0]).not.toContain('必须排除的字面示例台词');
    expect(prompts[0]).not.toContain('旧卡片字面对白不该再次示范');
    expect(prompts[0]).not.toContain('旧卡片开场白不该再次示范');
    expect(characterContext(save,npc.id).characters.find(entry=>entry.id===npc.id)?.allowed_persona.emotional_patterns)
      .toEqual(['高兴时会主动谈起小事']);
    expect(payload.performance_continuity_policy).toContain('静态环境与姿态没有新意义时可以不再描述');
    expect(payload.dialogue_continuity_policy).toContain('不自动增加好感或改变关系');
    expect(save).toEqual(before);
  });
  it('gives the same dialogue continuity boundary to the independent NPC owner without rewriting its decision',async()=>{
    const save=fresh(),npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    const prompts:string[]=[];
    const ai=new AIRuntime({name:'offline-npc-owner',generate:async request=>{
      prompts.push(request.prompt);
      return {data:{kind:'speech',speech:'我想一个人待着。',vote_target:null,
        intent:'结束这次谈话',proposed_action:null,evidence_refs:[],belief_updates:[],
        goal_updates:[],decision_summary:'本人选择不参与'}};
    }});
    const before=structuredClone(save);
    const result=await ai.npcDecision(save.definition.prompt_profile,
      buildNpcAgentContext(save,npc.id,{kind:'direct_scene',description:'想一起聊聊吗？'}));
    const payload=JSON.parse(prompts[0].split('\n\n').at(-1)!);
    expect(result?.speech).toBe('我想一个人待着。');
    expect(payload.dialogue_continuity_policy).toContain('人物可以接受、拒绝、犹豫、沉默或结束交谈');
    expect(payload.context.npc_id).toBe(npc.id);
    expect(payload.context.gm_state).toBeUndefined();
    expect(save).toEqual(before);
  });
});
