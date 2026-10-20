import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {reconcileDuplicateActivePlans} from '../src/core/pending-repair.js';
import {validateSave} from '../src/core/state.js';
import {npcAgentStateSchema} from '../src/agent/npc-state.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {fresh} from './helpers.js';
import {sparseWorld} from './sparse-fixture.js';

const directories:string[]=[];
afterEach(async()=>{
  for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});
});

function goal(id:string){
  return {id,description:'离开这里',horizon:'short' as const,status:'active' as const,origin:`physical:${id}`,priority:10};
}
function plan(id:string,credit:number,source:string,destination='station'){
  return {id,goal_id:id,intention:'离开这里',status:'active' as const,
    activity:{kind:'move' as const,origin_location_id:'square',destination_id:destination,
      source_request_id:source,condition:null,last_accounted_at:{day:1,minute:0},time_credit_minutes:credit}};
}
function npcState(goals:ReturnType<typeof goal>[],plans:ReturnType<typeof plan>[]){
  return npcAgentStateSchema.parse({goals,plans});
}

describe('reconcileDuplicateActivePlans',()=>{
  it('drops exact same-route duplicates, keeping earned time credit',()=>{
    const save=fresh();
    save.npc_agent_state={npc_lin:npcState([goal('old'),goal('new')],[plan('old',1,'r_old'),plan('new',0,'r_new')])};
    expect(()=>validateSave(save)).toThrow();
    const result=reconcileDuplicateActivePlans(save,'r_new');
    expect(result.repaired).toBe(true);
    const plans=result.save.npc_agent_state!.npc_lin.plans;
    expect(plans.filter(p=>p.status==='active'&&(p.activity||p.execution))).toHaveLength(1);
    expect(plans.find(p=>p.status==='active'&&p.activity)?.id).toBe('old');
    expect(plans.map(p=>p.id).sort()).toEqual(['old']);
    expect(result.save.npc_agent_state!.npc_lin.goals.map(g=>g.id).sort()).toEqual(['old']);
    expect(()=>validateSave(result.save)).not.toThrow();
  });
  it('prefers dropping the current-request plan on equal credit',()=>{
    const save=fresh();
    save.npc_agent_state={npc_lin:npcState([goal('old'),goal('new')],[plan('old',0,'r_old'),plan('new',0,'r_new')])};
    const result=reconcileDuplicateActivePlans(save,'r_new');
    expect(result.repaired).toBe(true);
    expect(result.save.npc_agent_state!.npc_lin.plans.find(p=>p.status==='active')?.id).toBe('old');
  });
  it('refuses genuinely different destinations',()=>{
    const save=fresh();
    save.npc_agent_state={npc_lin:npcState([goal('a'),goal('b')],[plan('a',0,'r_a'),plan('b',0,'r_b','market')])};
    const result=reconcileDuplicateActivePlans(save,'r_b');
    expect(result.repaired).toBe(false);
    expect(()=>validateSave(result.save)).toThrow();
  });
  it('is idempotent',()=>{
    const save=fresh();
    save.npc_agent_state={npc_lin:npcState([goal('old'),goal('new')],[plan('old',1,'r_old'),plan('new',0,'r_new')])};
    const once=reconcileDuplicateActivePlans(save,'r_new');
    const twice=reconcileDuplicateActivePlans(once.save,'r_new');
    expect(twice.repaired).toBe(false);
    expect(twice.save).toEqual(once.save);
  });
});

describe('bad pending recovery through the service',()=>{
  it('repairs an invalid pending candidate deterministically, commits once and clears it',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-pending-repair-'));directories.push(directory);
    const ai=new AIRuntime({name:'pending-repair-fixture',generate:async request=>{
      if(request.role==='narrator')return {data:{narrative:'你查看了四周。',speaker:null,dialogue:null,choices:[],
        context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],
        mechanical_claims:[],presence_claims:[]}} as never;
      throw Error('unexpected provider call: '+request.role);
    }});
    const store=new JsonStore(directory),service=new GameService(store,ai,sparseWorld());
    await service.newGame();
    const current=await service.current();
    const candidate=structuredClone(current);
    candidate.npc_agent_state={...(candidate.npc_agent_state??{}),
      npc_lin:npcState([goal('old'),goal('new')],[plan('old',1,'r_old'),plan('new',0,'r_new')])};
    const rawAction={type:'INSPECT',parameters:{focus:'四周'}};
    const action={...rawAction,id:randomUUID(),actor_id:current.player_state.entity_id,
      source:'player' as const,time_cost:0};
    const request_id=randomUUID();
    const fingerprint=createHash('sha256').update(JSON.stringify({action:rawAction})).digest('hex');
    await store.writePending({game_id:current.game_id,request_id,fingerprint,
      expected_revision:current.state_revision,candidate,action,facts:[],generic:false});
    const view=await service.turn({request_id,game_id:current.game_id,expected_revision:current.state_revision,action:rawAction},
      undefined,undefined,undefined,true);
    const after=await service.current();
    expect(after.state_revision).toBe(current.state_revision+1);
    const plans=after.npc_agent_state!.npc_lin.plans;
    expect(plans.filter(p=>p.status==='active'&&(p.activity||p.execution))).toHaveLength(1);
    expect(plans.find(p=>p.status==='active'&&p.activity)?.id).toBe('old');
    expect(await store.readPending(request_id)).toBeNull();
    expect(view.revision).toBe(after.state_revision);
  });
});
