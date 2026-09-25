import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fresh, MemoryStore } from './helpers.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { GameService } from '../src/server/service.js';
import { handleAgentInput } from '../src/agent/executor.js';
import { fastPlan, hasUserCondition } from '../src/agent/planner.js';
import { executeFreeform, freeformSchema } from '../src/core/freeform.js';
import { emptyWorld } from '../src/ai/authoring.js';
import { newSave, publicView, validateSave } from '../src/core/state.js';
async function setup() {
 const store=new MemoryStore(),save=fresh(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
 const npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
 npc.components.identity.name='梅芙';npc.components.location=structuredClone(player.components.location);
 save.last_turn={narrative:'先前场景',speaker:null,dialogue:null,choices:[],context_actions:[]};
 await store.write(save);const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,save.definition);
 Object.assign(save,await service.current());return {store,save,player:save.entities.find(e=>e.id===player.id)!,npc:save.entities.find(e=>e.id===npc.id)!,ai,service};
}
const outcome=(target_id:string|null=null)=>({narrative:'你挥出一拳，对方退后捂住脸颊。',minutes:1,target_id,facts:['发生了一次肢体冲突。'],relationship:null});
async function input(f:Awaited<ReturnType<typeof setup>>,text:string,id=randomUUID()){
 const s=await f.service.current();return handleAgentInput(f.service,{input:text,game_id:s.game_id,expected_revision:s.state_revision,request_id:id});
}
it('punch is an unconditional world action with no engineering assistant or navigation',async()=>{
 const f=await setup();vi.spyOn(f.ai,'freeform').mockResolvedValue(outcome(f.npc.id));
 const result=await input(f,'狠狠揍梅芙一拳');
 expect(result.plan!.goals.map(g=>g.type)).toEqual(['WORLD_ACTION']);expect(result.presentation).toBe('story');expect(result.ui_actions).toEqual([]);
 expect(result.view!.last_turn!.narrative).toContain('一拳');expect(result.time_advanced).toBe(1);
 const next=await f.service.current();expect(next.action_facts).toHaveLength(1);expect(next.entities.map(e=>e.components.condition)).toEqual(f.save.entities.map(e=>e.components.condition));
 expect(next.definition.enabled_modules).toEqual(f.save.definition.enabled_modules);
});
it('genuine conditional punch keeps punch intent instead of becoming an invitation',async()=>{
 const f=await setup(),p=fastPlan(publicView(f.save),'如果梅芙在这里，就狠狠揍她一拳。')!;
 expect(p.goals.map(g=>g.type)).toEqual(['CONDITIONAL_INTENT','WORLD_ACTION']);expect(p.goals[1].normalized_goal).toContain('揍梅芙');expect(p.goals[1].normalized_goal).not.toContain('邀请');
});
it.each(['假如','要是','若','只要','除非'])('recognizes explicit %s user condition',word=>expect(hasUserCondition(word+'对方在场，就说话')).toBe(true));
it('does not infer a player condition from an ordinary action',()=>expect(hasUserCondition('狠狠揍梅芙一拳')).toBe(false));
it('local exit has no map transaction or node creation',async()=>{
 const f=await setup();vi.spyOn(f.ai,'freeform').mockResolvedValue({...outcome(),narrative:'你走出门，停在屋外。',facts:['你走到屋外。']});
 const result=await input(f,'我出门到屋外。'),next=await f.service.current();
 expect(next.entities.find(e=>e.id===f.player.id)!.components.scene_position).toEqual({label:'屋外'});
 expect(next.map_state).toEqual(f.save.map_state);expect(next.definition.map).toEqual(f.save.definition.map);expect(result.time_advanced).toBe(1);
});
it('local movement works without a map module',()=>{
 const save=newSave(emptyWorld(fresh().definition.prompt_profile));
 const turn=executeFreeform(save,'我走到窗边',{...outcome(),narrative:'你停在窗边。'},randomUUID());
 expect(validateSave(turn.save).entities[0].components.scene_position).toEqual({label:'窗边'});expect(turn.save.definition.map).toBeUndefined();
});
it('a known named destination retains the dedicated MOVE action',async()=>{
 const f=await setup(),place=publicView(f.save).locations[0];
 expect(await f.ai.interpret(f.save,'前往'+place.name)).toEqual({type:'MOVE',target_id:place.id,parameters:{}});
});
it('remote target precondition refuses mutation even if GM proposes success',async()=>{
 const f=await setup();f.npc.components.location={location_id:'remote'};
 expect(()=>executeFreeform(f.save,'揍梅芙一拳',outcome(f.npc.id),randomUUID())).toThrow();
 expect(f.save.action_facts).toBeUndefined();
});
it('omitting a named target cannot bypass target validation',async()=>{
 const f=await setup();expect(()=>executeFreeform(f.save,'揍梅芙一拳',outcome(),randomUUID())).toThrow('对象');
});
it('schema rejects arbitrary numeric combat state and save patches',()=>{
 expect(freeformSchema.safeParse({...outcome(),hp:0}).success).toBe(false);
 expect(freeformSchema.safeParse({...outcome(),patches:[{op:'replace',path:'/entities'}]}).success).toBe(false);
 expect(freeformSchema.safeParse({...outcome(),minutes:100}).success).toBe(false);
});
it('HTTP-style explicit actions cannot inject a resolved generic outcome',async()=>{
 const f=await setup();await expect(f.service.turn({game_id:f.save.game_id,expected_revision:f.save.state_revision,request_id:randomUUID(),action:{type:'FREEFORM_ACTION',parameters:outcome()}})).rejects.toThrow();expect(await f.service.current()).toEqual(f.save);
});
it('empty shell bypasses creative AI and contains no world content',async()=>{
 const f=await setup(),spy=vi.spyOn(f.ai.adapter,'generate');
 for(const description of ['完全空白世界','纯空白，仅检测框架','不要具体世界内容']){
  const save=await f.ai.initialize(description,f.save.definition.prompt_profile);
  expect(save.definition.enabled_modules).toEqual(['core']);expect(save.entities).toHaveLength(1);
  expect(save.definition.map).toBeUndefined();expect(save.last_turn!.narrative).toBe('');
  expect(save.definition.events).toEqual([]);expect(save.definition.ruleset.currencies).toEqual({});
 }
 expect(spy).not.toHaveBeenCalled();
});
it('normal world creation still calls the world initializer',async()=>{
 const f=await setup(),spy=vi.spyOn(f.ai.adapter,'generate');await expect(f.ai.initialize('繁华都市冒险',f.save.definition.prompt_profile)).rejects.toThrow();expect(spy).toHaveBeenCalledOnce();
});
it('queries stay in assistant and cached UI arrays are detached',async()=>{
 const f=await setup(),s=await f.service.current(),body={input:'我现在有多少钱？',game_id:s.game_id,expected_revision:s.state_revision,request_id:randomUUID()};
 const first=await handleAgentInput(f.service,body);expect(first.presentation).toBe('assistant');first.ui_actions.push({kind:'open_panel',panel:'map'});
 expect((await handleAgentInput(f.service,body)).ui_actions).not.toContainEqual({kind:'open_panel',panel:'map'});
 expect(await f.service.current()).toEqual(f.save);
});

it('freeform uses no GM memory thread or hidden state',async()=>{const f=await setup();f.save.gm_state.notes='PRIVATE_CANARY';f.save.ai.threads.gm_reasoning='private-thread';const spy=vi.spyOn(f.ai.adapter,'generate').mockResolvedValue({data:outcome(f.npc.id)});await f.ai.freeform(f.save,'揍梅芙一拳');expect(spy.mock.calls[0][0].threadId).toBeUndefined();expect(spy.mock.calls[0][0].prompt).not.toContain('PRIVATE_CANARY');});
it.each(['EMPTY_WORLD','FRAMEWORK_TEST'])('explicit %s creates a semantic shell',async(mode)=>{const f=await setup();const spy=vi.spyOn(f.ai.adapter,'generate');const save=await f.ai.initialize(mode,f.save.definition.prompt_profile);expect(save.definition.enabled_modules).toEqual(['core']);expect(save.entities).toHaveLength(1);expect(spy).not.toHaveBeenCalled();});
// Product decision (browser acceptance round): a relationship change proposed by the model is optional enrichment.
// A dimension this world does not track is dropped with a structured log; the otherwise valid action still commits.
// Genuine action-level violations (missing target, remote target, illegal mutation) still roll back — see the other cases.
it('unknown relationship dimension is dropped instead of rolling back the action',async()=>{
 const f=await setup();vi.spyOn(f.ai,'freeform').mockResolvedValue({...outcome(f.npc.id),relationship:{dimension:'unknown',delta:2}});
 const before=await f.service.current(),dimensions=JSON.stringify(before.definition.ruleset.relationship_dimensions);
 const result=await input(f,'揍梅芙一拳'),next=await f.service.current();
 expect(result.time_advanced).toBe(1);expect(next.state_revision).toBeGreaterThan(before.state_revision);
 expect(next.last_turn!.narrative).toContain('一拳');expect(next.action_facts).toHaveLength(1);
 expect(next.entities.find(e=>e.id===f.player.id)!.components.relationships?.entries??{}).toEqual({});
 expect(JSON.stringify(next.definition.ruleset.relationship_dimensions)).toBe(dimensions);
 expect(result.message).not.toContain('unknown');expect(result.message).not.toContain('关系维度');
});

it('each request owns its navigation and a following action has no stale panels',async()=>{const f=await setup();const query=await input(f,'我和梅芙是什么关系？');expect(query.ui_actions.length).toBeGreaterThan(0);vi.spyOn(f.ai,'freeform').mockResolvedValue(outcome(f.npc.id));const action=await input(f,'揍梅芙一拳');expect(action.ui_actions).toEqual([]);expect(action.presentation).toBe('story');});
