import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {AIRuntime} from '../src/ai/runtime.js';
import {selectDefaultExemplars} from '../src/ai/guidance.js';
import {fresh} from './helpers.js';

const prose=(narrative:string)=>({narrative,speaker:null,dialogue:null,choices:[],context_actions:[],
  patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});

function pendingSave(){
  const save=fresh();
  save.active_goal={plan:{plan_id:'pending-plan',status:'waiting_for_player',contract:{original_intent:'买一杯咖啡'},
    goals:[{goal_id:'buy-coffee',normalized_goal:'买一杯咖啡',status:'waiting_for_player',
      result:{summary:'等待玩家选择商品'}}]},waiting_question:'选择哪种咖啡？',options:[]} as never;
  save.narrative_history=[{request_id:randomUUID(),narrative:'你到了柜台；买咖啡这件事还停在原地，没有动。',
    speaker:null,dialogue:null,facts:[]}];
  return save;
}

async function narratorRequest(narrative:string){
  const prompts:string[]=[];
  const threadIds:(string|undefined)[]=[];
  const ai=new AIRuntime({name:'scripted',generate:async request=>{
    expect(request.role).toBe('narrator');prompts.push(request.prompt);threadIds.push(request.threadId);
    return {data:prose(narrative),threadId:'provider-thread'};
  }});
  const save=pendingSave(),prior=structuredClone(save.active_goal);
  save.ai.threads.narrator='old-accumulated-thread';
  const result=await ai.narrate(save,{type:'WAIT',actor_id:save.player_state.entity_id,
    parameters:{minutes:1}} as never,['等待了一分钟。']);
  const payload=JSON.parse(prompts[0]!.split('\n\n').at(-1)!);
  return {save,prior,result,prompt:prompts[0]!,payload,threadIds};
}

describe('Narrator pending-goal focus',()=>{
  it('keeps the unresolved goal for the Agent without making it a Narrator status checklist',async()=>{
    const {save,prior,result,prompt,payload,threadIds}=await narratorRequest('柜台里传来杯碟相碰的轻响，门外的风把招牌吹得微微晃动。');
    expect(save.active_goal).toEqual(prior);
    expect(payload.public_state.active_goal).toBeUndefined();
    expect(payload.scene_context.recent_scene_history[0]?.narrative).toContain('买咖啡这件事还停在原地');
    expect(payload.narrative_focus_policy).toContain('不是每回合正文的收尾清单');
    expect(payload.verified_scene_anchor?.description).toBeTruthy();
    expect(payload.narrative_budget.guidance).toContain('不要把 receipt 的动作与时钟改写成一条结算日志');
    expect(payload.wait_presentation_policy).toContain('不得声称没有凭据的人物');
    expect(prompt).toContain('action、facts 与 receipt 约束哪些世界变化真实发生');
    expect(prompt).not.toContain('State separately what happened and what remains undone using receipts');
    expect(result.narrative).not.toContain('买咖啡');
    expect(threadIds).toEqual([undefined]);
    expect(save.ai.threads.narrator).toBe('old-accumulated-thread');
  });

  it('does not require a second pending-goal summary when the scene already shows the unfinished action',async()=>{
    const {result,payload}=await narratorRequest('咖啡还在暖柜里，店员抬头看你，等着你选定哪一罐。');
    expect(payload.narrative_focus_policy).toContain('场景已体现行动尚未完成时不要再总结一次');
    expect(result.narrative).toBe('咖啡还在暖柜里，店员抬头看你，等着你选定哪一罐。');
    expect(result.narrative).not.toContain('还停在原地');
  });

  it('allows a natural reminder when a person is waiting or a deadline matters',async()=>{
    const {result,payload}=await narratorRequest('店员握着杯子等你回答；末班车的广播已经响起。');
    expect(payload.narrative_focus_policy).toContain('有人等待回应');
    expect(payload.narrative_focus_policy).toContain('时限临近');
    expect(result.narrative).toContain('等你回答');
    expect(selectDefaultExemplars({role:'narrator',category:'narration'})[0]?.principle)
      .toContain('observable consequence');
  });
});
