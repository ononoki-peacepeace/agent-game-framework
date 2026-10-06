import type { PublicView } from '../shared/contracts.js';
import {z} from 'zod';
import type {GameService} from '../server/service.js';
import {relationshipSummary} from '../shared/relationship.js';
import { entityLabel, explicitEntityReference, isSelfReference, resolveEntities, resolveNamedEntity } from './entities.js';
import {observe} from '../observability/index.js';

export type TruthStatus = 'FOUND' | 'NOT_FOUND' | 'NOT_DEFINED' | 'UNKNOWN' | 'UNAVAILABLE' | 'AMBIGUOUS';
export type TruthSubject = 'entity' | 'media' | 'money' | 'world_provenance' | 'module' | 'provider' | 'world_fact';
export interface TruthQueryResult {
  subject: TruthSubject;
  status: TruthStatus;
  message: string;
  entity_id?: string;
  panel?: string;
}

function provenanceTerms(value: string) {
  const normalized=value.toLowerCase().replace(/这个世界|世界观|创建时|最初|是不是|是否|有没有|设定|规则|我的|我有|我|什么|具体|内容|是|有|的|了|吗|呢/g,'').replace(/[^\p{L}\p{N}]/gu,'');
  const terms=new Set<string>();for(let size=2;size<=Math.min(4,normalized.length);size++)for(let i=0;i+size<=normalized.length;i++)terms.add(normalized.slice(i,i+size));return terms;
}
function relatedStatement(query:string,statement:string){
  const q=provenanceTerms(query),s=provenanceTerms(statement);if(!q.size||!s.size)return false;
  let overlap=0;for(const term of q)if(s.has(term))overlap++;return overlap>=Math.min(2,Math.max(1,Math.floor(Math.min(q.size,s.size)*.25)));
}
function queryProvenance(view:PublicView,text:string):TruthQueryResult|null{
  const settingQuestion=/(世界|创建|最初).{0,12}(设定|规则|前提|要求)|设定.{0,12}(是否|是不是|有没有|吗)/.test(text);
  const detailQuestion=/(我的|我有|玩家角色).{0,30}(是什么|有哪些|多少|具体|内容|谁|哪)/.test(text);
  if(!settingQuestion&&!detailQuestion)return null;
  const explicitSourceQuestion=settingQuestion||/(创建|设定|前提)/.test(text);
  const provenance=view.world_provenance;
  if(!provenance)return explicitSourceQuestion?{subject:'world_provenance',status:'UNKNOWN',message:'这个旧存档没有记录创建来源，因此无法确认这是否是创建时声明的前提。'}:null;
  const records=provenance.records.filter(record=>['premise','rule','theme','constraint','trait'].includes(record.kind));
  const matched=records.find(record=>relatedStatement(text,record.statement))??(settingQuestion&&records.length===1?records[0]:null);
  if(!matched)return explicitSourceQuestion?{subject:'world_provenance',status:'NOT_FOUND',message:'创建记录里没有找到与这个问题对应的声明。'}:null;
  const source={PLAYER_DECLARED:'玩家创建时声明',TEMPLATE_DECLARED:'模板声明',AI_GENERATED:'创建流程生成',CANONICAL_INSTANTIATED:'已实例化为世界事实',DERIVED:'由现有事实推导',UNKNOWN:'来源未记录'}[matched.source];
  if(detailQuestion){
    const fact=provenance.records.find(record=>record.kind==='fact'&&record.fact_ref&&relatedStatement(text,record.statement));
    return fact?{subject:'world_provenance',status:'FOUND',message:`已保存的具体事实是：${fact.statement}`}:{subject:'world_provenance',status:'NOT_DEFINED',message:`这个世界确实记录了「${matched.statement}」这一创建前提（${source}），但当前存档还没有保存与你问题对应的具体事实。`};
  }
  return {subject:'world_provenance',status:'FOUND',message:`有。创建记录中的相关内容是「${matched.statement}」（${source}）。`};
}
function queryMedia(view:PublicView,text:string):TruthQueryResult|null{
  if(!(/全身图|全身立绘|头像/.test(text)&&/(有|有没有|是否|存在|已经)/.test(text)))return null;
  const resolved=resolveEntities(view,text),entity=resolved.matches[0]??view.entities.find(item=>item.id===view.player_id);
  if(resolved.matches.length>1)return {subject:'media',status:'AMBIGUOUS',message:`有几个人物符合这个名字：${resolved.matches.map(entityLabel).join('、')}。请说明是哪一位。`,panel:'characters'};
  if(!entity)return {subject:'media',status:'UNKNOWN',message:'当前无法确认你问的是哪一个人物。',panel:'characters'};
  const visuals=entity.components.visual_assets as {images?:Record<string,string>}|undefined,asksFullbody=/全身图|全身立绘/.test(text);
  const exists=asksFullbody?Boolean(visuals?.images?.fullbody):Boolean(entity.components.identity?.avatar_id);
  return {subject:'media',status:exists?'FOUND':'NOT_DEFINED',message:`${entityLabel(entity)}${exists?'已有':'还没有'}${asksFullbody?'全身立绘':'头像'}。`,entity_id:entity.id,panel:'characters'};
}
function queryMoney(view:PublicView,text:string):TruthQueryResult|null{
  if(!/多少钱|余额|钱包|资金|(?:多少|剩|有).{0,8}(?:钱|金币|铜币|现金)/.test(text))return null;
  if(resolveEntities(view,text).matches.some(entity=>entity.id!==view.player_id))return null;
  const balances=(view.entities.find(entity=>entity.id===view.player_id)?.components.wallet?.balances??{}) as Record<string,number>,entries=Object.entries(balances);
  return entries.length
    ? {subject:'money',status:'FOUND',message:`你现在有 ${entries.map(([currency,amount])=>`${amount} ${view.currencies[currency]??currency}`).join('、')}。`,panel:/背包/.test(text)?'inventory':'status'}
    : {subject:'money',status:'NOT_DEFINED',message:'这个世界没有为你记录金钱。',panel:/背包/.test(text)?'inventory':'status'};
}

export interface RuntimeTruthContext {
  text_provider: string | null;
  image_provider: string | null;
}
/** Runtime availability uses the same six-state vocabulary as canonical world queries. */
export function queryRuntimeTruth(view:PublicView,text:string,runtime:RuntimeTruthContext):TruthQueryResult|null{
  if(/(图片|图像|头像).{0,12}(生成|模型服务|服务).{0,8}(可用|接入|有没有|是否)|能不能.{0,8}(生成|画).{0,6}(图片|头像)/.test(text)){
    return runtime.image_provider
      ? {subject:'media',status:'FOUND',message:`图片生成已接入（${runtime.image_provider}）。`}
      : {subject:'media',status:'UNAVAILABLE',message:'图片生成模型服务尚未接入；当前不能生成新图片。'};
  }
  if(/(文本|对话).{0,8}(模型|AI|提供者|模型服务).{0,8}(可用|接入|哪个|什么)/i.test(text)){
    return runtime.text_provider
      ? {subject:'provider',status:'FOUND',message:`当前文本 AI 是 ${runtime.text_provider}。`}
      : {subject:'provider',status:'UNAVAILABLE',message:'当前没有可用的文本 AI。'};
  }
  const mentioned=view.modules.find(module=>text.includes(module.id));
  if(mentioned&&/(模块|系统|功能).{0,8}(可用|启用|开启|有没有|是否)|有没有.{0,8}(模块|系统|功能)/.test(text)){
    return {subject:'module',status:mentioned.enabled?'FOUND':'UNAVAILABLE',message:`${mentioned.id}${mentioned.enabled?'已启用':'存在，但当前已停用'}。`};
  }
  return null;
}
/** One read-only boundary for canonical world truth. It never invents absent state. */
export function queryWorldTruth(view:PublicView,text:string):TruthQueryResult|null{
  const media=queryMedia(view,text);if(media)return media;
  const money=queryMoney(view,text);if(money)return money;
  const provenance=queryProvenance(view,text);if(provenance)return provenance;
  const reference=explicitEntityReference(text);
  if(reference&&!isSelfReference(reference)){
    const exact=resolveNamedEntity(view,reference);
    return exact
      ? {subject:'entity',status:'FOUND',message:`找到了${entityLabel(exact)}。`,entity_id:exact.id,panel:'characters'}
      : {subject:'entity',status:'NOT_FOUND',message:`没有找到名为「${reference}」的人物。`,panel:'characters'};
  }
  return null;
}

const derivedQuerySchema=z.strictObject({status:z.enum(['FOUND','UNKNOWN']),
  kind:z.enum(['fact','inference','rule_judgment']),answer:z.string().min(1).max(700),
  evidence_ids:z.array(z.string()).max(12),rule_evidence_ids:z.array(z.string()).max(8),
  missing_information:z.array(z.string().min(1).max(160)).max(4)});

interface QueryEvidence {id:string;kind:'state'|'observation'|'rule';value:unknown}
/** Only Registry-projected public fields are eligible, including optional module fields.
 * Scalar paths make a citation precise; null is explicitly unknown, never a guessed value. */
export function worldQueryEvidence(view:PublicView,text:string):QueryEvidence[]{
  const player=view.entities.find(entity=>entity.id===view.player_id);
  const evidence:QueryEvidence[]=[
    {id:'time',kind:'state',value:{...view.time,label:view.time_label??null}},
    {id:'calendar',kind:'state',value:view.calendar??null},
    ...(view.last_turn?.narrative?[{id:'scene',kind:'observation' as const,value:view.last_turn.narrative.slice(0,1800)}]:[]),
    ...(player?.components.location?[{id:'location',kind:'state' as const,value:view.locations.find(place=>place.id===player.components.location?.location_id)??null}]:[]),
    ...view.locations.map(place=>({id:`location:${place.id}`,kind:'state' as const,value:place})),
    ...view.routes.map((route,index)=>({id:`route:${index}`,kind:'state' as const,value:route})),
    ...(view.scheduled_tasks??[]).filter(task=>!task.resolved).slice(0,12).map(task=>({id:`schedule:${task.id}`,kind:'state' as const,value:task})),
    ...view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character).slice(0,12).map(entity=>({id:`relationship:${entity.id}`,kind:'state' as const,value:relationshipSummary(view,entity).text})),
  ];
  const named=resolveEntities(view,text).matches;
  const subjects=[...new Set([...named.map(entity=>entity.id),view.player_id,...view.entities.map(entity=>entity.id)])];
  const fields:QueryEvidence[]=[];
  function addFields(path:string,value:unknown,depth=0){
    if(fields.length>=400||depth>7)return;
    if(value===null||['string','number','boolean'].includes(typeof value)){
      fields.push({id:path,kind:'state',value:typeof value==='string'?value.slice(0,800):value});return;
    }
    if(value&&typeof value==='object'){
      const entries=Object.entries(value);
      if(!entries.length){fields.push({id:path,kind:'state',value:Array.isArray(value)?[]:{}});return;}
      for(const [key,child] of entries)addFields(`${path}.${key}`,child,depth+1);
    }
  }
  for(const id of subjects){
    const entity=view.entities.find(item=>item.id===id)!;
    addFields(`entity:${id}`,entity.components);
  }
  evidence.push(...fields);
  const rules=[...(view.world_provenance?.declared_rules??[]),
    ...(view.world_provenance?.records??[]).filter(record=>record.kind==='rule'&&record.source!=='UNKNOWN').map(record=>record.statement)];
  for(const [index,rule] of [...new Set(rules)].entries())evidence.push({id:`rule:${index}`,kind:'rule',value:rule});
  return evidence;
}
/** Bounded read-only judgement over player-visible observations, never over GM notes or hidden truth. */
export async function deriveWorldQuery(service:GameService,view:PublicView,text:string):Promise<TruthQueryResult>{
  const save=await service.current();
  const evidence=worldQueryEvidence(view,text);
  const answer=await service.ai.systemAgent(derivedQuerySchema,save.definition.prompt_profile,{
    instruction:'只查询给定的已登记、玩家可见资料，不执行调查、观察、行动或状态修改。我/自己默认指 player_id。kind=fact 表示直接读取属性、身份、时间、日期、位置、余额、背包或已知关系；inference 表示结合已有公开证据推导；rule_judgment 表示资格、法律、年龄门槛或其他规则适用判断。实体存在不等于没有更多信息，必须检查其具体字段。当前结构化状态优先于旧场景描写。null、未提供字段及不完整名单不能证明事实为否。FOUND 必须引用实际支持答案的 evidence_ids；rule_judgment 还必须引用明确适用的 kind=rule 证据到 rule_evidence_ids。不能仅凭世界标题、现代/日本等题材标签或模型常识引入法律和门槛；不能将一个活动的年龄门槛用于另一个活动，多个冲突规则也不能自行挑选。规则或事实不足时 status=UNKNOWN，missing_information 说明缺少什么，answer 可以同时告知有证据支持的已知部分。不能推断秘密、执行主动感知或虚构调查结果。不要把人物内部 ID 或字段路径展示给玩家。仅输出 JSON。',
    question:text,evidence,player_id:view.player_id,public_entities:view.entities.map(entity=>({id:entity.id,name:entity.components.identity?.name??null,role:entity.components.character?.role??null,location:entity.components.location??null})),
  },{...save,ai:{threads:{}}});
  const valid=Boolean(answer&&answer.evidence_ids.every(id=>evidence.some(item=>item.id===id))&&
    answer.rule_evidence_ids.every(id=>evidence.some(item=>item.id===id&&item.kind==='rule'))&&
    (answer.status!=='FOUND'||answer.evidence_ids.length>0&&answer.missing_information.length===0&&
      (answer.kind!=='rule_judgment'||answer.rule_evidence_ids.length>0)));
  observe('info','agent.query.evaluated',{module:'agent',metadata:{revision:view.revision,
    kind:answer?.kind??null,status:valid?answer?.status:'UNKNOWN',validated:valid,
    evidence_ids:answer?.evidence_ids??[],rule_evidence_ids:answer?.rule_evidence_ids??[]}});
  if(!valid||!answer)return {subject:'world_fact',status:'UNKNOWN',message:'当前世界状态无法确定这个问题的答案；缺少有效的公开事实或适用规则依据。'};
  if(answer.status==='FOUND')return {subject:'world_fact',status:'FOUND',message:answer.answer};
  const missing=answer.missing_information.join('、');
  return {subject:'world_fact',status:'UNKNOWN',message:missing?
    `${answer.evidence_ids.length?answer.answer+'\n':''}当前世界状态无法确定：缺少${missing}。`:'当前世界状态无法确定这个问题的答案。'};
}
