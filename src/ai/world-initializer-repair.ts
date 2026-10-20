import {z} from 'zod';
import {worldInitializationSchema} from './contracts.js';
import {GameError} from '../core/schema.js';
import {defaultCalendar} from '../routine/schema.js';
import {statedPossessionClauses,statedPossessionClaims} from '../core/possession-claims.js';

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

/** Enforce only explicit initial population commitments in the premise. */
export function initialNpcRequirement(description:string):number|null{
  const totalBefore=description.match(/(?:初始|开局|起始|共有|总共|共计)[^。；\n]{0,50}?(\d+)\s*(?:名|位|个|人)?\s*(?:参与者|参赛者)/);
  const totalAfter=description.match(/(?:初始|开局|起始|总|全部)[^。；\n]{0,24}?(?:参与者|参赛者)[^。；\n]{0,16}?(\d+)\s*(?:名|位|个|人)/);
  const npcBefore=description.match(/(?:其余|另外|另有|共计|共有)[^。；\n]{0,12}?(\d+)\s*(?:名|位|个|人)?[^。；\n]{0,50}?\bNPC\b/i)
    ??description.match(/(\d+)\s*(?:名|位|个|人)?\s*(?:自主)?NPC\b/i);
  const npcAfter=description.match(/\bNPC\s*(?:[:：]|为|共|恰好)?\s*(\d+)\s*(?:名|位|个|人)?/i);
  const count=npcBefore?Number(npcBefore[1]):npcAfter?Number(npcAfter[1]):
    totalBefore?Number(totalBefore[1])-1:totalAfter?Number(totalAfter[1])-1:null;
  return count!==null&&Number.isSafeInteger(count)&&count>=0?count:null;
}

// Only an explicit opening instruction is a hard constraint. Dates in backstory are not.
function calendarNumber(text:string):number{
  if(/^\d+$/.test(text))return Number(text);
  const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const parts=text.split('十');
  if(parts.length===1)return digits[text]??NaN;
  if(parts.length!==2)return NaN;
  return (parts[0]?digits[parts[0]]:1)*10+(parts[1]?digits[parts[1]]:0);
}
function explicitOpeningRequirements(description:string):{month?:number;date?:number;minute?:number;weekday?:number}{
  const clause=description.split(/[。；;\n]/).find(part=>/(?:开局|开场|起始|故事开始|游戏开始|初始时间)/.test(part));
  if(!clause)return {};
  const date=clause.match(/(\d{1,2}|[一二两三四五六七八九十]+)月(\d{1,2}|[一二两三四五六七八九十]+)(?:日|号)/);
  const weekday=clause.match(/(?:星期|周)([一二三四五六日天])/);
  const specified={...(date?{month:calendarNumber(date[1]),date:calendarNumber(date[2])}:{}),...(weekday?{weekday:'一二三四五六日'.indexOf(weekday[1]==='天'?'日':weekday[1])+1}:{})};
  const clock=clause.match(/(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2}|十[一二]?|[一二两三四五六七八九])(?::(\d{2})|点(?:半|([0-5]?\d)分?)?)/);
  if(!clock)return specified;
  const numerals:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12};
  let hour=/^\d+$/.test(clock[2])?Number(clock[2]):numerals[clock[2]];
  if(/下午|傍晚|晚上/.test(clock[1]??'')&&hour<12)hour+=12;
  if(/凌晨|清晨|早上|上午/.test(clock[1]??'')&&hour===12)hour=0;
  const minute=clock[0].includes('半')?30:Number(clock[3]??clock[4]??0);
  return {...specified,...(hour<24&&minute<60?{minute:hour*60+minute}:{})};
}

export function worldCandidateIssues(candidate:unknown,description='',requireOpeningTime=false):WorldIssue[]{
  const result=worldInitializationSchema.safeParse(candidate);
  if(result.success){
    const issues=openingConsistencyIssues(result.data);
    if(requireOpeningTime&&!result.data.opening_time)issues.push({path:'opening_time',code:'opening_time_missing',message:'新世界缺少权威开局日期和时间',current:null,requirement:'依据原始设定提供 opening_time.minute 和 calendar；明确指定的开局时间必须遵守'});
    if(result.data.opening_time&&result.data.opening_time.calendar.anchor_day!==1)issues.push({path:'opening_time.calendar.anchor_day',code:'opening_anchor_invalid',message:'开局日历锚点不是运行第1天',current:result.data.opening_time.calendar.anchor_day,requirement:'开局日历 anchor_day 必须为1'});
    if(result.data.opening_time){
      const c=result.data.opening_time.calendar;
      if(c.anchor_date>c.month_lengths[c.anchor_month-1])issues.push({path:'opening_time.calendar.anchor_date',code:'opening_date_invalid',message:'开局日期超过该历法月份长度',current:c.anchor_date,requirement:'日期不得超过 month_lengths 中对应月份长度'});
      const explicit=explicitOpeningRequirements(description);
      if(explicit.month!==undefined&&(c.anchor_month!==explicit.month||c.anchor_date!==explicit.date))issues.push({path:'opening_time.calendar',code:'explicit_opening_date_mismatch',message:'开局日期与用户明确指定的日期不符',current:c,requirement:`开局日期须为${explicit.month}月${explicit.date}日`});
      if(explicit.minute!==undefined&&result.data.opening_time.minute!==explicit.minute)issues.push({path:'opening_time.minute',code:'explicit_opening_time_mismatch',message:'开局时刻与用户明确指定的时间不符',current:result.data.opening_time.minute,requirement:`开局时刻须为${String(Math.floor(explicit.minute/60)).padStart(2,'0')}:${String(explicit.minute%60).padStart(2,'0')}`});
      if(explicit.weekday!==undefined&&c.anchor_weekday!==explicit.weekday)issues.push({path:'opening_time.calendar.anchor_weekday',code:'explicit_opening_weekday_mismatch',message:'开局星期与用户明确指定的星期不符',current:c.anchor_weekday,requirement:`开局星期须为${explicit.weekday}`});
    }
    const expected=initialNpcRequirement(description);
    if(result.data.characters.length>0&&!result.data.modules.includes('characters')&&!result.data.modules.includes('relationships'))issues.push({
      path:'modules',code:'characters_capability_missing',message:'候选有人物却没有启用人物能力',
      current:result.data.modules,requirement:'启用 characters，使全部已创作 NPC 真正进入世界'});
    if((result.data.locations?.length||result.data.routes?.length)&&!result.data.modules.includes('map'))issues.push({
      path:'modules',code:'map_capability_missing',message:'候选有地点路线却没有启用地图能力',
      current:result.data.modules,requirement:'启用 map，使已创作地点和路线真正进入世界'});
    if(result.data.initial_relationships?.length&&!result.data.modules.includes('relationships'))issues.push({
      path:'modules',code:'relationships_capability_missing',message:'候选有初始关系却没有启用关系能力',
      current:result.data.modules,requirement:'启用 relationships，使初始人物关系进入权威世界'});
    if(expected!==null&&result.data.characters.length!==expected)issues.push({
      path:'characters',code:'initial_population_mismatch',message:'初始 NPC 人数与原始世界要求不符',
      current:result.data.characters.length,requirement:`须创建 ${expected} 名独立 NPC；玩家另计，且每名 NPC 必须有完整人物资料`});
    if(expected!==null&&result.data.characters.some(character=>!character.persona||
      !(character.persona.personality?.trim()||character.persona.behavior_tendencies?.length||
        character.persona.motivations?.length)))issues.push({path:'characters',
      code:'initial_persona_missing',message:'初始 NPC 缺少独立人物设定',
      current:result.data.characters.filter(character=>!character.persona||
        !(character.persona.personality?.trim()||character.persona.behavior_tendencies?.length||
          character.persona.motivations?.length)).map(character=>character.id),
      requirement:'为每名初始 NPC 填写可区分的人格、行为倾向或动机；不能只给姓名'});
    const ids=new Set<string>([result.data.player.id]);
    for(const character of result.data.characters){
      if(ids.has(character.id))issues.push({path:'characters',code:'duplicate_character_id',
        message:'人物 ID 重复或与玩家重复',current:character.id,requirement:'每名 NPC 和玩家必须有唯一 ID'});
      ids.add(character.id);
    }
    const activePeople=result.data.modules.includes('characters')?ids:new Set([result.data.player.id]);
    const profiles=result.data.capability_profiles??[],profileIds=new Set(profiles.map(p=>p.entity_id));
    if(profiles.some((p,i)=>!activePeople.has(p.entity_id)||profiles.findIndex(q=>q.entity_id===p.entity_id)!==i))
      issues.push({path:'capability_profiles',code:'invalid_capability_owner',message:'能力资料引用未知或重复人物',current:null,requirement:'每份能力资料引用唯一的真实人物'});
    if(profiles.length&&[...activePeople].some(id=>!profileIds.has(id)))
      issues.push({path:'capability_profiles',code:'missing_character_capability',message:'人物缺少稳定能力资料',current:null,requirement:'为玩家和每名NPC提供能力资料；依据已确定背景，不足时使用0中性默认，不按性别或玩家愿望指定优势'});
    const locations=new Set((result.data.locations??[]).map(location=>location.id));
    const entityIds=new Set([...ids,...(result.data.items??[]).map(item=>item.id),...(result.data.shop?[result.data.shop.id]:[])]);
    const itemById=new Map((result.data.items??[]).map(item=>[item.id,item]));
    if(itemById.size!==(result.data.items??[]).length||[...itemById.keys()].some(itemId=>ids.has(itemId)||itemId===result.data.shop?.id))
      issues.push({path:'items',code:'duplicate_item_id',message:'物品 ID 重复或与其他实体冲突',
        current:null,requirement:'每件物品须有独立且不与人物、商店冲突的 ID'});
    const possessions=result.data.initial_possessions??[];
    const possessionByItem=new Map(possessions.map(entry=>[entry.item_id,entry]));
    // This guard only treats an explicit opening/current-possession clause as
    // authoritative. Profession, historical use and incidental prose are not
    // grounds to create an item or assign it to a character. The phrasing rules live in
    // `core/possession-claims.ts` so that the load-time reliability check reads a world's stated
    // possessions exactly the way this gate does; the live world wrote 「随身只有相机、半卷胶片和
    // 一件沾了海雾的外套」, matched the older narrower trigger nowhere, and the camera the Narrator
    // then described was never a structured item at all.
    const itemNames=(result.data.items??[]).map(item=>item.name);
    for(const actor of [result.data.player,...result.data.characters]){
      for(const clause of statedPossessionClauses(actor.description)){
        const named=(result.data.items??[]).filter(item=>clause.includes(item.name));
        const claims=statedPossessionClaims(clause,itemNames);
        for(const claim of claims)if(!named.some(item=>claim.includes(item.name)||item.name.includes(claim)))
          issues.push({path:`${actor.id}.description`,code:'initial_possession_definition_missing',
            message:'明确的开局随身物品没有结构化物品定义',current:claim,
            requirement:'为明确现持有的每件物品建立 items 和 initial_possessions；不从职业或过去经历推断'});
        if(!named.length&&!claims.length)issues.push({path:`${actor.id}.description`,code:'initial_possession_definition_missing',
          message:'明确的开局随身物品没有结构化物品定义',current:clause,
          requirement:'为明确现持有的每件物品建立 items 和 initial_possessions；不从职业或过去经历推断'});
        for(const item of named)if(possessionByItem.get(item.id)?.owner_id!==actor.id)
          issues.push({path:'initial_possessions',code:'initial_possession_missing',
            message:'明确的开局随身物品未分配给对应人物',current:{owner_id:actor.id,item_id:item.id,name:item.name},
            requirement:'为该物品登记此人物的初始持有位置；容器内和穿戴状态须按原始设定区分'});
      }
    }
    const usedSlots=new Set<string>();
    possessions.forEach((entry,index)=>{
      const path=`initial_possessions.${index}`;
      const issue=(field:string,code:string,message:string,current:unknown,requirement:string)=>
        issues.push({path:`${path}.${field}`,code,message,current,requirement});
      if(!ids.has(entry.owner_id))issue('owner_id','unknown_owner','初始物品归属者不存在',entry.owner_id,'引用玩家或已登记 NPC');
      if(!itemById.has(entry.item_id))issue('item_id','unknown_item','初始物品实体不存在',entry.item_id,'引用 items 中的物品 ID');
      if(possessions.findIndex(other=>other.item_id===entry.item_id)!==index)
        issue('item_id','duplicate_possession','同一初始物品被重复分配',entry.item_id,'每件初始物品只登记一个位置');
      if(entry.placement==='inside_container'){
        const container=itemById.get(entry.container_id??'');
        if(!container?.container||entry.container_id===entry.item_id||
          possessionByItem.get(entry.container_id??'')?.owner_id!==entry.owner_id||
          possessionByItem.get(entry.container_id??'')?.placement==='stored')
          issue('container_id','invalid_initial_container','容器不存在、未声明为容器或不属于同一人物',entry.container_id,
            '容器须在 items 中声明 container=true，并由同一人物持有');
      }else if(entry.container_id)issue('container_id','unexpected_initial_container','非容器内物品不能指定容器',entry.container_id,'仅 inside_container 可指定容器');
      if(entry.placement==='stored'){
        if(!entry.location_id||!locations.has(entry.location_id))
          issue('location_id','invalid_stored_location','不随身物品缺少有效存放地点',entry.location_id,'引用已登记地点');
      }else if(entry.location_id)issue('location_id','unexpected_initial_location','随身物品不能同时位于场景',entry.location_id,'仅 stored 可指定地点');
      if(entry.placement==='held'||entry.placement==='worn'){
        const slot=entry.slot??(entry.placement==='held'?'hand':'body'),key=`${entry.owner_id}:${slot}`;
        if(usedSlots.has(key))issue('slot','occupied_initial_slot','同一人物的装备槽被重复占用',slot,'每个槽位只能放一件物品');
        usedSlots.add(key);
      }else if(entry.slot)issue('slot','unexpected_initial_slot','非装备物品不能指定装备槽',entry.slot,'仅 held/worn 可指定槽位');
    });
    const relationKeys=new Set<string>();
    result.data.initial_relationships?.forEach((relation,index)=>{
      for(const [field,target] of [['from_id',relation.from_id],['to_id',relation.to_id]] as const)
        if(!ids.has(target))issues.push({path:`initial_relationships.${index}.${field}`,code:'unknown_character',message:'初始关系引用了未登记人物',current:target,requirement:'引用玩家或已登记 NPC ID'});
      const key=`${relation.from_id}:${relation.to_id}:${relation.dimension}`;
      if(relationKeys.has(key))issues.push({path:`initial_relationships.${index}`,code:'duplicate_relationship',message:'同一关系维度重复',current:key,requirement:'每个有向人物关系维度只保留一条'});
      relationKeys.add(key);
      if(relation.from_id===relation.to_id)issues.push({path:`initial_relationships.${index}`,code:'self_relationship',message:'人物不能与自己建立初始关系',current:key,requirement:'关系两端必须是不同人物'});
      const min=relation.dimension==='trust'?-100:0,max=100;
      if(relation.value<min||relation.value>max)issues.push({path:`initial_relationships.${index}.value`,code:'relationship_out_of_range',message:'初始关系数值超出世界规则',current:relation.value,requirement:`${relation.dimension} 必须在 ${min} 到 ${max} 之间`});
    });
    const checkLocation=(locationId:string|null|undefined,path:string)=>{
      if(locationId&&!locations.has(locationId))issues.push({path,code:'unknown_location',message:'引用了未登记地点',current:locationId,requirement:'引用本候选已登记的地点 ID'});
    };
    checkLocation(result.data.player.location_id,'player.location_id');
    result.data.characters.forEach((character,index)=>checkLocation(character.location_id,`characters.${index}.location_id`));
    result.data.locations?.forEach((location,index)=>checkLocation(location.parent_id,`locations.${index}.parent_id`));
    result.data.routes?.forEach((route,index)=>{
      checkLocation(route.from,`routes.${index}.from`);checkLocation(route.to,`routes.${index}.to`);
    });
    result.data.hidden_truths?.forEach((truth,tIndex)=>truth.evidence.forEach((evidence,eIndex)=>{
      checkLocation(evidence.location_id,`hidden_truths.${tIndex}.evidence.${eIndex}.location_id`);
      if(evidence.anchor_entity_id&&!entityIds.has(evidence.anchor_entity_id))issues.push({
        path:`hidden_truths.${tIndex}.evidence.${eIndex}.anchor_entity_id`,code:'unknown_entity',message:'证据引用了未登记实体',
        current:evidence.anchor_entity_id,requirement:'引用已登记人物或物品 ID'});
    }));
    const incidentIds=new Set((result.data.background_incidents??[]).map(incident=>incident.id));
    const truthIds=new Set((result.data.hidden_truths??[]).map(truth=>truth.id));
    result.data.world_macro_arcs?.forEach((arc,index)=>{
      arc.actor_motivations.forEach((motivation,mIndex)=>{
        if(!entityIds.has(motivation.actor_id))issues.push({path:`world_macro_arcs.${index}.actor_motivations.${mIndex}.actor_id`,code:'unknown_entity',message:'长期主轴引用了未登记人物',current:motivation.actor_id,requirement:'引用已登记人物 ID'});
      });
      arc.truth_refs.forEach((id,rIndex)=>{
        if(!truthIds.has(id))issues.push({path:`world_macro_arcs.${index}.truth_refs.${rIndex}`,code:'unknown_truth',message:'长期主轴引用了未登记隐藏事实',current:id,requirement:'引用已登记隐藏事实 ID'});
      });
      arc.incident_refs.forEach((id,rIndex)=>{
        if(!incidentIds.has(id))issues.push({path:`world_macro_arcs.${index}.incident_refs.${rIndex}`,code:'unknown_incident',message:'长期主轴引用了未登记后台事件',current:id,requirement:'引用已登记后台事件 ID'});
      });
      // A story arc is an executable world commitment, not just a title in GM notes.
      // At least one ordinary clock-driven, non-random opening must be reachable early;
      // later developments and their form remain entirely world-specific.
      const opening=result.data.opening_time?.minute??540;
      const viable=arc.incident_refs.some(id=>{
        const seed=result.data.background_incidents?.find(item=>item.id===id);
        if(!seed||seed.activation_chance!==1||seed.activation_flags.length||
          seed.earliest_activation.day*1440+seed.earliest_activation.minute>1440+opening)return false;
        const first=seed.stages[0];
        return Boolean(first&&!first.required_flags.length&&(first.effects.length||first.exposures.length)&&
          seed.stages.some(stage=>!stage.required_flags.length&&
            stage.exposures.some(exposure=>Boolean(exposure.location_id??seed.locations[0]))));
      });
      if(!viable)issues.push({path:`world_macro_arcs.${index}.incident_refs`,code:'opening_path_missing',
        message:'剧情型世界缺少可由世界时间可靠启动、并有合理公开接触路径的早期事件',
        current:arc.incident_refs,requirement:'关联至少一条独立于玩家搜查、无需未满足 flag、启动概率为 1 的早期事件；首阶段有真实效果或曝光，后续有地点锚定的公开接触机会。事件形式与时间由世界因果决定'});
    });
    return issues;
  }
  return result.error.issues.map(issue=>({
    path:issue.path.map(String).join('.'),code:issue.code,message:issue.message,
    current:valueAt(candidate,issue.path.map(String)),requirement:issue.code==='invalid_format'?'须符合字段的 machine-id 格式':
      issue.code==='too_big'?'不得超过 schema 上限':issue.code==='too_small'?'不得低于 schema 下限':issue.message,
  }));
}

/** The compiler/save validator can reject a schema-valid blueprint. Keep its issue scoped to
 * the authored field where possible; never expose the compiler's raw text to a player. */
export function compiledWorldIssue(error:unknown):WorldIssue{
  const message=error instanceof Error?error.message:String(error);
  const pathMatch=message.match(/(?:^|;\s*)(?:definition\.)?(background_incidents|world_macro_arcs|map\.locations|map\.routes|gm_state\.hidden_truth)(?:\.(\d+))?(?=\.|:)/);
  const root=pathMatch?.[1]==='map.locations'?'locations':pathMatch?.[1]==='map.routes'?'routes':
    pathMatch?.[1]==='gm_state.hidden_truth'?'hidden_truths':pathMatch?.[1];
  const semanticRoot=root??(/长期主轴/.test(message)?'world_macro_arcs':/后台案件|案件|事件阶段/.test(message)?'background_incidents':
    /隐藏事实|证据/.test(message)?'hidden_truths':/地图|地点|路线/.test(message)?'locations':/人物|角色/.test(message)?'characters':null);
  return {path:semanticRoot?`${semanticRoot}${pathMatch?.[2]?`.${pathMatch[2]}`:''}`:'compiled_world',
    code:semanticRoot?'compiled_field_invalid':'semantic_validation',message,current:null,requirement:message};
}

function openingConsistencyIssues(world:z.infer<typeof worldInitializationSchema>):WorldIssue[]{
  const opening=world.opening.trim();
  const first=opening.split(/[。！？!?\n]/)[0]??'';
  const issues:WorldIssue[]=[];
  const start=world.opening_time??{minute:540,calendar:defaultCalendar()};
  const hourWords:Record<string,number>={零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12};
  const clock=first.match(/(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*([0-9]{1,2}|十[一二]?|[零一二三四五六七八九])\s*(?::([0-5][0-9])|(?:点|时)(?:半|([0-9]{1,2})分?)?)/);
  if(clock){
    const raw=/^\d+$/.test(clock[2])?Number(clock[2]):hourWords[clock[2]];
    const hour=(clock[1]==='下午'||clock[1]==='傍晚'||clock[1]==='晚上')&&raw<12?raw+12:raw;
    const minute=clock[0].includes('半')?30:Number(clock[3]??clock[4]??0);
    if(hour*60+minute!==start.minute)issues.push({path:'opening',code:'canonical_time_mismatch',message:'开场时间与权威开局时间不一致',current:opening,requirement:'让 opening 的时间与 opening_time.minute 一致，或删除冲突的具体时间'});
  }
  const weekday=first.match(/(?:星期|周)([一二三四五六日天])/);
  if(weekday&&weekday[1]!==['一','二','三','四','五','六','日'][start.calendar.anchor_weekday-1]&&!(weekday[1]==='天'&&start.calendar.anchor_weekday===7))issues.push({path:'opening',code:'canonical_weekday_mismatch',message:'开场星期与权威日历不一致',current:opening,requirement:'让 opening 的星期与 opening_time.calendar.anchor_weekday 一致，或不写星期'});
  const monthDate=first.match(/(\d{1,2}|[一二三四五六七八九十]+)月(?:的)?(\d{1,2}|[一二三四五六七八九十]+)(?:日|号)/);
  if(monthDate&&(calendarNumber(monthDate[1])!==start.calendar.anchor_month||calendarNumber(monthDate[2])!==start.calendar.anchor_date))
    issues.push({path:'opening',code:'canonical_date_mismatch',message:'开场日期与权威日历不一致',current:opening,requirement:'让 opening 的日期与 opening_time.calendar 一致，或不写绝对日期'});
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
  const roots=/长期主轴|world_macro_arcs/.test(message)?['world_macro_arcs']:/后台案件|案件|事件阶段|background_incidents/.test(message)?['background_incidents']:
    /隐藏事实|证据|hidden_truths/.test(message)?['hidden_truths']:/地图|地点|路线|locations|routes/.test(message)?['locations','routes']:
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

export function publicWorldCreationFailure(issues:WorldIssue[]=[]){
  const semantic=issues.some(issue=>['semantic_validation','compiled_field_invalid'].includes(issue.code));
  const population=issues.some(issue=>['initial_population_mismatch','initial_persona_missing','characters_capability_missing'].includes(issue.code));
  return new GameError(semantic?'新世界候选存在世界规则或引用冲突，限定修复次数已用尽；旧世界没有改变。':
    population?'新世界候选未满足初始人数或人物资料约束，限定修复次数已用尽；旧世界没有改变。':
    '新世界候选的字段结构仍不完整，限定修复次数已用尽；旧世界没有改变。',422);
}
