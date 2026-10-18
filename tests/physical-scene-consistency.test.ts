import {describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {demo,MemoryStore} from './helpers.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {executeFreeform} from '../src/core/freeform.js';
import {prepareCheck} from '../src/core/resolution.js';
import {executeAction} from '../src/core/runtime.js';
import {validateScenePresenceNarrative,validateResolvedNarrative,canonicalResolutionNarrative} from '../src/core/narrative-firewall.js';
import {settlePhysicalNpcReactions,settleAutonomousNpcTurn} from '../src/agent/npc-agent.js';
import {npcPresentInView} from '../src/shared/interaction-context.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import type {PendingTurn} from '../src/storage/json-store.js';

const input='我突然抓住林舟，再尝试伤害他';
function fixture(){
  const world=structuredClone(demo);world.ruleset.resolution_profile={version:1,kind:'classic_d20'};
  const save=newSave(world),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!,npc=save.entities.find(entity=>entity.id==='npc_lin')!;
  player.components.scene_position={label:'桌旁'};npc.components.scene_position={label:'桌旁'};
  npc.components.condition={hp:100,stamina:100,stress:0};
  return save;
}
const proposal=()=>({narrative:'尝试身体行动',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
  physical_action:{kind:'harm',source_quote:'抓住林舟',contact_stage_id:'contact',injury_stage_id:'harm',harm_level:'serious',surprise_attempt:true},
  resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',
    stakes:'先接触，再尝试造成伤害',stages:[{id:'contact',band:'normal'},{id:'harm',band:'hard'}],evidence_ids:[],discover_facts:false}});
const rng=(values:number[])=>()=>{const value=values.shift();if(value===undefined)throw Error('unexpected extra roll');return value;};
const decision=(move=false)=>({kind:move?'proposed_action':'no_action',speech:null,vote_target:null,
  intent:move?'尝试离开现场':'暂不行动',proposed_action:move?{type:'MOVE',target_id:'market',reason:'避开当前威胁'}:null,
  evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'根据亲历事件决定',social_response:null});

describe('physical outcomes and canonical scene membership',()=>{
  it.each([
    ['success',[.95,.1,.95,.1],true,true,80],
    ['critical_failure',[.1,.95],false,false,100],
    ['partial_success',[.95,.1,.1,.95],true,false,100],
  ] as const)('settles %s with ordered contact and harm stages', (outcome,rolls,contact,harmed,hp)=>{
    const before=fixture(),turn=executeFreeform(before,input,proposal(),randomUUID(),rng([...rolls]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.outcome).toBe(outcome);expect(receipt.physical_outcome).toMatchObject({contact,harmed});
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition?.hp).toBe(hp);
    expect(before.entities.find(entity=>entity.id==='npc_lin')!.components.condition?.hp).toBe(100);
    expect(turn.save.resolution_history!.at(-1)!.stage_results?.map(stage=>stage.id))
      .toEqual(contact?['contact','harm']:['contact']);
    expect(turn.save.npc_agent_state?.npc_lin.memories.some(memory=>memory.event_ref===`physical:${receipt.request_id}`)).toBe(true);
    expect(turn.save.npc_agent_state?.npc_qiao?.memories.some(memory=>memory.event_ref===`physical:${receipt.request_id}`)??false).toBe(false);
    expect(validateSave(JSON.parse(JSON.stringify(turn.save))).resolution_receipts!.at(-1)!.physical_outcome).toEqual(receipt.physical_outcome);
  });
  it('uses canonical surprise, alertness and injury rather than granting an advantage from the word suddenly',()=>{
    const save=fixture(),target=save.entities.find(entity=>entity.id==='npc_lin')!;
    const check={type:'OPPOSED_CHECK' as const,domain:'physique',opposition_domain:'agility',band:'normal' as const,
      target_id:'npc_lin',physical:true,surprise_attempt:true};
    expect(prepareCheck(save,randomUUID(),check).actor_modifier).toBe(0);
    target.components.physical_state={awareness:'unaware',alert_to_ids:[],restrained_by:null};
    expect(prepareCheck(save,randomUUID(),check).actor_modifier).toBe(2);
    target.components.physical_state={awareness:'alert',alert_to_ids:['player'],restrained_by:null};
    const alerted=prepareCheck(save,randomUUID(),check);
    expect(alerted.actor_modifier).toBe(0);expect(alerted.opponent_modifier).toBe(2);
    target.components.condition!.hp=30;
    expect(prepareCheck(save,randomUUID(),check).opponent_modifier).toBe(0);
  });
  it('requires a registered environmental hazard and does not let a restraint be erased by an unrelated failed action',()=>{
    const save=fixture(),environment={...proposal(),physical_action:{...proposal().physical_action,
      mechanism:'environment',hazard_source:{source_id:'square',quote:'不存在的高温管道'}}};
    expect(()=>executeFreeform(save,input,environment,randomUUID(),()=>{throw Error('must not roll');})).toThrow('危险来源');
    const restraint={...proposal(),physical_action:{...proposal().physical_action,kind:'restrain',injury_stage_id:null},
      resolution:{...proposal().resolution,stages:[{id:'contact',band:'normal'}]}};
    const controlled=executeFreeform(save,input,restraint,randomUUID(),rng([.95,.1])).save;
    expect(controlled.entities.find(entity=>entity.id==='npc_lin')?.components.physical_state?.restrained_by).toBe('player');
    expect(()=>executeAction(controlled,{type:'MOVE',target_id:'market',parameters:{}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true)).toThrow('身体控制');
    const failed=executeFreeform(controlled,input,proposal(),randomUUID(),rng([0,.99])).save;
    expect(failed.entities.find(entity=>entity.id==='npc_lin')?.components.physical_state?.restrained_by).toBe('player');
    const released=executeAction(failed,{type:'RELEASE_CONTROL',target_id:'npc_lin',parameters:{}},randomUUID());
    expect(released.save.entities.find(entity=>entity.id==='npc_lin')?.components.physical_state?.restrained_by).toBeNull();
    expect(released.save.resolution_receipts?.at(-1)?.effects).toContain('state');
  });
  it('settles independent contact when an environmental injury condition is unknown, without inventing injury or an extra roll',()=>{
    const before=fixture(),environment={...proposal(),physical_action:{...proposal().physical_action,
      mechanism:'environment',hazard_source:null}};
    const turn=executeFreeform(before,input,environment,randomUUID(),rng([.95,.1]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt).toMatchObject({outcome:'partial_success',time_cost:1,
      physical_outcome:{contact:true,harmed:false,damage:0}});
    const history=turn.save.resolution_history!.at(-1)!;
    expect(history.rolls).toHaveLength(2);
    expect(history.stage_results).toMatchObject([{id:'contact',passed:true},{id:'harm',passed:false,blocked_reason:expect.any(String)}]);
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition?.hp).toBe(100);
    expect(turn.facts.join(' ')).toContain('不代表该环境已经确认安全');
    expect(validateSave(JSON.parse(JSON.stringify(turn.save))).resolution_history!.at(-1)).toEqual(history);
    expect(before.resolution_history??[]).toHaveLength(0);
    const indivisible={...environment,physical_action:{...environment.physical_action,injury_stage_id:'contact'}};
    expect(()=>executeFreeform(before,input,indivisible,randomUUID(),()=>{throw Error('must not roll');})).toThrow('不同阶段');
  });
  it.each([
    [[.95,.1,.1,.95],false],
    [[.95,.1,.95,.1],true],
  ] as const)('separates contact from sustained control across restraint stages: %j',(rolls,controlled)=>{
    const before=fixture(),requestId=randomUUID();
    const restraint={...proposal(),physical_action:{...proposal().physical_action,kind:'restrain',injury_stage_id:null},
      resolution:{...proposal().resolution,stages:[{id:'contact',band:'normal'},{id:'hold',band:'hard'}]}};
    const turn=executeFreeform(before,input,restraint,requestId,rng([...rolls]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    expect(receipt.physical_outcome).toMatchObject({contact:true,control_established:controlled,harmed:false});
    expect(turn.save.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state?.restrained_by).toBe(controlled?'player':null);
    expect(turn.save.runtime.time.minute-before.runtime.time.minute).toBe(1);
    expect(turn.save.resolution_receipts?.filter(entry=>entry.request_id===requestId)).toHaveLength(1);
    const reloaded=validateSave(JSON.parse(JSON.stringify(turn.save)));
    expect(reloaded.resolution_receipts!.at(-1)!.physical_outcome?.control_established).toBe(controlled);
    expect(canonicalResolutionNarrative(receipt,false).includes('控制住')).toBe(controlled);
    const legacy=structuredClone(receipt);delete legacy.physical_outcome!.control_established;
    expect(canonicalResolutionNarrative(legacy,false).includes('控制住')).toBe(controlled);
    if(!controlled)expect(()=>executeAction(reloaded,{type:'MOVE',target_id:'market',parameters:{}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true)).not.toThrow();
    expect(before.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state?.restrained_by??null).toBeNull();
  });
  it('records a present witness and gives victim and witness bounded independent responses without teleporting either',async()=>{
    const save=fixture();save.entities.find(entity=>entity.id==='npc_qiao')!.components.location={location_id:'square'};
    const req=randomUUID(),turn=executeFreeform(save,input,proposal(),req,rng([.1,.95]));
    let calls=0;const service={ai:{npcDecision:async(_p:unknown,context:{npc_id:string})=>{calls++;return decision(context.npc_id==='npc_lin');}}} as unknown as GameService;
    const reacted=await settlePhysicalNpcReactions(service,turn.save,req);
    expect(calls).toBe(2);
    expect(reacted.save.entities.find(entity=>entity.id==='npc_lin')!.components.location?.location_id).toBe('square');
    expect(reacted.save.npc_agent_state!.npc_qiao.memories.some(memory=>memory.event_ref===`physical:${req}`)).toBe(true);
    await settlePhysicalNpcReactions(service,reacted.save,req);expect(calls).toBe(2);
    const candidate=executeAction(reacted.save,{type:'WAIT',parameters:{minutes:6}},randomUUID()).save;
    const moved=(await settleAutonomousNpcTurn(service,candidate,reacted.save.runtime.time,randomUUID())).save;
    expect(moved.entities.find(entity=>entity.id==='npc_lin')!.components.location?.location_id).toBe('market');
    expect(moved.runtime.time).toEqual(candidate.runtime.time);
    expect(moved.resolution_receipts?.filter(receipt=>receipt.actor_id==='npc_lin'&&receipt.semantic_action==='MOVE')).toHaveLength(1);
  });
  it.each([[[.99,0],true],[[0,.99],false]] as const)('settles an NPC escape attempt with its own actor, dice and one shared interval: %j',(rolls,escaped)=>{
    const save=fixture(),npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.physical_state={awareness:'alert',alert_to_ids:['player'],restrained_by:'player'};
    const before=structuredClone(save),id=randomUUID();
    const result=executeAction(save,{type:'BREAK_FREE',target_id:'player',parameters:{}},id,'ai',rng([...rolls]),undefined,false,'npc_lin',true);
    const receipt=result.save.resolution_receipts!.at(-1)!;
    expect(receipt).toMatchObject({actor_id:'npc_lin',target_id:'player',semantic_action:'BREAK_FREE',time_cost:1});
    expect(result.save.resolution_history!.at(-1)!.spec.actor_id).toBe('npc_lin');
    expect(result.save.entities.find(entity=>entity.id==='npc_lin')!.components.physical_state?.restrained_by).toBe(escaped?null:'player');
    expect(result.save.runtime.time).toEqual(before.runtime.time);
    expect(result.save.entities.find(entity=>entity.id==='npc_lin')!.components.location).toEqual(npc.components.location);
    expect(result.save.entities.find(entity=>entity.id==='npc_lin')!.components.condition?.hp).toBe(100);
    expect(save).toEqual(before);
    expect(validateSave(JSON.parse(JSON.stringify(result.save))).resolution_receipts!.at(-1)).toEqual(receipt);
  });
  it('allows one decided escape reaction without extra world time, repeated decisions or invented movement',async()=>{
    const save=fixture(),req=randomUUID();
    const restraint={...proposal(),physical_action:{...proposal().physical_action,kind:'restrain',injury_stage_id:null},
      resolution:{...proposal().resolution,stages:[{id:'contact',band:'normal'}]}};
    const turn=executeFreeform(save,input,restraint,req,rng([.95,.1]));
    let calls=0;const service={ai:{npcDecision:async()=>{calls++;return {...decision(),kind:'proposed_action',
      proposed_action:{type:'BREAK_FREE',target_id:'player',reason:'尝试挣脱真实控制'}};}}} as unknown as GameService;
    const reacted=await settlePhysicalNpcReactions(service,turn.save,req);
    const escape=reacted.save.resolution_receipts!.filter(receipt=>receipt.semantic_action==='BREAK_FREE');
    expect(escape).toHaveLength(1);expect(calls).toBe(1);
    expect(reacted.save.runtime.time).toEqual(turn.save.runtime.time);
    expect(reacted.save.entities.find(entity=>entity.id==='npc_lin')!.components.location?.location_id).toBe('square');
    const repeated=await settlePhysicalNpcReactions(service,reacted.save,req);
    expect(calls).toBe(1);expect(repeated.save.resolution_receipts!.filter(receipt=>receipt.semantic_action==='BREAK_FREE')).toHaveLength(1);
  });
  it('does not let narration erase a committed injury or invent an uncommitted NPC departure',()=>{
    const save=fixture(),turn=executeFreeform(save,input,proposal(),randomUUID(),rng([.95,.1,.95,.1]));
    const receipt=turn.save.resolution_receipts!.at(-1)!;
    const prose={narrative:'林舟毫发无伤。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[]};
    expect(()=>validateResolvedNarrative(receipt,prose,false)).toThrow('否认');
    expect(()=>validateScenePresenceNarrative(save,'林舟收起东西。随后他跨过门槛，离开了这里。')).toThrow('权威位置');
    expect(()=>validateScenePresenceNarrative(save,'林舟准备离开，仍站在这里。')).not.toThrow();
    save.entities.find(entity=>entity.id==='npc_lin')!.components.location={location_id:'market'};
    expect(()=>validateScenePresenceNarrative(save,'林舟离开了这里。')).not.toThrow();
    expect(()=>validateScenePresenceNarrative(save,'林舟站在你面前。')).toThrow('不在');
    expect(npcPresentInView(publicView(save),'npc_lin')).toBe(false);
  });
  it('retains only the submitted result and restores physical state, memories and time with Undo',async()=>{
    class PendingMemoryStore extends MemoryStore{
      pending=new Map<string,PendingTurn>();
      async readPending(id:string){return structuredClone(this.pending.get(id)??null);}
      async writePending(turn:PendingTurn){this.pending.set(turn.request_id,structuredClone(turn));}
      async clearPending(id:string){this.pending.delete(id);}
    }
    const store=new PendingMemoryStore();let narratorCalls=0,reactionCalls=0;
    const ai=new AIRuntime({name:'fixture',generate:async request=>{
      if(request.role==='npc_decision'){reactionCalls++;return {data:decision()};}
      if(request.role==='narrator'){narratorCalls++;return {data:{narrative:'林舟毫发无伤。',speaker:null,dialogue:null,choices:[],patches:[]}};}
      throw Error('unexpected provider call');
    }});
    const service=new GameService(store,ai,demo);await store.write(fixture());
    const before=await service.current();
    // Resume an already rolled, uncommitted candidate through the production pending/commit path.
    const id=randomUUID(),candidate=executeFreeform(before,input,proposal(),id,rng([.95,.1,.95,.1]));
    await store.writePending({request_id:id,game_id:before.game_id,expected_revision:before.state_revision,
      fingerprint:createHash('sha256').update(JSON.stringify({input})).digest('hex'),
      candidate:candidate.save,action:candidate.action,facts:candidate.facts,generic:true});
    const req={game_id:before.game_id,expected_revision:before.state_revision,request_id:id,input};
    await service.turn(req);
    const after=await service.current();expect(after.npc_agent_state?.npc_lin.memories.length).toBeGreaterThan(0);
    expect(after.entities.find(entity=>entity.id==='npc_lin')?.components.condition?.hp).toBe(80);
    expect(after.last_turn?.narrative).toContain('伤害');expect(after.last_turn?.narrative).not.toContain('毫发无伤');
    expect(narratorCalls).toBe(3);expect(reactionCalls).toBe(1);
    expect(after.resolution_receipts?.filter(receipt=>receipt.request_id===id)).toHaveLength(1);
    await new GameService(store,ai,demo).turn(req);
    expect(narratorCalls).toBe(3);expect(reactionCalls).toBe(1);
    expect((await service.current()).runtime.time).toEqual(after.runtime.time);
    await service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    const undone=await service.current();expect(undone.runtime.time).toEqual(before.runtime.time);
    expect(undone.npc_agent_state).toEqual(before.npc_agent_state);
    expect(undone.entities).toEqual(before.entities);
  });
  it('gives a significant incident room for character-specific reactions while preserving the receipt facts',async()=>{
    const save=fixture(),turn=executeFreeform(save,input,proposal(),randomUUID(),rng([.1,.95]));
    let prompt='';const ai=new AIRuntime({name:'fixture',generate:async request=>{prompt=request.prompt;
      return {data:{narrative:'对方猛地收住话，警觉地盯着你。',speaker:null,dialogue:null,choices:[],patches:[]}};}});
    await ai.narrate(turn.save,turn.action,turn.facts,turn.save.resolution_receipts!.at(-1));
    expect(prompt).toContain('significant_incident');expect(prompt).toContain('stage_results');
    expect(prompt).toContain('不统一尖叫');expect(prompt).toContain('canonical_scene_membership');
  });
});
