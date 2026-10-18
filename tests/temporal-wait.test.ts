import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseTemporalWait} from '../src/agent/temporal-wait.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {validatePlan} from '../src/agent/planner.js';
import {sparseSetup} from './sparse-fixture.js';

const semantic={kind:'world_action',interaction_lane:'open_goal'} as const;
async function setup(minute=623){
  const f=await sparseSetup(async request=>{
    if(request.role==='narrator')return {data:{narrative:'灯光和街上的人影随时间渐渐变化。',
      speaker:null,dialogue:null,choices:[],patches:[]}};
    throw Error(`Unexpected model call: ${request.role}`);
  });
  const save=await f.service.current();save.runtime.time={day:1,minute};
  await f.store.write(save);
  const run=async(input:string)=>{
    const before=await f.service.current();
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision,input},undefined,null,false,semantic as never);
    return {before,after:await f.service.current(),result};
  };
  return {...f,run};
}

describe('one foreground temporal WAIT',()=>{
  it('resolves 10:23 to 22:00 in one action and one authoritative receipt',async()=>{
    const f=await setup();const {before,after,result}=await f.run('我一直等到晚上十点。');
    expect(after.runtime.time).toEqual({day:1,minute:1320});
    expect(after.state_revision).toBe(before.state_revision+1);
    const receipts=after.resolution_receipts?.filter(r=>r.commit_status==='committed'&&r.semantic_action==='WAIT')??[];
    expect(receipts).toHaveLength(1);
    expect(after.runtime.receipts.length-before.runtime.receipts.length).toBe(1);
    expect(result).toMatchObject({time_advanced:697,outcome:{type:'game',kind:'completed'}});
    expect(result.message).not.toMatch(/已完成等待\d+分钟|simulation tick/);
  });
  it('resolves explicit duration and vague short wait separately',async()=>{
    const f=await setup();
    const duration=await f.run('等两个小时');
    expect(duration.after.runtime.time).toEqual({day:1,minute:743});
    const vague=await f.run('等一会儿');
    expect(vague.after.runtime.time).toEqual({day:1,minute:748});
    expect(vague.after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')).toHaveLength(2);
  });
  it('rolls a past clock target to the next day without moving time backwards',async()=>{
    const f=await setup(1410);
    const {after,result}=await f.run('等到早上八点');
    expect(after.runtime.time).toEqual({day:2,minute:480});
    expect(result.time_advanced).toBe(510);
  });
  it('settles ordinary background time changes without interrupting or resuming an old goal',async()=>{
    const f=await setup();const save=await f.service.current();
    save.definition.events.push({id:'background_open',hook:'on_time_advance',location_id:null,
      probability:1,once:true,public_text:'商店开门了。',set_flag:'shop_opened',interrupt_automation:false});
    save.definition.events.push({id:'npc_schedule',hook:'on_time_advance',location_id:null,
      probability:1,once:true,public_text:'NPC 下班了。',set_flag:null,interrupt_automation:false});
    const plan=validatePlan({goals:[{goal_id:'old_goal',type:'WORLD_GOAL',normalized_goal:'继续之前的事',
      depends_on:[],condition:null,branch:null,temporal_scope:{scope:'now',day_offset:0,window:'any'},target_entities:[]}]});
    plan.status='waiting_for_player';plan.goals[0].status='waiting_for_player';
    save.active_goal={plan,waiting_question:'接下来怎么办？',options:[]};
    await f.store.write(save);
    const {after,result}=await f.run('等到晚上十点');
    expect(after.runtime.time).toEqual({day:1,minute:1320});
    expect(after.gm_state.flags.shop_opened).toBe(true);
    expect(after.event_state.fired).toContain('npc_schedule');
    expect(after.active_goal?.plan.plan_id).toBe(plan.plan_id);
    expect(result.outcome).toMatchObject({kind:'completed'});
  });
  it('interrupts one WAIT only for an event marked as requiring a player response',async()=>{
    const f=await setup();const save=await f.service.current();
    save.definition.events.push({id:'direct_contact',hook:'on_time_advance',location_id:null,
      probability:1,once:true,public_text:'有人当面要求你回应。',set_flag:null,interrupt_automation:true});
    await f.store.write(save);
    const {after,result}=await f.run('等到晚上十点');
    expect(after.runtime.time.minute).toBeLessThan(1320);
    expect(after.foreground?.blocker).toBe('interrupt');
    expect(result.outcome).toMatchObject({kind:'interrupted',goal_status:'partial'});
    expect(result.message).toContain('打断');
    expect(after.resolution_receipts?.filter(r=>r.semantic_action==='WAIT')).toHaveLength(1);
  });
});

describe('temporal wait admission',()=>{
  it('keeps compound requests with later actions on the planner path',()=>{
    expect(parseTemporalWait('等到晚上十点再去挨家问',{day:1,minute:623})).toBeNull();
    expect(parseTemporalWait('等到中午',{day:1,minute:623})?.target).toEqual({day:1,minute:720});
    expect(parseTemporalWait('待到22点',{day:1,minute:623})?.minutes).toBe(697);
    expect(parseTemporalWait('在这里待三个小时',{day:1,minute:623})?.minutes).toBe(180);
    expect(parseTemporalWait('等半小时',{day:1,minute:623})?.minutes).toBe(30);
    expect(parseTemporalWait('稍微等等',{day:1,minute:623})?.minutes).toBe(5);
  });
});
