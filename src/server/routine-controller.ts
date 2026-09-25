import { assert, type SavePackage } from '../core/schema.js';
import { executeAction } from '../core/runtime.js';
import { validateSave } from '../core/state.js';
import { rollDice, parseDice } from '../core/dice.js';
import type { AIRuntime } from '../ai/runtime.js';
import type { RoutineResult } from '../ai/routine.js';

// Operates exclusively on the uncommitted turn candidate. Any error discards it.
export async function settleRoutine(candidate: SavePackage, ai: AIRuntime, maxMinutes: number, generate?: (save:SavePackage,max:number,random?:unknown[],planned?:unknown)=>Promise<RoutineResult>) {
  const start = structuredClone(candidate.runtime.time), dayLength = candidate.definition.ruleset.minutes_per_day;
  const elapsed = (r:RoutineResult) => (r.segment.end.day-start.day)*dayLength+r.segment.end.minute-start.minute;
  function checkTime(r:RoutineResult) {
    assert(r.segment.start.day===start.day && r.segment.start.minute===start.minute, '生活段起点与当前正史不一致');
    assert(r.segment.end.minute<dayLength && elapsed(r)>=0 && elapsed(r)<=maxMinutes, '生活段结束时间越界');
    assert(r.interrupt === Boolean(r.interrupt_reason), '生活模式中断原因与状态不一致');
  }
  const actor=candidate.entities.find(e=>e.id===candidate.player_state.entity_id)!;
  if(actor.components.routine.interrupted) {
    candidate.last_turn={narrative:String(actor.components.routine.last_interrupt),speaker:null,dialogue:null,choices:[],context_actions:[]};
    return validateSave(candidate);
  }
  if(!actor.components.condition) {
    const description=String(actor.components.identity?.description??'');
    const hp=description.match(/HP\s*(\d+)(?:\/100)?/i), stamina=description.match(/体力\s*(\d+)(?:\/100)?/), stress=description.match(/压力\s*(\d+)(?:\/100)?/);
    if(hp && stamina && stress && [hp,stamina,stress].every(m=>Number(m[1])<=100)) actor.components.condition={hp:Number(hp[1]),stamina:Number(stamina[1]),stress:Number(stress[1])};
  }
  let result = await (generate??ai.routine.bind(ai))(candidate,maxMinutes); checkTime(result);
  const randomResults: (ReturnType<typeof rollDice> & {id:string;reason:string})[] = [];
  if(result.checks.length) {
    assert(!result.activities.length && !result.patches.length, '随机结果尚未生成，不能提前结算');
    const ids=new Set<string>();
    for(const check of result.checks) {
      assert(!ids.has(check.id), '重复随机检查'); ids.add(check.id);
      const dice=parseDice(check.expression); assert(dice.count<=10 && dice.sides<=100, '生活模式随机检查过大');
      randomResults.push({...rollDice(check.expression), id:check.id, reason:check.reason});
    }
    const planned=result.segment, plannedVisits=result.visits;
    result=await (generate??ai.routine.bind(ai))(candidate,maxMinutes,randomResults,planned);checkTime(result);
    assert(JSON.stringify(result.visits)===JSON.stringify(plannedVisits),'随机结算不得改变行程');
    assert(!result.checks.length, '同一生活段不能无限请求随机检查');
    assert(JSON.stringify(result.segment.start)===JSON.stringify(planned.start) && JSON.stringify(result.segment.end)===JSON.stringify(planned.end), '随机结算不得改变生活段区间');
  }
  let minutes=elapsed(result);
  assert(result.activities.length>0 || (result.interrupt && minutes===0), 'AI 未返回有效生活结果，本段未推进时间');
  assert(minutes>0 || (result.interrupt && !result.patches.length && !result.activities.length && !result.visits.length), '零时间只能交还控制权，不能获得收益');
  for(const activity of result.activities) {
    assert(activity.participants.every(id=>candidate.entities.some(e=>e.id===id && e.components.character)), '生活结果引用未知人物');
    assert(!/^(?:时间过去|推进时间|没有触发|无事发生)[。.!！\s]*$/.test(activity.summary), 'AI 只返回空时间，本段未提交');
  }
  assert(!result.activities.some(a=>a.kind==='gambling') || randomResults.length>0, '赌博必须使用程序随机结果');
  assert(randomResults.length>0 || !/(?:D\d+|\d+d\d+|掷骰|骰子)\s*[=:：＝]\s*\d+/i.test(JSON.stringify(result)), 'AI 不得自行声称掷骰结果');
  applyLifePatches(structuredClone(candidate),result); // Validate every proposed change before running hooks.
  let next=candidate, travelMinutes=0;
  let origin=String(candidate.entities.find(e=>e.id===candidate.player_state.entity_id)!.components.location.location_id);
  const routes=[...(candidate.definition.map?.routes??[]),...candidate.map_state.dynamic_routes];
  for(const to of result.visits) {
    const route=routes.find(r=>r.from===origin && r.to===to && r.conditions.every(c=>candidate.gm_state.flags[c.flag]===c.equals));
    assert(route && candidate.map_state.known_location_ids.includes(to),'生活行程没有已知的可通行路线');
    travelMinutes+=route.travel_minutes;origin=to;
  }
  assert(travelMinutes<=minutes,'生活段不能短于实际路程');
  let interruptedTravel=false;
  for(const to of result.visits) {
    next=executeAction(next,{type:'MOVE',target_id:to},'routine-travel','ai',undefined,undefined,false).save;
    const state=next.entities.find(e=>e.id===next.player_state.entity_id)!.components.routine;
    if(state.interrupted) {
      interruptedTravel=true;
      minutes=(next.runtime.time.day-start.day)*dayLength+next.runtime.time.minute-start.minute;
      const reason=String(state.last_interrupt);
      result={...result,segment:{start,end:next.runtime.time,summary:'生活安排在途中暂停。'},activities:[{kind:'world_event',summary:reason,participants:[next.player_state.entity_id]}],patches:[],interrupt:true,interrupt_reason:reason};
      break;
    }
  }
  if(!interruptedTravel) {
    applyLifePatches(next,result);
    const remaining=minutes-travelMinutes;
    if(remaining) {
      const originalLimit=next.definition.ruleset.max_wait_minutes;
      next.definition.ruleset.max_wait_minutes=Math.max(originalLimit,remaining);
      next=executeAction(next,{type:'WAIT',parameters:{minutes:remaining}},'routine-segment','ai',undefined,undefined,false).save;
      next.definition.ruleset.max_wait_minutes=originalLimit;
    }
  }
  const r=next.entities.find(e=>e.id===next.player_state.entity_id)!.components.routine;
  const hookReason=r.interrupted ? String(r.last_interrupt) : null;
  const interrupted=result.interrupt || !!hookReason;
  const reason=hookReason ?? result.interrupt_reason;
  r.active=!interrupted;r.interrupted=interrupted;r.last_interrupt=reason;
  r.elapsed_minutes=Number(r.elapsed_minutes??0)+minutes;r.cycles=Number(r.cycles??0)+1;
  r.next_arrangement=result.next_arrangement;
  const history=Array.isArray(r.history)?r.history:[];
  r.history=[...history,{...result.segment,activities:result.activities,patches:result.patches,random_results:randomResults,interrupt:interrupted,interrupt_reason:reason}].slice(-30);
  next.last_turn={narrative:[result.segment.summary,...result.activities.map(a=>a.summary),...(reason?[reason]:[])].join('\n'),speaker:null,dialogue:null,choices:[],context_actions:[]};
  return validateSave(next);
}

export function applyLifePatches(candidate:SavePackage,result:RoutineResult) {
  const player=candidate.entities.find(e=>e.id===candidate.player_state.entity_id)!;
  // Aggregate before validation to prevent splitting a forbidden large change into small patches.
  const totals=new Map<string,number>();
  for(const p of result.patches) {
    const k=JSON.stringify([p.op,p.key,p.op==='relationship_delta'?p.target_id:null]);totals.set(k,(totals.get(k)??0)+p.delta);
    assert(p.delta!==0,'生活补丁不能是无变化占位');
    if(p.op!=='relationship_delta')assert(p.target_id===null || p.target_id===player.id,'该补丁只允许修改玩家本人');
  }
  for(const [encoded,delta] of totals) {
    const [op,key,target]=JSON.parse(encoded) as [string,string,string|null];
    if(op==='wallet_delta') {
      const balances=player.components.wallet?.balances as Record<string,number>|undefined;
      assert(balances && Object.hasOwn(balances,key) && candidate.definition.ruleset.currencies[key], '生活补丁引用未知钱包或币种');
      assert(Math.abs(delta)<=100 && balances[key]+delta>=0, '生活收支超出允许范围');balances[key]+=delta;
    } else if(op==='skill_xp') {
      const entries=player.components.skills?.entries as Record<string,{xp:number;next_xp:number}>|undefined;
      const skill=entries?.[key];assert(skill && delta>0 && delta<=20,'生活经验补丁无效');
      assert(skill.xp+delta<skill.next_xp,'技能达到升级阈值，需要玩家接管，本段未提交');skill.xp+=delta;
    } else if(op==='attribute_delta') {
      const values=player.components.attributes?.values as Record<string,number>|undefined;
      assert(values && Object.hasOwn(values,key) && Math.abs(delta)<=1,'生活属性补丁无效');values[key]+=delta;
    } else if(op==='condition_delta') {
      const condition=player.components.condition as Record<string,number>|undefined;
      assert(condition && ['hp','stamina','stress'].includes(key) && Math.abs(delta)<=20,'生活状态补丁无效');
      assert(condition[key]+delta>=0 && condition[key]+delta<=100,'生活状态变化越界');condition[key]+=delta;
    } else {
      assert(target && target!==player.id && candidate.entities.some(e=>e.id===target && e.components.character),'生活关系目标不存在');
      const dims=candidate.definition.ruleset.relationship_dimensions, d=dims[key];
      const entries=player.components.relationships?.entries as Record<string,Record<string,number>>|undefined;
      assert(entries && d && Math.abs(delta)<=2,'生活关系补丁无效');
      const value=(entries[target]?.[key]??d.initial)+delta;assert(value>=d.min && value<=d.max,'生活关系变化越界');
      entries[target]??={};entries[target][key]=value;
    }
  }
}
