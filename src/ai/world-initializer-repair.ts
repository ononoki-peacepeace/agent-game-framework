import {z} from 'zod';
import {worldInitializationSchema} from './contracts.js';
import {GameError} from '../core/schema.js';

export type WorldIssue={path:string;code:string;message:string;current:unknown;requirement:string};

/** Carries an uncommitted candidate to the bounded initializer repair loop. Never display its payload. */
export class WorldCandidateError extends Error{
  constructor(readonly candidate:unknown,readonly issues:WorldIssue[]){super('世界候选结构校验失败');}
}

function valueAt(value:unknown,path:(string|number)[]){
  let current:unknown=value;
  for(const key of path)current=current!==null&&typeof current==='object'?(current as Record<string,unknown>)[String(key)]:undefined;
  return current;
}

export function normalizeWorldCandidate(input:unknown):unknown{
  if(!input||typeof input!=='object'||Array.isArray(input))return input;
  const candidate=structuredClone(input) as Record<string,unknown>;
  const shop=candidate.shop;
  if(shop&&typeof shop==='object'&&!Array.isArray(shop)){
    const cash=(shop as Record<string,unknown>).cash;
    // A generated shop's starting float is bounded accounting data, not a story commitment.
    if(typeof cash==='number'&&Number.isSafeInteger(cash)&&cash>100000)(shop as Record<string,unknown>).cash=100000;
  }
  return candidate;
}

export function worldCandidateIssues(candidate:unknown):WorldIssue[]{
  const result=worldInitializationSchema.safeParse(candidate);
  if(result.success)return openingConsistencyIssues(result.data);
  return result.error.issues.map(issue=>({
    path:issue.path.map(String).join('.'),code:issue.code,message:issue.message,
    current:valueAt(candidate,issue.path.map(String)),requirement:issue.code==='invalid_format'?'须符合字段的 machine-id 格式':
      issue.code==='too_big'?'不得超过 schema 上限':issue.code==='too_small'?'不得低于 schema 下限':issue.message,
  }));
}

function openingConsistencyIssues(world:z.infer<typeof worldInitializationSchema>):WorldIssue[]{
  const opening=world.opening.trim();
  const first=opening.split(/[。！？!?\n]/)[0]??'';
  const issues:WorldIssue[]=[];
  // The compiler starts every authored world at Day 1, 09:00 with the default January 1 Monday calendar.
  const hourWords:Record<string,number>={零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12};
  const clock=first.match(/(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9]{1,2}|十[一二]?|[零一二三四五六七八九])\s*(?:点|时)(?:半|([0-9]{1,2})分?)?/);
  if(clock){
    const raw=/^\d+$/.test(clock[2])?Number(clock[2]):hourWords[clock[2]];
    const hour=(clock[1]==='下午'||clock[1]==='傍晚'||clock[1]==='晚上')&&raw<12?raw+12:raw;
    const minute=clock[0].includes('半')?30:Number(clock[3]??0);
    if(hour!==9||minute!==0)issues.push({path:'opening',code:'canonical_time_mismatch',message:'开场当前时间必须与第1天09:00一致',current:opening,requirement:'删除冲突的具体时间，或使用开局第1天09:00；不得更改 canonical 起始时间'});
  }
  const weekday=first.match(/(?:星期|周)([一二三四五六日天])/);
  if(weekday&&weekday[1]!=='一')issues.push({path:'opening',code:'canonical_weekday_mismatch',message:'开场当前星期与第1天周一不一致',current:opening,requirement:'使用周一或不写星期'});
  const monthDate=first.match(/(\d{1,2}|[一二三四五六七八九十]+)月(?:的)?(\d{1,2}|[一二三四五六七八九十]+)(?:日|号)/);
  if(monthDate&&(monthDate[1]!=='1'&&monthDate[1]!=='一'||monthDate[2]!=='1'&&monthDate[2]!=='一'))
    issues.push({path:'opening',code:'canonical_date_mismatch',message:'开场当前日期与第1天1月1日不一致',current:opening,requirement:'使用1月1日或不写绝对日期'});
  const numeral:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  const origin=world.locations?.find(location=>location.id===world.player.location_id);
  for(const sentence of opening.split(/[。！？!?；;\n]/)){
    const duration=sentence.match(/([0-9]{1,3}|[一二两三四五六七八九十])\s*分钟/);
    if(!duration)continue;
    const stated=/^\d+$/.test(duration[1])?Number(duration[1]):numeral[duration[1]];
    for(const route of world.routes??[]){
      const from=world.locations?.find(location=>location.id===route.from),to=world.locations?.find(location=>location.id===route.to);
      if(stated===route.travel_minutes||!from||!to)continue;
      if((sentence.includes(from.name)&&sentence.includes(to.name))||
        (origin?.id===from.id&&sentence.includes(to.name)&&/去|到|走|路程|距离|过去/.test(sentence))){
        issues.push({path:'opening',code:'canonical_route_duration_mismatch',message:'开场路线耗时与地图不一致',current:opening,requirement:`使用已登记路线 ${route.travel_minutes} 分钟，或删除具体分钟数`});
        break;
      }
    }
    if(issues.some(issue=>issue.code==='canonical_route_duration_mismatch'))break;
  }
  return issues;
}

function parts(path:string){return path.split('.').map(part=>/^\d+$/.test(part)?Number(part):part);}
function setPath(target:unknown,path:(string|number)[],value:unknown){
  if(!path.length)throw new Error('修复范围缺少精确字段');
  let node=target as Record<string,unknown>;
  for(const key of path.slice(0,-1)){
    const child=node[String(key)];
    if(!child||typeof child!=='object')throw new Error('修复范围不存在');
    node=child as Record<string,unknown>;
  }
  node[String(path.at(-1))]=structuredClone(value);
}

/** Accept only the fields named by structural issues; the rest of the model's rewrite is discarded. */
export function projectWorldRepair(original:unknown,repaired:unknown,issues:WorldIssue[]):unknown{
  const result=structuredClone(original);
  for(const issue of issues){
    let path=parts(issue.path);
    if(issue.message.includes('末阶段必须结束案件')&&path[0]==='background_incidents'&&typeof path[1]==='number'){
      const stages=valueAt(result,['background_incidents',path[1],'stages']);
      if(!Array.isArray(stages)||!stages.length)throw new Error('案件缺少可修复末阶段');
      path=['background_incidents',path[1],'stages',stages.length-1,'terminal'];
    }
    if(!path.length||path.some(part=>part==='__proto__'||part==='constructor'||part==='prototype'))throw new Error('修复路径不安全');
    const replacement=valueAt(repaired,path);
    if(replacement===undefined)throw new Error('修复候选缺少目标字段');
    setPath(result,path,replacement);
  }
  return result;
}

/** Novelty revision may alter authoring ideas, never identities, committed truths or world geography. */
export function projectNoveltyRepair(original:unknown,repaired:unknown):unknown{
  const base=structuredClone(original) as Record<string,unknown>,next=repaired as Record<string,unknown>;
  for(const field of ['background_incidents','world_macro_arcs'] as const){
    const before=base[field],after=next?.[field];
    if((before==null&&after==null)||(before==null&&Array.isArray(after)&&after.length===0)||
      (Array.isArray(before)&&before.length===0&&after==null))continue;
    if(!Array.isArray(before)||!Array.isArray(after)||after.some(item=>!before.some(existing=>existing.id===item.id)))
      throw new Error('修订不能替换世界事件或长期主轴');
    for(let i=0;i<before.length;i++){
      const replacement=after.find(item=>item.id===before[i].id);
      if(!replacement)continue; // Preserve a seed that the model omitted while revising.
      for(const key of field==='background_incidents'?['title','summary','causal_basis']:['title','summary','underlying_pressure','actor_motivations','resource_constraint','historical_cause','social_relationship','trigger','unintended_consequence','incident_refs'])
        if(Object.hasOwn(replacement,key))before[i][key]=structuredClone(replacement[key]);
    }
  }
  return base;
}

/** Semantic repair is permitted only for the subsystem named by its validation failure. */
export function projectSemanticRepair(original:unknown,repaired:unknown,message:string):unknown{
  const roots=/长期主轴/.test(message)?['world_macro_arcs']:/后台案件|案件|事件阶段/.test(message)?['background_incidents']:
    /隐藏事实|证据/.test(message)?['hidden_truths']:/地图|地点|路线/.test(message)?['locations','routes']:
    /人物|角色/.test(message)?['characters']:[];
  if(!roots.length)throw new Error('语义错误未能定位安全修复范围');
  const base=structuredClone(original) as Record<string,unknown>,next=repaired as Record<string,unknown>;
  for(const root of roots){
    const before=base[root],after=next?.[root];
    if(!Array.isArray(before)||!Array.isArray(after))throw new Error('修复不能删除相关世界结构');
    if(root!=='routes'&&(before.length!==after.length||before.some((item,index)=>item.id!==after[index]?.id)))
      throw new Error('修复不能删除或替换相关世界对象');
    if(root==='hidden_truths'&&before.some((item,index)=>item.statement!==after[index]?.statement||
      item.commitment!==after[index]?.commitment||item.evidence.length!==after[index]?.evidence?.length||
      item.evidence.some((evidence:{id:string;description:string},eIndex:number)=>evidence.id!==after[index].evidence[eIndex]?.id||evidence.description!==after[index].evidence[eIndex]?.description)))
      throw new Error('修复不能改写既有隐藏真相或证据');
    if(root==='characters'&&before.some((item,index)=>item.name!==after[index]?.name||item.description!==after[index]?.description))
      throw new Error('修复不能改写人物身份');
    if(root==='locations'&&before.some((item,index)=>item.name!==after[index]?.name||item.description!==after[index]?.description))
      throw new Error('修复不能改写地点身份');
    if(root==='background_incidents'&&before.some((item,index)=>item.title!==after[index]?.title||item.summary!==after[index]?.summary||
      item.stages.length!==after[index]?.stages?.length||item.stages.some((stage:{id:string},sIndex:number)=>stage.id!==after[index].stages[sIndex]?.id)))
      throw new Error('修复不能替换或删除案件内容');
    base[root]=structuredClone(after);
  }
  return base;
}

export function publicWorldCreationFailure(){return new GameError('新世界生成结果未能通过结构校验，请重新生成。',422);}
