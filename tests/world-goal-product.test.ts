import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { SavePackage } from '../src/core/schema.js';
import { sparseSetup } from './sparse-fixture.js';

async function runGoal(input:string,select:(save:SavePackage)=>string){
  let candidate='';
  const fixture=await sparseSetup(async request=>{
    const properties=(request.schema as any).properties??{};
    if(properties.destination)return {data:{destination:'WORLD_INTENT',confidence:1,clarification:null,speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false}};
    if(properties.goals)return {data:{goals:[{goal_id:'g1',type:'WORLD_GOAL',normalized_goal:input,depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]}};
    if(properties.candidate_id)return {data:{candidate_id:candidate,reason:'fixture selects one supplied canonical affordance',ambiguity:null}};
    if(request.role==='narrator')return {data:{narrative:'你采取了当前世界允许的第一步。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null}};
    throw new Error('unexpected fixture request');
  });
  const save=await fixture.service.current();candidate=select(save);await fixture.service.storage.write(save);
  const directory=await mkdtemp(join(tmpdir(),'agf-world-goal-product-'));
  const server=createApp(fixture.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base='http://127.0.0.1:'+(server.address() as any).port,token=(await(await fetch(base+'/api/session')).json()).token;
    const before=await fixture.service.current();
    const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
    const result:any=await response.json();expect(response.ok,JSON.stringify(result)).toBe(true);
    return {fixture,before,after:await fixture.service.current(),result};
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
}

it('open-ended goals discover declared affordances and execute a real first stage',async()=>{
  const sleep=await runGoal('找地方睡觉',()=> 'activity:sleep');
  expect(sleep.result).toMatchObject({intent:'WORLD_GOAL',plan:{status:'completed'}});
  expect(sleep.result.message).not.toContain('已记下');
  expect(sleep.after.runtime.time.minute).toBeGreaterThan(sleep.before.runtime.time.minute);
  expect(Number(sleep.after.entities.find(entity=>entity.id===sleep.after.player_state.entity_id)!.components.condition?.stamina)).toBeGreaterThan(Number(sleep.before.entities.find(entity=>entity.id===sleep.before.player_state.entity_id)!.components.condition?.stamina));

  const work=await runGoal('想办法挣钱',()=> 'activity:work');
  expect(work.result).toMatchObject({intent:'WORLD_GOAL',plan:{status:'completed'}});
  expect(work.after.state_revision).toBeGreaterThan(work.before.state_revision);
  expect(work.after.runtime.time.minute).toBeGreaterThan(work.before.runtime.time.minute);
  expect(work.result.message).toContain('先沿已知路线');

  const inquiry=await runGoal('找人打听最近的消息',save=>{
    const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    npc.components.location={location_id:String(player.components.location?.location_id)};
    return 'talk:'+npc.id;
  });
  expect(inquiry.result).toMatchObject({intent:'WORLD_GOAL',plan:{status:'completed'}});
  expect(inquiry.after.state_revision).toBeGreaterThan(inquiry.before.state_revision);
  expect(inquiry.after.runtime.time.minute).toBeGreaterThan(inquiry.before.runtime.time.minute);
  expect(inquiry.after.last_turn?.narrative).toBeTruthy();
},60_000);
