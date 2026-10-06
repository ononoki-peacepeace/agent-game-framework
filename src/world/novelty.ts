import type {BackgroundIncident,WorldMacroArc} from '../background/schema.js';

export type NoveltyIssue={kind:'trope_similarity'|'single_source'|'player_centricity'|'forced_twist'|'character_stereotype'|'repetition'|'causal_gap';subject_id:string;reason:string};
type Candidate={player:{id:string};background_incidents?:BackgroundIncident[];world_macro_arcs?:WorldMacroArc[]};
const commonTrope=[
  /学生会长.{0,12}(幕后|黑手)/,/地下实验室/,/转学生.{0,12}隐藏身份/,
  /校长.{0,12}阴谋/,/魔王.{0,12}复活/,/被选中的勇者/,/教会其实邪恶/,
  /古代邪神.{0,8}苏醒/,/AI.{0,8}觉醒.{0,8}毁灭人类/i,/模拟世界/,
  /主角其实是克隆人/,/好友其实是犯人/,/所有案件.{0,10}同一个组织/,
];
function grams(value:string){const text=value.replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();return new Set(Array.from({length:Math.max(0,text.length-1)},(_,i)=>text.slice(i,i+2)));}
function similarity(a:string,b:string){const left=grams(a),right=grams(b);if(!left.size||!right.size)return 0;return [...left].filter(item=>right.has(item)).length/Math.min(left.size,right.size);}
/** A conservative authoring gate: it critiques candidates, never rewrites committed truth. */
export function reviewWorldNovelty(candidate:Candidate):NoveltyIssue[]{
  const issues:NoveltyIssue[]=[],incidents=candidate.background_incidents??[],arcs=candidate.world_macro_arcs??[];
  const entries=[...incidents.map(item=>({id:item.id,text:item.title+' '+item.summary,causal:item.causal_basis})),
    ...arcs.map(item=>({id:item.id,text:item.title+' '+item.summary,causal:{
      underlying_pressure:item.underlying_pressure,actor_motivation:item.actor_motivations.map(actor=>actor.motivation).join('、'),
      resource_constraint:item.resource_constraint,historical_cause:item.historical_cause,
      social_relationship:item.social_relationship,trigger:item.trigger,unintended_consequence:item.unintended_consequence,
    }}))];
  for(const entry of entries){
    if(!entry.causal)issues.push({kind:'causal_gap',subject_id:entry.id,reason:'候选缺少独立压力、动机、约束、历史、关系、触发与意外后果的因果依据'});
    if(commonTrope.some(pattern=>pattern.test(entry.text)))issues.push({kind:'trope_similarity',subject_id:entry.id,reason:'候选几乎可直接概括为高频类型套路，请从独立因果重新组合'});
    if(/专为(?:玩家|主角)|等待(?:玩家|主角)(?:来|发现|拯救)|主角注定/.test(entry.text))issues.push({kind:'player_centricity',subject_id:entry.id,reason:'事件明显以玩家为触发中心'});
    if(/毫无征兆.{0,12}反转|只为.{0,8}(震惊|反转)|突然发现.*其实/.test(entry.text))issues.push({kind:'forced_twist',subject_id:entry.id,reason:'反转缺少前置因果'});
    if(/高冷天才|疯狂科学家|腹黑学生会长|神秘转学生|纯恶反派/.test(entry.text)&&
      (!entry.causal||entry.causal.actor_motivation.length<12))
      issues.push({kind:'character_stereotype',subject_id:entry.id,reason:'人物只有标签，缺少独立动机'});
  }
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)
    if(similarity(entries[i].text,entries[j].text)>.8)
      issues.push({kind:'repetition',subject_id:entries[j].id,reason:'与现有候选的事件形式或真相结构高度重复'});
  // Two initial seeds are too small a sample to prove that an entire long-running world has one source.
  if(incidents.length>=3&&arcs.length===1&&incidents.every(incident=>arcs[0].incident_refs.includes(incident.id)))
    issues.push({kind:'single_source',subject_id:arcs[0].id,reason:'所有事件均归于同一主轴；应保留独立的日常和人物事件'});
  if(incidents.some(incident=>incident.participants.includes(candidate.player.id)))
    issues.push({kind:'player_centricity',subject_id:candidate.player.id,reason:'玩家不能被预设为后台事件的必要行动者'});
  return issues;
}
