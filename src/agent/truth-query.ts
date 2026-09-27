import type { PublicView } from '../shared/contracts.js';
import { entityLabel, explicitEntityReference, isSelfReference, resolveEntities, resolveNamedEntity } from './entities.js';

export type TruthStatus = 'FOUND' | 'NOT_FOUND' | 'NOT_DEFINED' | 'UNKNOWN' | 'UNAVAILABLE' | 'AMBIGUOUS';
export type TruthSubject = 'entity' | 'media' | 'money' | 'world_provenance' | 'module' | 'provider';
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
  const provenance=view.world_provenance;
  if(!provenance)return {subject:'world_provenance',status:'UNKNOWN',message:'这个旧存档没有记录创建来源，因此无法确认这是否是创建时声明的前提。'};
  const records=provenance.records.filter(record=>['premise','rule','theme','constraint','trait'].includes(record.kind));
  const matched=records.find(record=>relatedStatement(text,record.statement))??(settingQuestion&&records.length===1?records[0]:null);
  if(!matched)return {subject:'world_provenance',status:'NOT_FOUND',message:'创建记录里没有找到与这个问题对应的声明。'};
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
  if(!/多少钱|有多少钱|余额|钱|铜|金/.test(text))return null;
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
