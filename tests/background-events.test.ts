import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {demo} from './helpers.js';
import {newSave,publicView,validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import type {SavePackage,WorldPackage} from '../src/core/schema.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {sparsePlan,sparseWorld} from './sparse-fixture.js';
import {sparseStep} from '../src/routine/scheduler.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {reviewWorldNovelty} from '../src/world/novelty.js';
import {readFile} from 'node:fs/promises';
import {readProfile} from '../src/ai/profiles.js';

const now=(save:SavePackage)=>save.runtime.time.day*save.definition.ruleset.minutes_per_day+save.runtime.time.minute;
const time=(day:number,minute:number)=>({day,minute});
function world():WorldPackage{
 const w=structuredClone(demo),npc=w.entities.find(entity=>entity.id!==w.player.entity_id&&entity.components.character)!;
 w.events=[];w.runtime.time=time(1,540);
 w.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:60,replenishment:true};
 w.background_incidents=[{
   id:'campus_incident',title:'校园背景事件',summary:'测试用、与玩家选择无关的事件',source:'WORLD_PACKAGE',
   created_at:time(1,540),earliest_activation:time(2,600),latest_activation:time(3,600),
   activation_flags:[],activation_chance:1,participants:[npc.id],locations:['station'],
   stages:[
     {id:'onset',earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:npc.id,
       effects:[{kind:'set_flag',flag:'incident_started'},{kind:'npc_unavailable',npc_id:npc.id,value:true}],
       exposures:[{id:'onset_seen',channel:'same_location',location_id:'station',npc_id:null,text:'学校里有人缺席了。',interrupt:true,open_loop_label:'缺席缘由'}],terminal:'none'},
     {id:'developing',earliest_after_minutes:1440,latest_after_minutes:null,required_flags:[],actor_id:npc.id,
       effects:[{kind:'set_flag',flag:'notice_posted'}],
       exposures:[{id:'notice',channel:'public_notice',location_id:'station',npc_id:null,text:'公告栏上出现一则缺席通知。',interrupt:true,open_loop_label:null}],terminal:'none'},
     {id:'escalated',earliest_after_minutes:2880,latest_after_minutes:null,required_flags:[],actor_id:npc.id,
       effects:[{kind:'add_marker',npc_id:npc.id,marker:'background_followup'}],exposures:[],terminal:'none'},
     {id:'aftermath',earliest_after_minutes:8640,latest_after_minutes:null,required_flags:[],actor_id:npc.id,
       effects:[{kind:'set_flag',flag:'incident_closed'},{kind:'npc_unavailable',npc_id:npc.id,value:false}],
       exposures:[],terminal:'resolved'},
   ],
 }];
 return w;
}
function wait(save:SavePackage,minutes:number){
 return executeAction(save,{type:'WAIT',parameters:{minutes}},randomUUID(),'player',()=>0.25).save;
}
function advanceTo(initial:SavePackage,target:{day:number;minute:number}){
 let save=initial,targetMinute=target.day*save.definition.ruleset.minutes_per_day+target.minute;
 while(now(save)<targetMinute)save=wait(save,Math.min(targetMinute-now(save),save.definition.ruleset.max_wait_minutes));
 return save;
}
describe('Background World Event Simulation v0.1',()=>{
 it('A/B: activates through ordinary WAIT and advances while the player is elsewhere',()=>{
   let save=advanceTo(newSave(world()),time(2,600));
   expect(save.background_state?.incidents[0]).toMatchObject({status:'active',stage_index:0,player_exposed:false});
   expect(save.gm_state.flags.incident_started).toBe(true);
   expect(save.background_state?.npc_status[world().background_incidents![0].participants[0]].unavailable).toBe(true);
   save=advanceTo(save,time(3,600));
   expect(save.background_state?.incidents[0]).toMatchObject({stage_index:1,player_exposed:false});
   expect(save.gm_state.flags.notice_posted).toBe(true);
   expect(save.background_state?.exposure_log).toHaveLength(0);
 });
 it('C and acceptance: a normal school visit exposes a previous background event once, without creating it',()=>{
   let save=advanceTo(newSave(world()),time(3,600));
   expect(save.background_state?.incidents[0].stage_index).toBe(1);
   expect(save.narrative_state?.arcs).toHaveLength(0);
   const move=executeAction(save,{type:'MOVE',target_id:'station'},randomUUID(),'player',()=>0.25);
   save=move.save;
   expect(save.background_state?.incidents[0].player_exposed).toBe(true);
   expect(save.background_state?.exposure_log.map(entry=>entry.channel)).toContain('public_notice');
   expect(move.facts.join(' ')).toContain('缺席通知');
   expect(save.narrative_state?.arcs.length).toBeGreaterThan(0);
   const before=save.background_state!.exposure_log.length;
   save=wait(save,10);expect(save.background_state?.exposure_log).toHaveLength(before);
   expect(JSON.stringify(publicView(save))).not.toContain('background_incidents');
 });
 it('D: an important exposure during an ordinary course safely interrupts Routine',async()=>{
   const w=sparseWorld(),npc=w.entities.find(entity=>entity.id!==w.player.entity_id&&entity.components.character)!;
   w.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:false};
   const seed=structuredClone(world().background_incidents![0]);seed.participants=[npc.id];seed.earliest_activation=time(1,600);
   seed.stages=seed.stages.slice(0,1);seed.stages[0].terminal='resolved';
   seed.stages[0].effects=[];w.background_incidents=[seed];
   const save=newSave(w),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
   save.runtime.time=time(1,540);player.components.location={location_id:'station'};
   player.components.routine={...player.components.routine,active:true,enabled:true,status:'running',plan:sparsePlan};
   const ai=new AIRuntime({name:'unused',generate:async()=>{throw Error('ordinary course must not call AI');}});
   const after=await sparseStep(save,ai,1440+720);
   expect(after.background_state?.incidents[0].status).toBe('resolved');
   expect(after.background_state?.incidents[0].player_exposed).toBe(true);
   expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.routine.interrupted).toBe(true);
   expect(after.last_turn?.narrative).toContain('学校里有人缺席了');
 });
 it('E: an unattended case resolves without pulling the player into it; exhausted pool requests generation only',()=>{
   let save=advanceTo(newSave(world()),time(8,600));
   expect(save.background_state?.incidents[0]).toMatchObject({status:'resolved',stage_index:3,missed:true,player_exposed:false});
   expect(save.gm_state.flags.incident_closed).toBe(true);
   expect(save.background_state?.exposure_log).toHaveLength(0);
   save=advanceTo(save,time(8,661));
   expect(save.background_state?.needs_generation).toBe(true);
   expect(save.background_state?.incidents).toHaveLength(1);
 });
 it('F: manual WAIT and a local Routine course enter the same evaluator',async()=>{
   const w=sparseWorld(),seed=structuredClone(world().background_incidents![0]);
   seed.participants=[w.entities.find(entity=>entity.id!==w.player.entity_id&&entity.components.character)!.id];
   seed.earliest_activation=time(1,600);seed.stages=seed.stages.slice(0,1);seed.stages[0].terminal='resolved';seed.stages[0].exposures=[];
   w.background_event_policy={enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:0,replenishment:false};
   w.background_incidents=[seed];w.runtime.time=time(1,540);
   const initial=newSave(w),player=initial.entities.find(entity=>entity.id===initial.player_state.entity_id)!;
   player.components.location={location_id:'station'};
   const manual=advanceTo(structuredClone(initial),time(1,720));
   const routineInput=structuredClone(initial),routinePlayer=routineInput.entities.find(entity=>entity.id===routineInput.player_state.entity_id)!;
   routinePlayer.components.routine={...routinePlayer.components.routine,active:true,enabled:true,status:'running',plan:sparsePlan};
   const ai=new AIRuntime({name:'unused',generate:async()=>{throw Error('local course must not call AI');}});
   const routine=await sparseStep(routineInput,ai,1440+720,undefined,undefined,()=>0.25);
   expect(routine.background_state?.incidents).toEqual(manual.background_state?.incidents);
   expect(routine.background_state?.event_log).toEqual(manual.background_state?.event_log);
   expect(routine.gm_state.flags.incident_started).toBe(manual.gm_state.flags.incident_started);
 });
 it('G/H: a failed transition cannot rewrite HARD truth or partially apply stage effects',()=>{
   const initial=newSave(world()),truth=structuredClone(initial.gm_state.hidden_truth);
   const corrupted=structuredClone(initial);
   corrupted.definition.background_incidents![0].stages[0].effects.push({kind:'move_npc',npc_id:corrupted.definition.background_incidents![0].participants[0],location_id:'nonexistent'});
   expect(()=>advanceTo(corrupted,time(2,600))).toThrow();
   expect(corrupted.background_state?.incidents[0].status).toBe('dormant');
   expect(corrupted.gm_state.flags.incident_started).toBeUndefined();
   const successful=advanceTo(initial,time(2,600));
   expect(successful.gm_state.hidden_truth).toEqual(truth);
 });
 it('I: older saves without background fields remain valid and receive no fabricated cases',()=>{
   const old=newSave(demo);delete old.background_state;delete old.definition.background_incidents;delete old.definition.background_event_policy;
   expect(validateSave(old).background_state).toBeUndefined();
   expect(wait(old,30).background_state).toBeUndefined();
 });
 it('initializer schema, compiler and Save preserve generated seeds',()=>{
   const seed=structuredClone(world().background_incidents![0]);seed.source='WORLD_CREATION';
   const blueprint=worldInitializationSchema.parse({
     id:'campus_fixture',title:'测试校园',description:'独立验收世界',modules:['map','characters','routine'],
     currency:{id:'yen',name:'元'},player:{id:'player',name:'玩家',description:'学生',location_id:'square',cash:0},
     locations:[{id:'square',name:'住处',description:'',parent_id:null,kind:'poi',map_level:0,known_by_default:true},{id:'station',name:'学校',description:'',parent_id:null,kind:'poi',map_level:0,known_by_default:true}],
     routes:[{from:'square',to:'station',travel_minutes:10},{from:'station',to:'square',travel_minutes:10}],
     characters:[{id:seed.participants[0],name:'角色甲',description:'',location_id:'station',role:'student'}],
     items:null,shop:null,hidden_notes:'',hidden_truths:[],background_incidents:[seed],opening:'开学了。',
   });
   const compiled=compileWorld(blueprint,demo.prompt_profile),save=newSave(compiled);
   expect(compiled.background_incidents).toHaveLength(1);
   expect(save.background_state?.incidents[0].status).toBe('dormant');
   expect(save.definition.background_incidents?.[0].stages).toHaveLength(4);
 });
 it('Macro Arc is optional, causal, and tracks only its linked incident',()=>{
   const ordinary=world();
   expect(newSave(ordinary).background_state?.macro_arcs).toEqual([]);
   const npc=ordinary.background_incidents![0].participants[0];
   ordinary.world_macro_arcs=[{
     id:'school_pressure',title:'学区调整的长期压力',summary:'不同人的安排逐渐相互影响',
     underlying_pressure:'校区即将合并',actor_motivations:[{actor_id:npc,motivation:'维持学生支持项目'}],
     resource_constraint:'教师与场地不足',historical_cause:'过去的资源分配留下缺口',
     social_relationship:'教师与家庭有不同优先事项',trigger:'合并日程公布',
     unintended_consequence:'原本独立的缺席与转学决定被外界误读',truth_refs:[],
     incident_refs:['campus_incident'],horizon:'long',
   }];
   let save=newSave(ordinary);
   expect(save.background_state?.macro_arcs[0]).toMatchObject({status:'latent',last_event_ref:null});
   save=advanceTo(save,time(2,600));
   expect(save.background_state?.macro_arcs[0].status).toBe('developing');
   expect(save.background_state?.macro_arcs[0].last_event_ref).toBeTruthy();
   save=advanceTo(save,time(8,600));
   expect(save.background_state?.macro_arcs[0].status).toBe('resolved');
   expect(JSON.stringify(publicView(save))).not.toContain('school_pressure');
 });
 it('novelty gate detects repeated, player-centric and single-source candidates without requiring a villain',()=>{
   const a=structuredClone(world().background_incidents![0]);
   a.causal_basis={underlying_pressure:'校区合并',actor_motivation:'留住学习支持',resource_constraint:'人手不足',
     historical_cause:'旧制度未更新',social_relationship:'师生互相依赖',trigger:'通知发布',unintended_consequence:'一些行动被误读'};
   const benign={player:{id:'player'},background_incidents:[a]};
   expect(reviewWorldNovelty(benign)).toEqual([]);
   const duplicate={...a,id:'second_incident',title:a.title,summary:a.summary};
   expect(reviewWorldNovelty({...benign,background_incidents:[a,duplicate]}).map(issue=>issue.kind)).toContain('repetition');
   const playerCentric={...a,participants:[...a.participants,'player']};
   expect(reviewWorldNovelty({...benign,background_incidents:[playerCentric]}).map(issue=>issue.kind)).toContain('player_centricity');
   const trope={...a,title:'学生会长是幕后黑手'};
   expect(reviewWorldNovelty({...benign,background_incidents:[trope]}).map(issue=>issue.kind)).toContain('trope_similarity');
 });
 it('initializer revises a clichéd candidate before committing a World Package',async()=>{
   const blueprint=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
   const seed=structuredClone(world().background_incidents![0]);
   seed.participants=['npc_lin'];seed.locations=['station'];seed.stages.forEach(stage=>{stage.actor_id='npc_lin';
     stage.effects.forEach(effect=>{if('npc_id' in effect)effect.npc_id='npc_lin';});
     stage.exposures.forEach(exposure=>{exposure.npc_id=null;exposure.location_id='station';});});
   seed.causal_basis={underlying_pressure:'通勤线路调整',actor_motivation:'维持居民沟通',resource_constraint:'公告时段有限',
     historical_cause:'过去的河岸维修',social_relationship:'志愿者与居民的信任',trigger:'新时刻表公布',unintended_consequence:'缺席消息被误解'};
   const bad={...seed,title:'学生会长是幕后黑手'};
   let calls=0;
   const runtime=new AIRuntime({name:'controlled',generate:async()=>({data:{...blueprint,background_incidents:[calls++===0?bad:seed],world_macro_arcs:[]}})});
   const save=await runtime.initialize('一个长期社区事件世界',await readProfile('content/profiles/default.json'));
   expect(calls).toBe(2);
   expect(save.definition.background_incidents?.[0].title).toBe(seed.title);
   expect(save.background_state?.incidents[0].status).toBe('dormant');
   expect(save.definition.world_macro_arcs).toBeUndefined();
 });
 it('acceptance: ordinary days let an incident start, become visible on a normal visit, and end without investigation',()=>{
   let save=newSave(world());
   save=advanceTo(save,time(2,600));
   expect(save.background_state?.incidents[0]).toMatchObject({status:'active',stage_index:0,player_exposed:false});
   save=advanceTo(save,time(3,600));
   expect(save.gm_state.flags.notice_posted).toBe(true);
   expect(save.background_state?.incidents[0].player_exposed).toBe(false);
   save=executeAction(save,{type:'MOVE',target_id:'station'},randomUUID(),'player',()=>0.25).save;
   expect(save.background_state?.incidents[0].player_exposed).toBe(true);
   expect(save.background_state?.exposure_log).toHaveLength(2);
   save=advanceTo(save,time(8,600));
   expect(save.background_state?.incidents[0].status).toBe('resolved');
   expect(save.gm_state.flags.incident_closed).toBe(true);
 });
});
