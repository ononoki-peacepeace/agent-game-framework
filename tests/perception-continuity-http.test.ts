import {afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demo} from './helpers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {establishTransient,readPhysicalState} from '../src/core/perception-state.js';

/**
 * Isolated-HTTP acceptance for REV434→REV435: a bodily state recorded on an earlier turn
 * must survive the save round-trip and govern the next turn's adjudication, the NPC's own
 * reaction, and the presented narration — through the real /api/input path, not a unit call.
 *
 * Evidence level: isolated HTTP on a temp port and temp data directory with a stubbed
 * provider. NOT production 3100, NOT a real model, NOT human QA.
 *
 * Fixture labelling: the eyes-closed transient is seeded with the same authorized writer
 * the NPC decision path uses (`source:'npc_decision'`); that the decision path writes it is
 * covered separately by tests/perception-transient-continuity.test.ts. Dice are real.
 * The Narrator candidate below is written deliberately *wrong* — it is input under test,
 * never evidence of correct prose.
 */
const resources:{server:Server;directory:string}[]=[];
afterEach(async()=>{for(const {server,directory} of resources.splice(0)){
  await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
}});

describe('recorded bodily state governs the next HTTP turn',()=>{
  it('adjudicates, reacts and narrates against the state recorded on the previous turn',async()=>{
    const input='趁她闭着眼突然打击林舟',directory=await mkdtemp(join(tmpdir(),'agf-perception-http-'));
    const ai=new AIRuntime({name:'perception-continuity-reconstruction',generate:async request=>{
      const p=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(p.interaction_lane)return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
        answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
        interaction_lane:'world_transaction',player_speech_mode:'none',goal_spec:{objective:input,play_action:'interact',targets:[],
          desired_state:[],desired_outputs:[],constraints:[],persistence:'none',temporal:{at:null,recurrence:null},
          dependencies:[],world_mutation:true,external_artifact:false,multi_step:false,ambiguity:null}}} as never;
      if(p.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_ACTION',normalized_goal:input,operation_hint:'other',referent:'林舟',
        target_entities:['npc_lin'],depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'}}]}} as never;
      if(p.verdict)return {data:{verdict:'aligned',explanation:'保留本次尝试'}} as never;
      if(p.parameters_json)return {data:{type:'FREEFORM_ACTION',target_id:'npc_lin',parameters_json:'{}',clarification:null}} as never;
      throw Error('Unexpected reconstruction stage '+Object.keys(p).join(','));
    }});
    vi.spyOn(ai,'freeform').mockResolvedValue({narrative:'候选',minutes:1,target_id:'npc_lin',facts:[],relationship:null,
      physical_action:{kind:'harm',source_quote:input,contact_stage_id:'contact',injury_stage_id:'injury',harm_level:'minor',surprise_attempt:true},
      resolution:{type:'OPPOSED_CHECK',domain:'physique',opposition_domain:'agility',band:'normal',visibility:'public',stakes:'尝试',
        stages:[{id:'contact',band:'normal'},{id:'injury',band:'normal'}],evidence_ids:[]}} as never);
    // The NPC first reproduces REV435's fabricated observation, then corrects itself when
    // the contract tells it there was no sight. Both attempts must be visible in the count.
    const decisions:string[]=[];
    const npcDecision=vi.spyOn(ai,'npcDecision').mockImplementation(async()=>{
      const speech=decisions.length===0?'刚才那一记，我看得很清楚。':'我没有看见，只感觉到有人撞上来。';
      decisions.push(speech);
      return {kind:'speech',speech,vote_target:null,intent:'回应亲历的事件',proposed_action:null,evidence_refs:[],
        belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'回应亲历事件',
        social_response:null} as never;
    });
    // A Narrator candidate that presents the committed reaction correctly but attributes the
    // observation to the sightless NPC. Everything else is in order, so perception is the
    // only check that can reject it.
    const corrected='我没有看见，只感觉到有人撞上来。';
    const narrator=vi.spyOn(ai,'narrate').mockResolvedValue({narrative:'林舟看得很清楚，却没能躲开。',
      speaker:'npc_lin',dialogue:corrected,scene_beats:[{kind:'narration',text:'林舟看得很清楚，却没能躲开。'},
        {kind:'speech',speaker_id:'npc_lin',utterance:corrected}],
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],
      stable_locations:[],mechanical_claims:[]} as never);

    const store=new JsonStore(directory),world=structuredClone(demo);world.events=[];
    const seeded=newSave(world);
    const player=seeded.entities.find(entity=>entity.id===seeded.player_state.entity_id)!;
    const npc=seeded.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.location={location_id:String(player.components.location?.location_id)};
    player.components.scene_position={label:'桌旁'};npc.components.scene_position={label:'桌旁'};
    npc.components.condition={hp:100,stamina:100,stress:0};
    establishTransient(seeded,'npc_lin',{kind:'eyes',value:'closed',statement:'应对方请求闭眼等待',
      source:'npc_decision',source_ref:'social:previous-turn',release_condition:'对方开口说话'});
    await store.write(validateSave(seeded));
    const service=new GameService(store,ai,demo),before=await service.current();
    // The recorded state is what a reloaded save actually carries, not in-memory residue.
    expect(readPhysicalState((await store.read())!.entities.find(entity=>entity.id==='npc_lin')).eyes).toBe('closed');

    const server=createApp(service).listen(0,'127.0.0.1');resources.push({server,directory});await once(server,'listening');
    const port=(server.address() as {port:number}).port;expect([3100,3101]).not.toContain(port);
    const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json() as {token:string};
    const body={input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision};
    const post=()=>fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
      body:JSON.stringify(body)});
    const response=await post(),result=await response.json() as any;
    expect(response.status,JSON.stringify(result)).toBe(200);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});

    const after=(await store.read())!;
    // The plan step owns its own action id, so the receipt is located through the outcome.
    const receiptId=result.outcome.receipt_ids?.[0] as string;
    const receipt=after.resolution_receipts!.find(item=>item.request_id===receiptId)!;
    expect(receipt,JSON.stringify(result.outcome)).toBeDefined();
    expect(receipt.actor_id).toBe(after.player_state.entity_id);
    // 1. Settlement recorded who had no sight, so the fact is recoverable afterwards.
    expect(receipt.physical_outcome?.sight_blocked_ids).toEqual(['npc_lin']);
    expect(receipt.canonical_facts.join(' ')).toContain('没有看见动作过程');
    // 2. Adjudication used the recorded state instead of rolling a bare coin flip.
    const check=after.resolution_history!.find(entry=>entry.check_id===receipt.check_id)!;
    const modifiers=(check.spec as {circumstance_modifiers?:{side:string;amount:number;reason:string}[]}).circumstance_modifiers;
    expect(modifiers,JSON.stringify(check.spec)).toBeDefined();
    expect(modifiers!.map(item=>item.reason).join(' ')).toContain('无视觉状态');
    expect(modifiers!.every(item=>item.side==='actor')).toBe(true);
    // The locked spec is what the roll was actually resolved against.
    expect(check.spec.actor_modifier).toBe(modifiers!.reduce((sum,item)=>sum+item.amount,0));
    // 3. The NPC's fabricated observation was rejected and repaired, not dropped.
    expect(npcDecision).toHaveBeenCalledTimes(2);
    expect(receipt.canonical_facts.join(' ')).not.toContain('看得很清楚');
    expect(JSON.stringify(after)).not.toContain('看得很清楚');
    // 4. Presentation degraded with a reason that names the failing check, and the
    //    ungrounded prose never reached the player.
    expect(result.view.last_turn.presentation).toMatchObject({status:'degraded'});
    expect(result.view.last_turn.presentation.reasons.join(' ')).toContain('perception');
    expect(result.message).not.toContain('看得很清楚');
    expect(result.view.notices.join('')).toContain('降级');
    // 5. A presentation failure did not roll back or re-run the settled world outcome.
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(receipt.commit_status).toBe('committed');
    expect(publicView(validateSave(JSON.parse(JSON.stringify(after)))).last_turn).toEqual(result.view.last_turn);
    // 6. The forced event ended the voluntary eyes-closed state exactly once.
    expect(readPhysicalState(after.entities.find(entity=>entity.id==='npc_lin')).eyes).toBe('open');
    // 7. Replaying the same request_id changes nothing and re-runs no model stage.
    const narratorCalls=narrator.mock.calls.length;
    expect((await post()).status).toBe(200);
    expect(await store.read()).toEqual(after);
    expect(narrator.mock.calls.length).toBe(narratorCalls);
    expect(npcDecision).toHaveBeenCalledTimes(2);
  });
});
