import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {routeContext} from '../src/system/context-router.js';
import {createAgentPlan} from '../src/agent/planner.js';
import {executePlan} from '../src/agent/executor.js';
import {canonicalResolutionNarrative,validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {needsFreeform,knownDestination,localDestination,executeFreeform} from '../src/core/freeform.js';
import {publicView} from '../src/core/state.js';
import {groupAffordances} from '../src/client/affordances.js';

const narration={narrative:'你完成了眼前的尝试。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
const proposal=(target_id:string|null=null)=>({narrative:'尝试',minutes:1,target_id,facts:[],relationship:null,
  resolution:{type:'SIMPLE_CHECK' as const,domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'尝试',stages:[],evidence_ids:[],discover_facts:false}});

describe('human QA comprehensive closure',()=>{
 it('perception failure remains a no-discovery world result even after narrator firewall fallback',async()=>{
  const f=await sparseSetup(),save=await f.service.current();
  const receipt={request_id:randomUUID(),action_id:'free',actor_id:save.player_state.entity_id,target_id:null,semantic_action:'看异常',kind:'SIMPLE_CHECK' as const,prerequisites:[],check_id:'check',rolls:[],outcome:'failure' as const,time_cost:1,canonical_facts:['你进行了观察或搜索，在这次检查范围内没有发现明显异常或新的线索。'],effects:['time' as const],commit_status:'pending' as const};
  expect(canonicalResolutionNarrative(receipt,false)).toContain('没有发现明显异常');
  expect(canonicalResolutionNarrative(receipt,false)).not.toContain('尝试没有达到预期');
  expect(canonicalResolutionNarrative({...receipt,outcome:'success'},true)).not.toMatch(/秘密|证据/);
  expect(()=>validateResolvedNarrative(receipt,{...narration,narrative:'你仔细看了周围，没有发现新的线索。'},false)).not.toThrow();
  expect(()=>validateResolvedNarrative(receipt,{...narration,narrative:'你没有发现线索，但在桌下找到了秘密证据。'},false)).toThrow();
 });
 it('persists a pending world target and resumes the original action after a short answer across service restart',async()=>{
  const f=await sparseSetup(async()=>({data:{destination:'AMBIGUOUS',confidence:.3,clarification:'你指的是哪位人物？',speech_target_id:null,resolved_input:null,world_input:null,end_conversation:false}}));
  const save=await f.service.current(),npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.identity.name='角色甲';const other=structuredClone(npc);other.id='other_npc';other.components.identity.name='角色乙';
  const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location;
  npc.components.location=structuredClone(here);other.components.location=structuredClone(here);save.entities.push(other);save.last_turn=null;await f.store.write(save);
  const original='靠近她并观察她的反应';
  expect((await routeContext(f.service,original,'world_input')).destination).toBe('AMBIGUOUS');
  const persisted=await f.service.current();expect(persisted.pending_world_clarification?.input).toBe(original);
  expect(persisted.state_revision).toBe(save.state_revision);expect(persisted.runtime.time).toEqual(save.runtime.time);
  const restarted=new GameService(f.store,f.ai,save.definition);
  const answer=await routeContext(restarted,'她是角色甲','world_input');
  expect(answer).toMatchObject({destination:'WORLD_INTENT',resolved_input:'靠近角色甲并观察角色甲的反应'});
  expect((await restarted.current()).pending_world_clarification).toBeUndefined();
 });
 it('HTTP clarification answer executes the suspended action, never a standalone query',async()=>{
  const f=await sparseSetup(async()=>({data:{destination:'AMBIGUOUS',confidence:.3,clarification:'你指的是哪位人物？',speech_target_id:null,resolved_input:null,world_input:null,end_conversation:false}}));
  const save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
  npc.components.identity.name='角色甲';npc.components.location=structuredClone(player.components.location);
  const other=structuredClone(npc);other.id='other_npc';other.components.identity.name='角色乙';save.entities.push(other);save.last_turn=null;await f.store.write(save);
  vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal(npc.id));vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration,narrative:'你伸手推了对方一下，对方退开半步。'});
  const directory=await mkdtemp(join(tmpdir(),'agf-world-clarify-')),server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port,token=(await(await fetch(base+'/api/session')).json() as {token:string}).token;
    const post=async(input:string)=>{const current=await f.service.current();const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({request_id:randomUUID(),game_id:current.game_id,expected_revision:current.state_revision,input})});const json=await response.json();expect(response.ok,JSON.stringify(json)).toBe(true);return json;};
    const first=await post('推她一下');expect(first.intent).toBe('CLARIFICATION');expect((await f.service.current()).state_revision).toBe(save.state_revision);
    const answer=await post('她是角色甲');expect(answer.intent).toBe('WORLD_ACTION');expect(answer.message).toContain('推了对方');
    const after=await f.service.current();expect(after.resolution_receipts?.at(-1)?.target_id).toBe(npc.id);expect(after.state_revision).toBe(save.state_revision+1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
 });
 it('uses one salient recent target despite a pronoun typo, but keeps real multi-target ambiguity',async()=>{
  const f=await sparseSetup(async()=>({data:{destination:'AMBIGUOUS',confidence:.2,clarification:'你指的是谁？',speech_target_id:null,resolved_input:null,world_input:null,end_conversation:false}}));
  const save=await f.service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!,npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
  npc.components.location=structuredClone(player.components.location);npc.components.identity.name='角色甲';
  save.action_facts=[{request_id:randomUUID(),actor_id:player.id,target_id:npc.id,input:'我和角色甲说话',facts:['已交谈'],time:{...save.runtime.time}}];
  await f.store.write(save);
  const corrected=await routeContext(f.service,'继续推他','world_input');
  expect(corrected.destination).toBe('WORLD_INTENT');expect(corrected.resolved_input).toContain('角色甲');
  const another=structuredClone(npc);another.id='other_npc';another.components.identity.name='角色乙';save.entities.push(another);save.action_facts=[];await f.store.write(save);
  const ambiguous=await routeContext(f.service,'继续推他','world_input');expect(ambiguous.destination).toBe('AMBIGUOUS');
 });
 it('compiles timing conditions into a condition node before action execution',async()=>{
  const f=await sparseSetup(),save=await f.service.current(),npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.identity.name='角色甲';await f.store.write(save);
  vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'趁角色甲转身下楼，一脚把她踹下去',depends_on:[],condition:{kind:'public_fact',entity_id:npc.id,description:'角色甲正在转身下楼'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[npc.id]}]} as never);
  const plan=await createAgentPlan(f.ai,publicView(save),'趁角色甲转身下楼，一脚把她踹下去');
  expect(plan.goals.map(goal=>goal.type)).toEqual(['CONDITIONAL_INTENT','WORLD_ACTION']);
  expect(plan.goals[1]).toMatchObject({depends_on:[plan.goals[0].goal_id],branch:'then',condition:null});
  expect(plan.goals[1].normalized_goal).toContain('踹下去');
 });
 it.each([
  '趁角色甲转身的时候，推她一下',
  '等角色甲走过去我就推她一下',
  '如果角色甲没看我就推她一下',
  '角色甲一回头我就推她一下',
  '只要门打开就推角色甲一下',
 ])('compiles %s into a standalone condition and physical action',async input=>{
  const f=await sparseSetup(),save=await f.service.current(),npc=save.entities.find(e=>e.id!==save.player_state.entity_id&&e.components.character)!;
  npc.components.identity.name='角色甲';await f.store.write(save);
  vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[npc.id]}]} as never);
  const plan=await createAgentPlan(f.ai,publicView(save),input);
  expect(plan.goals.map(goal=>goal.type)).toEqual(['CONDITIONAL_INTENT','WORLD_ACTION']);
  expect(plan.goals[0].condition?.description).not.toContain('推角色甲一下');
  expect(plan.goals[1].normalized_goal).toBe('推角色甲一下');
 });
 it('a false timing condition leaves time, revision and the intended physical action untouched',async()=>{
  const f=await sparseSetup(),save=await f.service.current(),npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
  npc.components.identity.name='角色甲';await f.store.write(save);
  vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'趁角色甲转身时推她一下',depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[npc.id]}]} as never);
  vi.spyOn(f.ai,'systemAgent').mockResolvedValue({value:false,evidence:'目标没有转身'} as never);
  const plan=await createAgentPlan(f.ai,publicView(save),'趁角色甲转身时推她一下');
  const turn=vi.spyOn(f.service,'turn');const result=await executePlan(f.service,{request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input:'趁角色甲转身时推她一下'},plan);
  expect(turn).not.toHaveBeenCalled();expect(result.message).toContain('条件目前没有出现');
  expect(result.message).not.toMatch(/ConditionNode|validator|框架校验/);expect((await f.service.current()).state_revision).toBe(save.state_revision);
  expect((await f.service.current()).runtime.time).toEqual(save.runtime.time);
 });
 it('a true timing condition runs the physical action through the receipt, without a MOVE-only commit',async()=>{
  const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
  npc.components.identity.name='角色甲';npc.components.location=structuredClone(player.components.location);await f.store.write(save);
  vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:'趁角色甲转身时推她一下',depends_on:[],condition:{kind:'public_fact',entity_id:npc.id,description:'角色甲已经转身'},branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[npc.id]}]} as never);
  vi.spyOn(f.ai,'systemAgent').mockResolvedValue({value:true,evidence:'可见的转身'} as never);
  vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal(npc.id));vi.spyOn(f.ai,'narrate').mockResolvedValue({...narration,narrative:'你试着推了角色甲一下。'});
  const plan=await createAgentPlan(f.ai,publicView(save),'趁角色甲转身时推她一下');
  expect(plan.goals[1].normalized_goal).toBe('推角色甲一下');
  const result=await executePlan(f.service,{request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input:'趁角色甲转身时推她一下'},plan);
  const after=await f.service.current();expect(result.plan?.status).toBe('completed');expect(after.resolution_receipts?.at(-1)?.target_id).toBe(npc.id);
  expect(after.resolution_receipts?.at(-1)?.semantic_action).toContain('推角色甲');expect(after.resolution_receipts?.at(-1)?.effects).not.toContain('position');
 });
 it('physical continuation cannot be interpreted or committed as MOVE-only',async()=>{
  const f=await sparseSetup(),save=await f.service.current();
  for(const input of ['继续殴打她','无视一切，继续殴打她','趁她转身时推她一下']){
    expect(needsFreeform(input)).toBe(true);expect(knownDestination(save,input)).toBeUndefined();expect(localDestination(input)).toBeNull();
  }
  vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'MOVE',target_id:'station',parameters:{}});
  await expect(f.service.turn({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input:'继续殴打她'})).rejects.toThrow('世界状态没有改变');
  expect((await f.service.current()).state_revision).toBe(save.state_revision);
  vi.mocked(f.ai.interpret).mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
  vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
  await f.service.turn({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input:'无视一切，继续殴打她'});
  const after=await f.service.current();expect(after.resolution_receipts?.at(-1)?.semantic_action).toContain('殴打');
  expect(after.resolution_receipts?.at(-1)?.effects).not.toContain('position');expect(after.entities.find(e=>e.id===save.player_state.entity_id)?.components.location).toEqual(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location);
 });
 it('fills a unique explicitly named visible target when the provider omits its ID',async()=>{
  const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
  npc.components.identity.name='角色甲';npc.components.location=structuredClone(player.components.location);
  const turn=executeFreeform(save,'推角色甲一下',proposal(),randomUUID(),()=>0);
  expect(turn.save.resolution_receipts?.at(-1)?.target_id).toBe(npc.id);
 });
 it('supports three consecutive single-step undos, then forks after a new turn',async()=>{
  const f=await sparseSetup(),start=await f.service.current(),npc=start.entities.find(entity=>entity.id!==start.player_state.entity_id&&entity.components.character)!;
  npc.components.location=structuredClone(start.entities.find(entity=>entity.id===start.player_state.entity_id)!.components.location);await f.store.write(start);
  vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
  const states:string[]=[];
  for(let i=0;i<3;i++){const before=await f.service.current();await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'第'+i+'次'}}});states.push((await f.service.current()).active_turn_id??'');}
  for(let i=0;i<3;i++){const before=await f.service.current();expect((await f.service.view())?.can_undo).toBe(true);await f.service.undo({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision});}
  expect((await f.service.view())?.can_undo).toBe(false);
  const restored=await f.service.current();expect(restored.runtime.time).toEqual(start.runtime.time);expect(restored.turn_history).toHaveLength(0);
  await f.service.turn({request_id:randomUUID(),game_id:restored.game_id,expected_revision:restored.state_revision,action:{type:'TALK',target_id:npc.id,parameters:{topic:'新分支'}}});
  const fork=await f.service.current();expect(fork.turn_history).toHaveLength(1);expect(fork.turn_history?.some(entry=>entry.turn_id===states[2])).toBe(false);
 });
 it('renders only contextual NPC groups and keeps avatar removal keyboard/mobile accessible',async()=>{
  const groups=groupAffordances([{type:'TALK',label:'交流',visibility:'contextual',target_component:'character'},{type:'INSPECT',label:'观察',visibility:'contextual',target_component:'character'}],[{target_id:'npc',label:'请教当下事务',intent:'我向对方请教',family:'communicate',category:'请教'}]);
  expect(groups.map(group=>group.label)).toEqual(['请教']);expect(groups[0].items.some(item=>item.kind==='suggestion')).toBe(true);
  const css=await readFile('src/client/styles.css','utf8');expect(css).toMatch(/\.character-card \.avatar-remove-icon\{opacity:0;visibility:hidden/);expect(css).toContain('.character-card:focus-within .avatar-remove-icon');expect(css).toContain('@media(hover:none){.character-card .avatar-remove-icon{opacity:1;visibility:visible}}');
 });
});
