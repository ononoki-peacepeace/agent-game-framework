import {describe,expect,it} from 'vitest';
import {agentResult} from '../src/agent/contracts.js';
import {agentPresentation} from '../src/client/agent-presentation.js';
import {engineOutcome,gameOutcome,gameNarrative} from '../src/agent/outcome.js';
import type {PublicView} from '../src/shared/contracts.js';

function view(revision:number,narrative='旧故事'):PublicView{
  return {revision,last_turn:{narrative},entities:[],locations:[]} as unknown as PublicView;
}
function visibleCount(previous:PublicView,result:ReturnType<typeof agentResult>){
  const visible=agentPresentation(previous,result);
  const freshStory=result.presentation==='story'&&result.view?.last_turn?.narrative!==previous.last_turn?.narrative;
  return Number(Boolean(visible.agentReply))+Number(Boolean(visible.storyOverride))+Number(Boolean(freshStory&&!visible.storyOverride));
}

describe('Agent feedback display contract',()=>{
  it('does not double a period when a structured progress summary already ends a sentence',()=>{
    const prose=gameNarrative(gameOutcome('partial_progress','execution',9),
      {completed:['移动至 宿舍区，用时 1 分钟。']});
    expect(prose).not.toContain('。。');
  });
  it('keeps incomplete feedback with no commit visible instead of claiming completion',()=>{
    const before=view(8);
    const result=agentResult('WORLD_ACTION','目前只规划出准备步骤，世界没有改变。',
      {presentation:'failure',view:before});
    expect(result.outcome).toMatchObject({type:'game',kind:'feedback',revision:8});
    expect(result.presentation).toBe('assistant');
    expect(agentPresentation(before,result).agentReply?.message).toBe(result.message);
    expect(visibleCount(before,result)).toBe(1);
  });

  it('shows a completed fresh narrative once on the story surface',()=>{
    const before=view(8),after=view(9,'新故事');
    const result=agentResult('WORLD_ACTION','新故事',
      {presentation:'story',outcome:gameOutcome('completed','narrative',9),view:after});
    expect(agentPresentation(before,result)).toEqual({storyOverride:null,agentReply:null,goalProgress:null});
    expect(visibleCount(before,result)).toBe(1);
  });

  it('does not repeat a committed story when state refresh wins the response race',()=>{
    const alreadyRefreshed=view(20,'你在房间等了一会儿。');
    const result=agentResult('WORLD_ACTION','你在房间等了一会儿。',{
      presentation:'story',outcome:gameOutcome('completed','narrative',20,['wait'],['receipt-20']),view:alreadyRefreshed});
    expect(agentPresentation(alreadyRefreshed,result).agentReply).toBeNull();
    const feedback=agentResult('WORLD_ACTION','行动尚未完成，请选择下一步。',{
      presentation:'story',outcome:gameOutcome('unresolved_goal','execution',20),view:alreadyRefreshed});
    expect(agentPresentation(alreadyRefreshed,feedback).agentReply?.message).toBe(feedback.message);
  });
  it('treats identical prose in a newer committed scene as a story, not assistant feedback',()=>{
    const before=view(8,'对方看了你一眼。'),after=view(9,'对方看了你一眼。');
    const result=agentResult('WORLD_SPEECH','对方看了你一眼。',{
      presentation:'story',outcome:gameOutcome('completed','natural_scene',9,['scene_interaction']),view:after});
    expect(agentPresentation(before,result).agentReply).toBeNull();
  });

  it('preserves committed Narrator prose when an executor returns a different summary',()=>{
    const before=view(8),after=view(9,'新故事');
    const result=agentResult('WORLD_ACTION','移动至 宿舍区，用时 1 分钟。。这次尝试已有实际进展，后续目标仍未发生。',
      {presentation:'story',outcome:gameOutcome('completed','narrative',9),view:after});
    expect(agentPresentation(before,result)).toEqual({storyOverride:null,agentReply:null,goalProgress:null});
    expect(visibleCount(before,result)).toBe(1);
  });

  it('combines only explicitly supplied validated Narrator turns',()=>{
    const before=view(8),after=view(10,'第二段故事');
    const result=agentResult('MULTI_GOAL','执行摘要',
      {presentation:'story',story:'第一段故事\n第二段故事',
        outcome:gameOutcome('completed','contract_plan',10,['first','second'],['a','b'],'completed'),view:after});
    expect(agentPresentation(before,result).storyOverride?.text).toBe('第一段故事\n第二段故事');
  });

  it.each(['narration','speech','legacy'] as const)('keeps assembled earlier turns without dropping latest %s evidence',mode=>{
    const before=view(8),after=view(10,'第二段故事');
    if(mode==='legacy')after.last_turn={...after.last_turn!,speaker:'npc_lin',dialogue:'本人原话。'};
    else after.last_turn={...after.last_turn!,scene_beats:mode==='speech'?
      [{kind:'narration',text:'第二段故事'},{kind:'speech',speaker_id:'npc_lin',utterance:'本人原话。'}]:[{kind:'narration',text:'第二段故事'}]};
    const result=agentResult('MULTI_GOAL','第一段故事\n第二段故事',{
      presentation:'story',story:'第一段故事\n第二段故事',view:after,
      outcome:gameOutcome('completed','plan_execution',10,['first','second'],['a','b'],'completed')});
    expect(agentPresentation(before,result).storyOverride).toEqual(mode==='narration'?{revision:10,text:'第一段故事\n第二段故事'}:null);
  });

  it('keeps a partial goal outside the committed story',()=>{
    const before=view(4),after=view(5,'你沿着走廊走出房间，停在宿舍区。');
    const plan={goals:[
      {normalized_goal:'走到宿舍区',status:'completed'},
      {normalized_goal:'查看走廊里的情况',status:'blocked',result:{summary:'当前无法核实这一步。'}},
    ]} as unknown as NonNullable<ReturnType<typeof agentResult>['plan']>;
    const result=agentResult('MULTI_GOAL','移动至 宿舍区，用时 1 分钟。。这次尝试已有实际进展，后续目标仍未发生。',
      {presentation:'story',outcome:gameOutcome('partial_progress','contract_plan',5,['first'],['receipt'], 'partial'),plan,view:after});
    expect(agentPresentation(before,result)).toEqual({storyOverride:null,agentReply:null,
      goalProgress:{completed:['走到宿舍区'],unfinished:['查看走廊里的情况'],reason:'当前无法核实这一步。'}});
    expect(after.last_turn?.narrative).not.toContain('实际进展');
  });

  it('keeps an ordinary scene beat out of the goal card even when an effect remains unsettled',()=>{
    const before=view(8),after=view(9,'两人交谈，人物没有答应同行。');
    const result=agentResult('WORLD_SPEECH','两人交谈，人物没有答应同行。',{
      presentation:'story',outcome:gameOutcome('partial_progress','natural_scene',9,['scene_interaction']),view:after});
    expect(agentPresentation(before,result).goalProgress).toBeNull();
    expect(agentPresentation(before,result).agentReply).toBeNull();
  });

  it('uses a public character name for a scene step inside a larger unfinished goal',()=>{
    const before=view(8),after=view(9,'你与她说了几句。');
    after.interaction_context={target_entity_id:'npc_1',mode:'conversation',started_turn:9,last_interaction_turn:9,
      scene_anchor:'',status:'active'};
    after.entities=[{id:'npc_1',type:'character',components:{identity:{name:'沈砚'}}}];
    const result=agentResult('WORLD_GOAL','你与她说了几句。',{
      presentation:'story',outcome:gameOutcome('partial_progress','open_goal_search_inquiry',9,['scene_interaction','到达广场']),view:after});
    expect(agentPresentation(before,result).goalProgress?.completed).toEqual(['与沈砚交谈','到达广场']);
  });

  it.each(['partial_progress','unresolved_goal','condition_false'] as const)(
    'shows %s as a normal Game Outcome without an error surface',kind=>{
      const before=view(8),after=view(8);
      const result=agentResult('WORLD_ACTION','本次请求有明确反馈。',
        {presentation:'story',outcome:gameOutcome(kind,'execution',8),view:after});
      const shown=agentPresentation(before,result);
      expect(shown.storyOverride).toBeNull();
      expect(shown.agentReply?.message).toBe(result.message);
      expect(visibleCount(before,result)).toBe(1);
    });

  it('falls back to assistant when story claims completion but last_turn did not change',()=>{
    const before=view(8),after=view(8);
    const result=agentResult('WORLD_ACTION','行动没有形成可展示的新故事。',
      {presentation:'story',outcome:gameOutcome('completed','agent_response',8),view:after});
    expect(agentPresentation(before,result).agentReply?.message).toBe(result.message);
    expect(visibleCount(before,result)).toBe(1);
  });

  it('keeps engine failures on the error surface',()=>{
    const before=view(8);
    const result=agentResult('WORLD_ACTION','服务暂时失败。',
      {presentation:'story',outcome:engineOutcome('provider_failure','narrative',8),view:before});
    expect(result.presentation).toBe('failure');
    expect(agentPresentation(before,result).agentReply?.appearance).toBe('failure');
    expect(visibleCount(before,result)).toBe(1);
  });

  it('routes every supported presentation with nonempty feedback to exactly one surface',()=>{
    const before=view(8);
    for(const presentation of ['assistant','handoff','failure','story'] as const){
      for(const kind of ['feedback','completed','partial_progress','condition_false'] as const){
        const result=agentResult('WORLD_ACTION','有反馈。',
          {presentation,outcome:gameOutcome(kind,'response',8),view:view(8)});
        expect(visibleCount(before,result),`${presentation}/${kind}`).toBe(1);
        expect(agentPresentation(before,result).agentReply?.appearance).not.toBe('failure');
      }
    }
  });

  it('leaves the world column empty when System owns a handoff',()=>{
    const before=view(8);
    const result=agentResult('SYSTEM_META_INTENT','已交给系统。',{view:before});
    expect(agentPresentation(before,result,true)).toEqual({storyOverride:null,agentReply:null,goalProgress:null});
  });
});
