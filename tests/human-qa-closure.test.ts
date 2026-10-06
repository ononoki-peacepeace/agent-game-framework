import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sparseSetup} from './sparse-fixture.js';
import {narrativeResultSchema} from '../src/ai/contracts.js';
import {freeformSchema,executeFreeform} from '../src/core/freeform.js';
import {classifyGameIntent} from '../src/agent/game.js';
import {fastPlan} from '../src/agent/planner.js';
import {routeContext} from '../src/system/context-router.js';
import {publicView} from '../src/core/state.js';
import {characterContext} from '../src/ai/narrative-health.js';
import {handleSystemInput} from '../src/system/agent.js';
import {CharacterDetail} from '../src/client/panels.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {normalizeProviderCollections} from '../src/ai/provider-schema.js';
import {GameService} from '../src/server/service.js';

const proposal=(domain='investigation')=>({narrative:'观察当前场景',minutes:1,target_id:null,facts:[],relationship:null,
  resolution:{type:'SIMPLE_CHECK' as const,domain,band:'normal' as const,visibility:'public' as const,stakes:'观察当前场景',stages:[],evidence_ids:[],discover_facts:true}});
const narrator={narrative:'她从容地答复你的问题。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]};

describe('human QA closure',()=>{
  it('normalizes semantic empty narrator arrays at the contract boundary without changing meaningful null',()=>{
    for(const value of [null,undefined,[]]){
      const parsed=narrativeResultSchema.parse(normalizeProviderCollections('narrator',{...narrator,mechanical_claims:value,item_claims:value,stable_locations:value,
        choices:value,context_actions:value,patches:value,choice_semantics:value}));
      for(const key of ['mechanical_claims','item_claims','stable_locations','choices','context_actions','patches','choice_semantics'] as const)expect(parsed[key]).toEqual([]);
      expect(parsed.interaction).toBeNull();
    }
    const omitted=narrativeResultSchema.parse(normalizeProviderCollections('narrator',{narrative:'安全场景',speaker:null,dialogue:null,interaction:null}));
    expect(omitted.mechanical_claims).toEqual([]);expect(omitted.choices).toEqual([]);expect(omitted.patches).toEqual([]);
    expect(freeformSchema.parse({...proposal(),narrative:'观察',target_id:null,minutes:1,relationship:null,
      facts:null,required_conditions:null,resolution:{...proposal().resolution,stages:null,evidence_ids:null}}).facts).toEqual([]);
  });
  it('routes active perception to WORLD_ACTION but registered-state questions to QUERY',async()=>{
    const f=await sparseSetup(),view=publicView(await f.service.current());
    for(const input of ['看教室异常','看看这里有没有异常','观察一下周围','检查桌子下面','搜一下房间']){
      expect(classifyGameIntent(input)).toBe('WORLD_ACTION');expect(fastPlan(view,input)?.goals[0].type).toBe('WORLD_ACTION');
    }
    expect(classifyGameIntent('现在教室里有没有已公开登记的NPC？')).toBe('WORLD_QUERY');
    expect(fastPlan(view,'现在教室里有没有已公开登记的NPC？')?.goals[0].type).toBe('WORLD_QUERY');
    expect((await routeContext(f.service,'看教室异常','world_input')).destination).toBe('WORLD_INTENT');
  });
  it('settles no-find as a valid in-world result and only discovers pre-existing local evidence',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),actor=save.player_state.entity_id;
    const here=String(save.entities.find(e=>e.id===actor)?.components.location?.location_id);
    const empty=executeFreeform(save,'看看这里有没有异常',proposal(),randomUUID(),()=>0);
    expect(empty.facts.join(' ')).toContain('没有发现明显异常');
    expect(empty.save.resolution_receipts?.[0].kind).toBe('SIMPLE_CHECK');
    const elsewhere=save.definition.map?.locations.find(location=>location.id!==here)?.id??here;
    const evidence=(id:string,location_id:string)=>({id,status:'EXISTS' as const,description:'旧有的裂痕',event_ref:null,discovered_by:[],placement:{location_id,anchor_entity_id:null,scene_scope:null,discoverability:{domain:'investigation',difficulty:'normal' as const}}});
    save.gm_state.hidden_truth={version:1,commitments:[{id:'fixed',commitment:'HARD_TRUTH',statement:'原有真相',seed_constraint:null,source:'GM_DECLARED',created_event_ref:null,known_by:[],evidence:[evidence('local_mark',here),evidence('remote_mark',elsewhere)]}]};
    const found=executeFreeform(save,'看教室异常',proposal(),randomUUID(),()=>.999);
    expect(found.facts.join(' ')).toContain('旧有的裂痕');
    const entries=found.save.gm_state.hidden_truth!.commitments[0].evidence;
    expect(entries[0].discovered_by).toContain(actor);expect(entries[1].discovered_by).toEqual([]);
  });
  it('passes a no-find program fact to Narrator and commits a scene result instead of truth unknown',async()=>{
    const f=await sparseSetup(),before=await f.service.current(),input='看看这里有没有异常';
    const facts:string[]=[];
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    vi.spyOn(f.ai,'narrate').mockImplementation(async(_save,_action,received)=>{facts.push(...received);return {...narrator,narrative:'你扫视了当前房间，这次没有发现明显异常。'};});
    await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input});
    const after=await f.service.current();
    expect(after.resolution_receipts?.at(-1)?.commit_status).toBe('committed');
    expect(facts.join(' ')).toContain('没有发现明显异常');
    expect(after.last_turn?.narrative).not.toContain('当前世界状态无法确定');
  });
  it('persists one NPC persona through System and UI boundaries without changing another NPC',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),first=save.entities.find(e=>e.id!==save.player_state.entity_id&&e.components.character)!;
    first.components.identity.name='甲老师';
    const second=structuredClone(first);second.id='second_npc';second.components.identity.name='乙同学';save.entities.push(second);await f.store.write(save);
    const before=await f.service.current(),result=await handleSystemInput(f.service,{input:'把甲老师的说话风格设为成熟温柔，像稳重的大姐姐。',game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()});
    expect(result.category).toBe('CHARACTER_PERSONA');
    const after=await f.service.current();
    expect(after.entities.find(e=>e.id===first.id)?.components.character?.speech_style).toContain('成熟温柔');
    expect(after.entities.find(e=>e.id===second.id)?.components.character?.speech_style).toBeUndefined();
    expect(after.runtime.time).toEqual(before.runtime.time);
    expect(characterContext(after,first.id).characters.find(e=>e.id===first.id)?.allowed_persona.speech_style).toContain('成熟温柔');
    const restarted=new GameService(f.store,new AIRuntime({name:'fixture',generate:async()=>{throw Error('unused')}}),after.definition);
    expect((await restarted.current()).entities.find(e=>e.id===first.id)?.components.character?.speech_style).toContain('成熟温柔');
    const view=publicView(after),html=renderToStaticMarkup(createElement(CharacterDetail,{view,entity:view.entities.find(e=>e.id===first.id)!,busy:false,act:()=>{},editPersona:async()=>{}}));
    expect(html).toContain('说话风格');expect(html).toContain('成熟温柔');expect(html).toContain('保存角色表现');
    const reset=await handleSystemInput(f.service,{input:'把她说话方式恢复默认。',game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect(reset.category).toBe('CHARACTER_PERSONA');
    expect((await f.service.current()).entities.find(e=>e.id===first.id)?.components.character?.speech_style).toBe('');
  });
  it('accepts a custom-persona TALK when real narrator output has mechanical_claims null',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),npc=save.entities.find(e=>e.id!==save.player_state.entity_id&&e.components.character)!;
    npc.components.character.speech_style='成熟温柔，语气从容';
    npc.components.location=structuredClone(save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location);
    await f.store.write(save);
    let prompt='';const ai=new AIRuntime({name:'fixture',generate:async request=>{if(request.role!=='narrator')throw Error('unexpected role');prompt=request.prompt;return {data:{...narrator,speaker:npc.id,dialogue:'先坐下，我们慢慢说。',mechanical_claims:null}};}});
    const service=new GameService(f.store,ai,save.definition),before=await service.current();
    await service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'今天的安排'}}});
    const after=await service.current();expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.last_turn?.dialogue).toContain('慢慢说');expect(prompt).toContain('成熟温柔');
  });
});
