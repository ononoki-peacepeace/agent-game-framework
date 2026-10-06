import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseFreeformProposal,executeFreeform,freeformSchema} from '../src/core/freeform.js';
import {compileStructuredSchema,normalizeProviderCollections,schemaViolations} from '../src/ai/provider-schema.js';
import {z} from 'zod';
import {fresh,MemoryStore} from './helpers.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {publicView} from '../src/core/state.js';
import {relationshipSummary} from '../src/shared/relationship.js';
import {worldCandidateIssues,projectWorldRepair} from '../src/ai/world-initializer-repair.js';
import {sparseSetup} from './sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';

const proposal=()=>({narrative:'完成了日常行动',minutes:1,target_id:null,facts:[],relationship:null,
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'正常活动',stages:[],evidence_ids:[],discover_facts:false}});

describe('daily QA contract and continuity',()=>{
  it('normalizes null, missing and explicit false discover_facts at the single provider boundary',()=>{
    const schema=compileStructuredSchema(z.toJSONSchema(freeformSchema));
    expect(schemaViolations(schema)).toEqual([]);
    for(const value of [null,undefined,false]){
      const raw={...proposal(),resolution:{...proposal().resolution,discover_facts:value}};
      if(value===undefined)delete (raw.resolution as {discover_facts?:boolean|null}).discover_facts;
      expect(parseFreeformProposal(raw).resolution?.discover_facts).toBe(false);
      expect((normalizeProviderCollections('freeform',raw) as typeof raw).resolution.discover_facts).toBe(false);
    }
    expect(parseFreeformProposal({...proposal(),resolution:{...proposal().resolution,discover_facts:true}}).resolution?.discover_facts).toBe(true);
  });
  it('honors an explicit bounded twenty-minute daily activity as one canonical turn',()=>{
    const save=fresh(),before={...save.runtime.time};
    const result=executeFreeform(save,'在公寓做早饭并吃完，大约花二十分钟。',{...proposal(),completion_quote:'做早饭并吃完'},randomUUID(),()=>.5);
    expect(result.action.time_cost).toBe(20);
    expect(result.save.runtime.time.minute-before.minute).toBe(20);
    expect(result.save.action_facts?.at(-1)?.input).toContain('吃完');
    expect(result.save.resolution_receipts?.at(-1)?.effects).toContain('activity');
    expect(result.save.resolution_receipts?.at(-1)?.activity).toMatchObject({duration_minutes:20,occurred:true});
    expect(result.save.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
  });
  it('does not let incidental model item movement hijack a self activity',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    (player.components.inventory as {items:Record<string,number>}).items.notebook=1;
    const result=executeFreeform(save,'写一会儿数学作业',{...proposal(),completion_quote:'写完这一页数学作业',item_move:{item_id:'notebook',to:'scene',position_label:'桌面'}},randomUUID(),()=>.5);
    expect((result.save.entities.find(entity=>entity.id===player.id)?.components.inventory as {items:Record<string,number>}).items.notebook).toBe(1);
    expect(result.save.resolution_receipts?.at(-1)?.effects).not.toContain('inventory');
    expect(result.save.resolution_receipts?.at(-1)?.effects).toContain('activity');
    expect(result.save.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
  });
  it('retains the whole natural action when a model plans only its first motion',async()=>{
    const view=publicView(fresh());
    const text='起身去厨房喝一口水。';
    const ai={planGoals:vi.fn(async()=>({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'起身',depends_on:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}))} as unknown as AIRuntime;
    const plan=await createAgentPlan(ai,view,text);
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0].normalized_goal).toBe(text);
  });
  it('keeps a generated multi-step choice executable as a full local action',async()=>{
    const view=publicView(fresh()),choice='合上琴盖、把盖布罩回去，去厨房给自己弄点早饭。';
    const ai={planGoals:vi.fn(async()=>({goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:'合上琴盖、把盖布罩回去',depends_on:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}))} as unknown as AIRuntime;
    const plan=await createAgentPlan(ai,view,choice);
    expect(plan.goals[0]).toMatchObject({type:'WORLD_ACTION',normalized_goal:choice});
  });
  it('executes a generated continuous choice through the real agent and canonical receipt',async()=>{
    const f=await sparseSetup(),choice='合上琴盖、把盖布罩回去，去厨房给自己弄点早饭。';
    const save=await f.service.current();save.last_turn={narrative:'琴声停了。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};await f.store.write(save);
    const scope={scope:'now' as const,day_offset:0,window:'any' as const};
    vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      {goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'合上琴盖、罩回盖布',depends_on:[],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
      {goal_id:'g2',type:'WORLD_ACTION',normalized_goal:'去厨房弄早饭',depends_on:['g1'],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
    ]} as never);
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你收好钢琴，走到厨房，准备了早饭。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const result=await handleAgentInput(f.service,{input:choice,game_id:save.game_id,expected_revision:save.state_revision,request_id:randomUUID()});
    const after=await f.service.current();
    expect(result.plan?.status).toBe('completed');expect(result.plan?.goals).toHaveLength(1);
    expect(after.state_revision).toBe(save.state_revision+1);
    expect(after.resolution_receipts?.at(-1)?.semantic_action).toBe(choice);
  });
  it('preserves both model micro-goals of a continuous local meal intent',async()=>{
    const view=publicView(fresh()),input='在当前住处简单做一份早饭并吃完，大约花二十分钟。';
    const goal=(id:string,normalized_goal:string,depends_on:string[])=>({goal_id:id,type:'WORLD_ACTION',normalized_goal,depends_on,condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]});
    const ai={planGoals:vi.fn(async()=>({goals:[goal('g1','做早饭',[]),goal('g2','吃完早饭',['g1'])]}))} as unknown as AIRuntime;
    const plan=await createAgentPlan(ai,view,input);
    expect(plan.goals).toHaveLength(2);
    expect(plan.execution_order).toEqual(['g1','g2']);
    expect(plan.goals.map(goal=>goal.normalized_goal)).toEqual(['做早饭','吃完早饭']);
    expect(plan.goals[1].depends_on).toEqual(['g1']);
  });
  it('does not route a self activity to a location objective',async()=>{
    const view=publicView(fresh()),input='坐下来写这一页数学作业';
    const ai={planGoals:vi.fn(async()=>({goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:'坐下来',depends_on:[],condition:null,branch:null,
      temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}))} as unknown as AIRuntime;
    const plan=await createAgentPlan(ai,view,input);
    expect(plan.goals[0]).toMatchObject({type:'WORLD_ACTION',normalized_goal:input});
  });
  it('does not MOVE to the location the player already occupies for a local activity',async()=>{
    const save=fresh(),location=save.definition.map!.locations.find(item=>item.id===save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location?.location_id)!;
    const ai=new AIRuntime({name:'controlled',generate:async()=>{throw Error('local activity should not require intent model')}});
    expect(await ai.interpret(save,`去${location.name}做一份简单早饭并吃完`)).toEqual({type:'FREEFORM_ACTION',parameters:{}});
  });
  it('does not treat optional narrator choices as a mandatory handoff',async()=>{
    const save=fresh();save.last_turn={narrative:'你写下了一行字。',speaker:null,dialogue:null,choices:['继续写','先喝水'],context_actions:[]};
    const store=new MemoryStore();await store.write(save);
    const service=new GameService(store,new AIRuntime({name:'controlled',generate:async()=>{throw Error('unused')}}),save.definition);
    expect(await service.handoffBlocker()).toBeNull();
    save.foreground={blocker:'choice',reason:'现场必须作出选择'};await store.write(save);
    expect((await service.handoffBlocker())?.kind).toBe('player_decision');
  });
  it('separates an NPC occupation from the player relationship',()=>{
    const view=publicView(fresh()),npc=view.entities.find(e=>e.id!==view.player_id&&e.components.character)!;
    npc.components.character!.role='咖啡馆店主';
    const summary=relationshipSummary(view,npc);
    expect(summary.text).not.toContain('目前是咖啡馆店主');
    expect(summary.source).toBe('unknown');
  });
});

describe('opening canonical consistency',()=>{
  it('repairs an opening time without changing world identity, map or truth',async()=>{
    const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
    const bad=structuredClone(base),repair=structuredClone(base);
    bad.opening='九月的最后一个星期日，下午四点刚过。你站在起点。';
    repair.opening='第1天早上九点，你站在起点。';
    repair.characters[0].name='不应被采用的改名';
    const issues=worldCandidateIssues(bad);
    expect(issues.some(issue=>issue.path==='opening'&&issue.code==='canonical_time_mismatch')).toBe(true);
    expect(issues.some(issue=>issue.code==='canonical_weekday_mismatch')).toBe(true);
    const projected=projectWorldRepair(bad,repair,issues) as typeof bad;
    expect(worldCandidateIssues(projected)).toEqual([]);
    expect(projected.characters).toEqual(bad.characters);
    expect(projected.locations).toEqual(bad.locations);
  });
  it('rejects an opening travel estimate that contradicts a canonical route',async()=>{
    const base=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
    const route=base.routes[0],from=base.locations.find((location:{id:string})=>location.id===route.from),to=base.locations.find((location:{id:string})=>location.id===route.to);
    base.opening=`第1天上午九点。从${from.name}去${to.name}要${route.travel_minutes+1}分钟。`;
    expect(worldCandidateIssues(base).some(issue=>issue.code==='canonical_route_duration_mismatch')).toBe(true);
  });
});
