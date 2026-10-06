import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup,sparseWorld} from './sparse-fixture.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {executeFreeform,localDestination} from '../src/core/freeform.js';
import {prepareCheck,resolveCheck} from '../src/core/resolution.js';
import {validateResolvedNarrative} from '../src/core/narrative-firewall.js';
import {evaluateWorldPrerequisites} from '../src/core/prerequisites.js';
import {classifyChoiceExecution} from '../src/core/choice-availability.js';
import {createRegistry} from '../src/modules/index.js';
import {executeAction} from '../src/core/runtime.js';
import {addDynamicLocation} from '../src/core/map.js';

const semantics=(type:'DETERMINISTIC'|'SIMPLE_CHECK'|'GRADED_CHECK'='DETERMINISTIC')=>({
  type,domain:'general',band:'normal' as const,visibility:'public' as const,stakes:'这次行动尝试',stages:[],evidence_ids:[],
});
const proposal=(overrides:Record<string,unknown>={})=>({narrative:'模型声称已经成功。',minutes:1,target_id:null,
  facts:['模型声称掷出99并获得胜利'],relationship:null,item_move:null,resolution:semantics(),required_conditions:[],...overrides});
const narration=(text:string)=>({narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
  interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

describe('Batch 3.1 resolution closure',()=>{
  it('gives an open action without a specialized primitive a program receipt, ignoring fake provider dice',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const turn=executeFreeform(save,'我把椅子扔向窗户',proposal({resolution:semantics('SIMPLE_CHECK')}),randomUUID(),()=>0);
    expect(turn.save.resolution_receipts).toHaveLength(1);
    const receipt=turn.save.resolution_receipts![0];
    expect(receipt).toMatchObject({actor_id:save.player_state.entity_id,kind:'SIMPLE_CHECK',commit_status:'pending',time_cost:1});
    expect(receipt.rolls).toHaveLength(1);
    expect(receipt.canonical_facts.join(' ')).not.toContain('99');
    expect(turn.save.entities).toEqual(save.entities);
  });
  it('rejects missing classification before Narrator and leaves state unchanged',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal({resolution:null}));
    const narrator=vi.spyOn(f.ai,'narrate');
    await expect(f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'我试着翻过围栏'})).rejects.toThrow('判定方案');
    expect(narrator).not.toHaveBeenCalled();expect(await f.service.current()).toEqual(before);
  });
  it('records deterministic attempts with no RNG and commits the receipt once',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你扬声呼喊，声音在近处回荡。'));
    const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'我大声喊她的名字'};
    await f.service.turn(request);const after=await f.service.current();
    expect(after.resolution_receipts).toHaveLength(1);
    expect(after.resolution_receipts![0]).toMatchObject({kind:'DETERMINISTIC',outcome:'success',rolls:[],commit_status:'committed'});
    await f.service.turn(request);expect((await f.service.current()).resolution_receipts).toHaveLength(1);
  });
  it.each([
    ['你成功翻过围栏。','failure'],
    ['你拿起一把新剑。','inventory'],
    ['对方受伤倒地，随后死亡。','injury'],
    ['你发现了隐藏的暗门线索。','evidence'],
  ])('blocks unsupported narrator claim %s',async(text,kind)=>{
    const f=await sparseSetup(),save=await f.service.current();
    const band=kind==='failure'?'extreme':'normal';
    const turn=executeFreeform(save,'我试着翻过围栏',proposal({resolution:{...semantics('SIMPLE_CHECK'),band}}),randomUUID(),()=>0);
    const receipt=turn.save.resolution_receipts![0];
    expect(()=>validateResolvedNarrative(receipt,narration(text),false)).toThrow();
    expect(save.state_revision).toBe(0);
  });
  it('regenerates a contradictory narrator result before committing a validated narrative',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    const freeform=vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal({resolution:{...semantics('SIMPLE_CHECK'),band:'extreme'}}));
    const narrator=vi.spyOn(f.ai,'narrate').mockResolvedValueOnce(narration('你成功翻过围栏，走到了另一边。'))
      .mockResolvedValueOnce(narration('你尝试攀爬围栏，但这次没能攀上去。'));
    const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'我试着翻过围栏'};
    await f.service.turn(request);
    const committed=await f.service.current();
    expect(committed.state_revision).toBe(before.state_revision+1);
    expect(freeform).toHaveBeenCalledTimes(1);
    expect(narrator).toHaveBeenCalledTimes(2);
    expect(committed.resolution_receipts?.[0].commit_status).toBe('committed');
    expect(committed.resolution_receipts?.[0].outcome).toMatch(/failure/);
    expect(committed.last_turn?.narrative).toContain('没能攀上去');
    expect(committed.entities).toEqual(before.entities);
  });
  it('does not commit when a compound local goal lacks activity completion evidence',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const input='回到书桌前，把作业本下一页写完';
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal({minutes:5,resolution:semantics('SIMPLE_CHECK')}));
    const narrator=vi.spyOn(f.ai,'narrate');
    await expect(f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input})).rejects.toThrow('完整目标');
    expect(narrator).not.toHaveBeenCalled();
    expect(await f.service.current()).toEqual(before);
  });
  it('treats a model-invented completion quote as non-authoritative activity text',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const turn=executeFreeform(save,'我翻开作业本',proposal({completion_quote:'把作业本下一页写完'}),randomUUID());
    expect(turn.save.resolution_receipts?.[0].effects).toContain('activity');
    expect(turn.save.resolution_receipts?.[0].effects).not.toContain('progress');
    expect(turn.save.action_facts?.[0].facts.join(' ')).not.toContain('已完成玩家目标');
    expect(save.action_facts).toBeUndefined();
  });
  it('rejects a quantified milestone even if the proposal claims it completed',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),requestId=randomUUID();
    const input='回到书桌前，把作业本下一页写完';
    const before=structuredClone(save);
    expect(()=>executeFreeform(save,input,proposal({completion_quote:'把作业本下一页写完'}),requestId)).toThrow('完整目标');
    expect(save).toEqual(before);
  });
  it('keeps a rejected mechanical claim uncommitted when constrained regeneration also fails',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal());
    const narrator=vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你拿起了未登记的宝物。'));
    const request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'我检查眼前的物件'};
    await expect(f.service.turn(request)).rejects.toThrow('尚未提交');
    expect(narrator).toHaveBeenCalledTimes(3);
    expect(await f.service.current()).toEqual(before);
  });
  it('keeps a zero-component wait valid without requiring progress or position',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你在原地等了十分钟。'));
    await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,
      action:{type:'HOLD',parameters:{minutes:10,activity:'在原地等待十分钟'}}});
    const after=await f.service.current();
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.runtime.time.minute).toBe(before.runtime.time.minute+10);
  });
  it('derives local scene destinations from movement grammar rather than place names',()=>{
    expect(localDestination('回到书桌前，把作业本下一页写完')).toBe('书桌前');
    expect(localDestination('从床边走到门口')).toBe('门口');
    expect(localDestination('从厨房走到窗台旁')).toBe('窗台旁');
  });
  it('restores the same pending free-action receipt after a service restart without another classification or roll',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-batch31-retry-'));
    try{
      const store=new JsonStore(directory),world=sparseWorld(),ai=new AIRuntime({name:'fixture',generate:async()=>{throw Error('unexpected provider call')}});
      const interpret=vi.spyOn(ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
      const freeform=vi.spyOn(ai,'freeform').mockResolvedValue(proposal({resolution:{...semantics('SIMPLE_CHECK'),band:'extreme'}}));
      const narrate=vi.spyOn(ai,'narrate').mockRejectedValueOnce(Error('controlled interruption')).mockResolvedValue(narration('你尝试攀爬，手掌擦过栏杆。'));
      const first=new GameService(store,ai,world);await first.newGame();
      const before=await first.current(),request={request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'我试着翻过栏杆'};
      await expect(first.turn(request)).rejects.toThrow('尚未结算');
      const pending=await store.readPending(request.request_id);
      expect(pending?.candidate.resolution_receipts?.[0]).toMatchObject({commit_status:'pending',kind:'SIMPLE_CHECK'});
      const restarted=new GameService(store,ai,world);await restarted.turn(request);
      const after=await restarted.current();
      expect(after.resolution_receipts?.[0]).toMatchObject({...pending?.candidate.resolution_receipts?.[0],commit_status:'committed'});
      expect(freeform).toHaveBeenCalledTimes(1);expect(interpret).toHaveBeenCalledTimes(1);expect(narrate).toHaveBeenCalledTimes(2);
      expect(after.runtime.receipts.filter(receipt=>receipt.id===request.request_id)).toHaveLength(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('rejects absent or inaccessible referenced items and remote targets before RNG',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(evaluateWorldPrerequisites(save,{requirements:[{kind:'item_held',subject_id:'missing_knife'}]}).status).toBe('NOT_EXECUTABLE');
    expect(evaluateWorldPrerequisites(save,{requirements:[{kind:'capability',subject_id:'uninstalled_capability'}]}).status).toBe('NOT_EXECUTABLE');
    const here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
    expect(evaluateWorldPrerequisites(save,{requirements:[{kind:'same_location',subject_id:here}]}).status).toBe('EXECUTABLE');
    expect(()=>executeFreeform(save,'我用不存在的刀',{...proposal(),required_conditions:[{kind:'item_held',subject_id:'missing_knife'}]},randomUUID(),()=>{throw Error('must not roll');})).toThrow('没有持有');
    const target=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    target.components.location={location_id:'remote'};
    expect(evaluateWorldPrerequisites(save,{target_id:target.id}).status).toBe('NOT_EXECUTABLE');
    expect(save.resolution_history).toBeUndefined();
  });
  it('allows a referenced scene object without requiring it to be an NPC conversation target',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
    save.entities.push({id:'scene_barrier',type:'object',components:{identity:{name:'围栏',description:'',avatar_id:null},location:{location_id:here}}});
    const turn=executeFreeform(save,'我试着翻过围栏',proposal({resolution:semantics('SIMPLE_CHECK'),
      required_conditions:[{kind:'entity_exists',subject_id:'scene_barrier'},{kind:'same_location',subject_id:'scene_barrier'}]}),randomUUID(),()=>.5);
    expect(turn.save.resolution_receipts?.[0].kind).toBe('SIMPLE_CHECK');
  });
  it('discovers only pre-existing scene-bound hidden facts after a successful search',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),actor=save.player_state.entity_id;
    const here=String(save.entities.find(entity=>entity.id===actor)?.components.location?.location_id);
    const elsewhere=save.definition.map?.locations.find(location=>location.id!==here)?.id??'remote';
    const evidence=(id:string,location_id:string)=>({id,status:'EXISTS' as const,description:id,event_ref:null,discovered_by:[],
      placement:{location_id,anchor_entity_id:null,scene_scope:null,discoverability:{domain:'investigation',difficulty:'normal' as const}}});
    save.gm_state.hidden_truth={version:1,commitments:[{id:'fixed_truth',commitment:'HARD_TRUTH',statement:'先于行动存在的事实',seed_constraint:null,
      source:'GM_DECLARED',created_event_ref:null,known_by:[],evidence:[evidence('near_clue',here),evidence('remote_clue',elsewhere)]}]};
    const spec=prepareCheck(save,randomUUID(),{type:'GRADED_CHECK',domain:'investigation',band:'normal',discover_facts:true});
    expect(spec.evidence_ids).toEqual(['near_clue']);
    resolveCheck(save,spec,()=>.999);
    const entries=save.gm_state.hidden_truth.commitments[0].evidence;
    expect(entries[0].discovered_by).toEqual([actor]);expect(entries[1].discovered_by).toEqual([]);
    expect(()=>prepareCheck(save,randomUUID(),{type:'GRADED_CHECK',domain:'investigation',band:'normal',evidence_ids:['remote_clue']})).toThrow();
  });
  it('runs registered on_time_advance hooks for each bounded HOLD segment',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),registry=createRegistry(save.definition.enabled_modules),segments:number[]=[];
    registry.events.on('on_time_advance',(_ctx,event)=>segments.push(event.minutes??0));
    const turn=executeAction(save,{type:'HOLD',parameters:{minutes:125,activity:'在这里等待'}},randomUUID(),'player',()=>.5,registry);
    expect(segments).toEqual([60,60,5]);expect(turn.action.time_cost).toBe(125);
  });
  it('classifies unreachable choices as unavailable and sends open choice clicks through the normal receipt path',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addDynamicLocation(save,{id:'remote_tower',name:'远方高塔',description:'',tags:[],known_by_default:true},[]);
    expect(classifyChoiceExecution(save,'前往远方高塔',{index:0,intent_key:'move',consequence_key:'tower',target_id:'remote_tower'})).toBe('NOT_EXECUTABLE');
    expect(classifyChoiceExecution(save,'试着翻过栏杆')).toBe('CONDITIONALLY_EXECUTABLE');
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal({resolution:semantics('SIMPLE_CHECK')}));
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration('你尝试翻越栏杆，手掌触到冰凉的金属。'));
    const before=await f.service.current();
    await f.service.turn({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:'试着翻过栏杆'});
    expect((await f.service.current()).resolution_receipts?.[0].kind).toBe('SIMPLE_CHECK');
  });
});
