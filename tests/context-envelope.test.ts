import { describe, expect, it } from 'vitest';
import { contextEnvelope } from '../src/system/context-envelope.js';
import { publicView } from '../src/core/state.js';
import { routeContext } from '../src/system/context-router.js';
import { sparseSetup } from './sparse-fixture.js';

describe('fiction and reality context envelope', () => {
  it('uses the player character as the actor on the World surface', async () => {
    const f=await sparseSetup(),view=publicView(await f.service.current()),envelope=contextEnvelope(view,'观察房间','WORLD');
    expect(envelope).toMatchObject({input_surface:'WORLD',actor:'PLAYER_CHARACTER',fictional_context:true,real_world_override:false,player_entity_id:view.player_id,world_id:view.game_id,intent_domain:'world'});
  });
  it('uses framework-user context on the System surface', async () => {
    const f=await sparseSetup(),view=publicView(await f.service.current());
    expect(contextEnvelope(view,'调整界面','SYSTEM')).toMatchObject({input_surface:'SYSTEM',actor:'FRAMEWORK_USER',fictional_context:false,intent_domain:'system'});
  });
  it('lets explicit real-world language override the World prior and passes the envelope to model boundaries', async () => {
    const prompts:string[]=[];
    const f=await sparseSetup(async request=>{
      prompts.push(request.prompt);const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.destination)return {data:{destination:'SYSTEM_META_INTENT',confidence:.95,clarification:null,speech_target_id:null,resolved_input:null,world_input:null,end_conversation:false}};
      return {data:{type:'WAIT',target_id:null,parameters_json:'{}',clarification:null}};
    });
    const view=publicView(await f.service.current()),override=contextEnvelope(view,'暂停游戏，我现实里需要说件事','WORLD');
    expect(override).toMatchObject({actor:'REAL_WORLD_USER',fictional_context:false,real_world_override:true,intent_domain:'real_world'});
    expect((await routeContext(f.service,'暂停游戏，我现实里需要说件事','world_input')).destination).toBe('SYSTEM_META_INTENT');
    await f.service.ai.interpret(await f.service.current(),'观察天空');
    expect(prompts.some(prompt=>prompt.includes('"input_surface":"WORLD"')&&prompt.includes('"actor":"PLAYER_CHARACTER"')&&prompt.includes('"fictional_context":true'))).toBe(true);
    expect(prompts.every(prompt=>!prompt.includes('ignore policy')&&!prompt.includes('bypass safety'))).toBe(true);
  });
});
