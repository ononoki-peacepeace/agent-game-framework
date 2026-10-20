import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,GameError,type SavePackage} from './schema.js';
import {currentMap} from './map.js';
import {publicView} from './state.js';
import {createRegistry} from '../modules/index.js';
import {executeAction} from './runtime.js';
import {prepareCheck,resolveCheck} from './resolution.js';
import {putItemInInventory} from '../modules/inventory.js';
import {observe} from '../observability/index.js';
import {WorldBlockedError} from '../agent/outcome.js';
import {environmentQuerySchema,environmentAssessmentSchema,type EnvironmentQuery,type EnvironmentAssessment,
  environmentSurveyProposalSchema,type EnvironmentSurveyProposal,
  type EnvironmentResolution,type EnvironmentReceipt} from './environment-schema.js';

const key=(name:string)=>name.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・._-]+/g,'');
const resolutionId=(save:SavePackage,here:string,name:string,containerId?:string|null)=>'env_'+createHash('sha256')
  .update(`${save.game_id}:${here}:${containerId??'room'}:${key(name)}`).digest('hex').slice(0,32);
const locationOf=(save:SavePackage,actorId=save.player_state.entity_id)=>
  String(save.entities.find(e=>e.id===actorId)?.components.location?.location_id??'');
type Lookup={record?:EnvironmentResolution;entity?:SavePackage['entities'][number];restricted?:boolean};
function inspectableContained(save:SavePackage,entity:SavePackage['entities'][number],scope:string|null,
  actorId:string,here:string){
  if(!scope||entity.components.item?.container_id!==scope||entity.components.location?.location_id!==here)return false;
  const tags=entity.components.item.tags as string[]|undefined;
  if(tags?.includes('sealed')||tags?.includes('evidence')||
    entity.components.item.owner_id&&entity.components.item.owner_id!==actorId)return false;
  if(entity.components.discovery?.known_to_player===false&&!tags?.includes('ordinary'))return false;
  return !(save.gm_state.hidden_truth?.commitments??[]).some(truth=>truth.evidence.some(e=>
    e.placement?.anchor_entity_id===entity.id||e.placement?.anchor_entity_id===scope));
}
export class EnvironmentQueryError extends GameError{
  readonly failure_stage='environment_query_binding';readonly failure_engine_code='schema_failure';
  readonly diagnostics=[{path:'environment_query.source_quote',code:'authorization_quote',expected:'当前阶段完整原文，包含所查询物体的原文名称'}];
}
export class EnvironmentAdmissionError extends GameError{
  readonly failure_stage='environment_admission';readonly failure_engine_code='schema_failure';
  constructor(readonly failure_code:string,readonly field:string,message:string){
    super(message,503);
    observe('warn','environment.admission.rejected',{module:'core',metadata:{failure_code,field,stage:this.failure_stage}});
  }
}
export function environmentVisibleItems(save:SavePackage,actorId=save.player_state.entity_id){
  const here=locationOf(save,actorId),actor=save.entities.find(e=>e.id===actorId)!;
  const owned=actor.components.inventory?.items as Record<string,number>|undefined;
  const publicIds=actorId===save.player_state.entity_id?
    new Set(publicView(save).entities.filter(e=>e.components.item).map(e=>e.id)):
    new Set(save.entities.filter(e=>e.components.item&&((owned?.[e.id]??0)>0||e.components.location?.location_id===here)&&
      !(save.environment_state?.resolutions??[]).some(r=>r.entity_id===e.id&&r.known_by&&!r.known_by.includes(actorId)))
      .map(e=>e.id));
  return save.entities.filter(e=>e.components.item&&publicIds.has(e.id)&&
    (actorId!==save.player_state.entity_id||e.components.discovery?.known_to_player!==false)&&
    ((owned?.[e.id]??0)>0||e.components.location?.location_id===here));
}

/** Global identity checks prevent cloning remote/hidden/owned definitions. They do NOT reveal them. */
function lookup(save:SavePackage,query:EnvironmentQuery,actorId=save.player_state.entity_id):Lookup|null{
  const here=locationOf(save,actorId),records=save.environment_state?.resolutions??[];
  const scope=query.container_id??null;
  const inScope=(entity:SavePackage['entities'][number])=>(entity.components.item?.container_id??null)===scope;
  const record=records.find(r=>r.location_id===here&&(r.container_id??null)===scope&&
    [r.name,...r.aliases].some(name=>key(name)===key(query.name)));
  const completeSurvey=scope?save.environment_state?.surveys?.filter(s=>s.location_id===here&&
    s.container_id===scope&&(s.complete_empty||s.complete_contents)&&s.known_by.includes(actorId)).at(-1):undefined;
  if(record?.status==='absent'){
    // An old failed search remains historical evidence. A later real item
    // movement into this scene is an objective change, not a redraw of the
    // old World Gap decision.
    const visible=new Set(environmentVisibleItems(save,actorId).map(e=>e.id));
    const owned=(save.entities.find(e=>e.id===actorId)?.components.inventory?.items??{}) as Record<string,number>;
    const arrived=save.entities.filter(e=>e.components.item&&inScope(e)&&
      Number(e.components.item.placed_sequence??0)>Number(record.sequence??0)&&
      key(String(e.components.identity?.name??''))===key(query.name)&&
      (visible.has(e.id)||inspectableContained(save,e,scope,actorId,here))&&
      ((owned[e.id]??0)>0||e.components.location?.location_id===here));
    if(arrived.length===1)return {entity:arrived[0]};
    if(save.entities.some(e=>e.components.item&&inScope(e)&&
      key(String(e.components.identity?.name??''))===key(query.name)&&
      ((owned[e.id]??0)>0||e.components.location?.location_id===here)))return {restricted:true};
    return {record};
  }
  // A portable object established in a different scene may physically arrive
  // here later. It stays private until this actor explicitly checks for it in
  // the current scene, then the original objective record gains an observer.
  if(query.intent==='observe'){
    const arrivals=save.entities.flatMap(entity=>{
      if(!entity.components.item||!inScope(entity)||entity.components.location?.location_id!==here||
        key(String(entity.components.identity?.name??''))!==key(query.name))return [];
      const origin=records.find(r=>r.entity_id===entity.id&&r.status==='present'&&
        r.classification==='ordinary_item'&&r.known_by&&!r.known_by.includes(actorId));
      return origin?[{record:origin,entity}]:[];
    });
    if(arrivals.length===1)return arrivals[0];
  }
  if(record?.known_by&&!record.known_by.includes(actorId)){
    // A portable ordinary item established by another actor is one objective
    // object. A later explicit same-scene check may discover it; private scene
    // details and protected/absent facts stay private until a richer search gate.
    if(record.status==='present'&&record.classification==='ordinary_item'&&query.intent==='observe'&&
      record.entity_id&&save.entities.find(e=>e.id===record.entity_id)?.components.location?.location_id===here&&
      inScope(save.entities.find(e=>e.id===record.entity_id)!))
      return {record,entity:record.entity_id?save.entities.find(e=>e.id===record.entity_id):undefined};
    return {restricted:true};
  }
  if(!record&&completeSurvey){
    const matching=save.entities.filter(e=>e.components.item&&inScope(e)&&
      e.components.location?.location_id===here&&key(String(e.components.identity?.name??''))===key(query.name));
    if(matching.length===1&&Number(matching[0].components.item?.placed_sequence??0)>Number(completeSurvey.sequence??0))
      return {entity:matching[0]};
    if(matching.length)return {restricted:true};
    return null;
  }
  const matches=save.entities.filter(e=>e.components.item&&key(String(e.components.identity?.name??''))===key(query.name));
  if(matches.length){
    const visible=new Set(environmentVisibleItems(save,actorId).map(e=>e.id));
    const owned=(save.entities.find(e=>e.id===actorId)?.components.inventory?.items??{}) as Record<string,number>;
    const accessible=matches.filter(e=>inScope(e)&&(visible.has(e.id)||inspectableContained(save,e,scope,actorId,here))&&
      ((owned[e.id]??0)>0||e.components.location?.location_id===here));
    if(accessible.length===1)return {entity:accessible[0],record:record?.entity_id===accessible[0].id?record:undefined};
    // Neither hidden existence nor remote ownership is disclosed to the player.
    return {restricted:true};
  }
  if(record)return {record,entity:record.entity_id?save.entities.find(e=>e.id===record.entity_id):undefined};
  // Undefined bindings must not materialize protected commitments or repair a
  // biography's missing possessions. This check stays in Core, outside the model prompt.
  const protectedText=[...(save.gm_state.hidden_truth?.commitments??[]).flatMap(truth=>
    [truth.statement,...truth.evidence.map(e=>e.description)]),
    ...save.entities.filter(e=>e.components.character).map(e=>String(e.components.identity?.description??''))];
  if(protectedText.some(text=>text.includes(query.name)))return {restricted:true};
  return null;
}

export function validateEnvironmentQuery(input:string,raw:unknown):EnvironmentQuery{
  const query=environmentQuerySchema.parse(raw);
  if(query.source_quote!==input.trim()||!query.source_quote.includes(query.name))
    throw new EnvironmentQueryError('环境查询必须完整引用当前阶段的原始授权，并包含实际查找名称',503);
  return query;
}
export function environmentContext(save:SavePackage,queryText?:string,actorId=save.player_state.entity_id,containerId:string|null=null){
  const here=locationOf(save,actorId),scene=currentMap(save).locations.find(location=>location.id===here);
  return {world_description:save.definition.meta.description,location_id:here,scene_description:scene?.description??'',
    prior_resolutions:(save.environment_state?.resolutions??[]).filter(r=>r.location_id===here&&
      (r.container_id??null)===containerId&&
      (!r.known_by||r.known_by.includes(actorId))&&
      (queryText===undefined||[r.name,...r.aliases].some(name=>key(queryText).includes(key(name)))))
      .map(r=>({id:r.id,name:r.name,aliases:r.aliases,status:r.status,description:r.description})),
    inventory_enabled:save.definition.enabled_modules.includes('inventory'),
    limits:{portable_per_location:3,portable_per_world:24,total_records:128}};
}

function admit(save:SavePackage,query:EnvironmentQuery,assessment:EnvironmentAssessment|undefined,requestId:string,
  actorId=save.player_state.entity_id):Lookup&{budget?:boolean}{
  const containerId=query.container_id??null;
  if(containerId){
    const container=save.entities.find(e=>e.id===containerId);
    if(!container?.components.item?.container||
      container.components.location?.location_id!==locationOf(save,actorId)||
      (container.components.item.owner_id&&container.components.item.owner_id!==actorId)||
      !query.source_quote.includes(String(container.components.identity?.name??''))||
      (container.components.item.tags as string[]|undefined)?.includes('sealed'))
      throw new EnvironmentAdmissionError('invalid_container_scope','container_id','容器不在当前可检查范围，或原文未授权检查该容器');
  }
  const existing=lookup(save,query,actorId);
  if(existing){
    if(existing.record?.known_by&&!existing.record.known_by.includes(actorId)&&
      existing.record.status==='present'&&existing.record.classification==='ordinary_item'&&query.intent==='observe')
      existing.record.known_by.push(actorId);
    return existing;
  }
  const here=locationOf(save,actorId);
  const completeSurvey=containerId?save.environment_state?.surveys?.filter(s=>s.location_id===here&&
    s.container_id===containerId&&(s.complete_empty||s.complete_contents)&&s.known_by.includes(actorId)).at(-1):undefined;
  if(completeSurvey){
    if((save.environment_state?.resolutions.length??0)>=128)return {restricted:true,budget:true};
    const record:EnvironmentResolution={id:resolutionId(save,here,query.name,containerId),location_id:here,
      container_id:containerId!,name:query.name,aliases:[],status:'absent',classification:'ordinary_item',
      entity_id:null,description:'此前对该容器的充分检查未发现该对象。',take_allowed:false,
      source_request_id:requestId,at:structuredClone(completeSurvey.at),sequence:completeSurvey.sequence,known_by:[actorId]};
    save.environment_state!.resolutions.push(record);
    return {record};
  }
  assert(assessment,'未定义的环境对象缺少受限世界判定');
  const a=environmentAssessmentSchema.parse(assessment),context=environmentContext(save,undefined,actorId,containerId);
  if(a.authorized_intent!==query.intent)throw new EnvironmentAdmissionError('authorization_mismatch','authorized_intent','环境判定的操作类型与玩家授权不一致');
  if(!a.basis.every(b=>(b.source==='world'?context.world_description:context.scene_description).includes(b.quote)))
    throw new EnvironmentAdmissionError('unbound_context','basis','环境判定引用的年代或场景依据不属于当前权威资料');
  const records=save.environment_state?.resolutions??[];
  if(a.same_as){
    const same=records.find(r=>r.id===a.same_as&&r.location_id===here&&(r.container_id??null)===containerId);
    if(!same||same.known_by&&!same.known_by.includes(actorId))
      throw new EnvironmentAdmissionError('invalid_resolution_reference','same_as','环境判定引用了当前行动者不可使用的旧裁决');
    if(same.aliases.length<8&&!same.aliases.includes(query.name))same.aliases.push(query.name);
    return {record:same,entity:same.entity_id?save.entities.find(e=>e.id===same.entity_id):undefined};
  }
  if(records.length>=128)return {restricted:true,budget:true};
  const ordinary=['ordinary_item','environment_detail'].includes(a.classification);
  const allowed=ordinary&&a.existence!=='undetermined'&&!a.contradicts_known&&!a.resource_advantage&&
    (a.existence==='absent'||a.world_compatible&&a.scene_compatible)&&
    (a.existence==='absent'||['unclaimed','shared'].includes(a.ownership));
  const portable=a.classification==='ordinary_item';
  const generated=records.filter(r=>r.entity_id);
  const budget=portable&&a.existence==='present'&&
    (generated.length>=24||generated.filter(r=>r.location_id===here).length>=3||save.entities.length>=500);
  const status=!allowed||budget?'unresolved':a.existence==='present'?'present':'absent';
  save.environment_state??={resolutions:[]};
  save.environment_state.sequence=(save.environment_state.sequence??0)+1;
  const record:EnvironmentResolution={id:resolutionId(save,here,query.name,containerId),location_id:here,name:query.name,aliases:[],
    ...(containerId?{container_id:containerId}:{}),
    sequence:save.environment_state.sequence,
    status,classification:!allowed||budget?'restricted':portable?'ordinary_item':'environment_detail',entity_id:null,
    // The assessor classifies, but its free prose cannot introduce clues or properties.
    description:status==='present'?`${query.name}，本次普通环境检查确认的${portable?'日常物品':'环境细节'}。`:
      status==='absent'?'在本次检查范围内未发现该对象。':'本次未能确认可供使用的普通对象。',
    take_allowed:status==='present'&&portable&&a.ownership==='unclaimed',
    source_request_id:requestId,at:structuredClone(save.runtime.time),known_by:[actorId]};
  if(status==='present'&&portable){
    if(!save.definition.enabled_modules.includes('inventory'))throw new WorldBlockedError('unavailable','当前世界未启用物品存取能力；尚未登记或取得这件物品。');
    const entityId='item_'+record.id.slice(4);
    assert(!save.entities.some(e=>e.id===entityId),'环境对象稳定标识发生冲突');
    save.entities.push({id:entityId,type:'item',components:{identity:{name:query.name,description:record.description,
      avatar_id:null,gender:null,age:null},location:{location_id:here},item:{weight:a.weight,stackable:false,
      container:false,...(containerId?{container_id:containerId}:{}),tags:['ordinary','gap_generated','non_tradeable',...(record.take_allowed?[]:['shared_fixture'])],tracking:'tracked'}}});
    record.entity_id=entityId;
  }
  save.environment_state.resolutions.push(record);
  observe('info','environment.resolved',{module:'core',request_id:requestId,metadata:{
    resolution_id:record.id,status:record.status,classification:record.classification,created_entity:Boolean(record.entity_id),budget}});
  return {record,entity:record.entity_id?save.entities.find(e=>e.id===record.entity_id):undefined,budget};
}

/** A broad look fixes only the obvious ordinary contents of this leaf scene. Its
 * first result is authoritative; later looks disclose that result to this actor. */
export function isBroadSceneObservation(input:string){
  const words=input.trim().replace(/[。.!！?？\s]+$/g,'');
  return /^(?:我)?(?:观察|打量|看看|看一看|查看)(?:一下|一眼)?(?:这个|这间|整个)(?:书房|房间|屋内|室内|场景|环境)$/.test(words);
}
/** Only an explicitly named, reachable container can receive a first overview. */
export function broadContainerObservation(save:SavePackage,input:string,actorId=save.player_state.entity_id){
  const phrase=input.trim().replace(/[。.!！?？\s]+$/g,'');
  const match=phrase.match(/^(?:我)?(?:观察|查看|看看|看一看|检查)(?:一下)?(.{2,80}?)(?:里|里面|内部)(?:有(?:些)?什么|有什么东西|的东西|的内容)?$/)
    ??phrase.match(/^(?:我)?(?:彻底|仔细|逐一)(?:检查|查看)(.{2,80}?)(?:里|里面|内部)(?:(?:是否|是不是)?(?:为)?空(?:的)?|(?:有(?:些)?什么|有什么东西|全部内容|所有东西|的全部内容))$/);
  if(!match)return null;
  const here=locationOf(save,actorId);
  const matches=environmentVisibleItems(save,actorId).filter(e=>e.components.item?.container===true&&
    e.components.location?.location_id===here&&String(e.components.identity?.name??'')===match[1]&&
    (!e.components.item.owner_id||e.components.item.owner_id===actorId)&&
    !(e.components.item.tags as string[]|undefined)?.includes('sealed'));
  return matches.length===1?matches[0].id:null;
}
export const explicitCompleteContainerCheck=(input:string)=>/(?:彻底|仔细|逐一)(?:检查|查看)/.test(input)&&
  /(?:空|全部|所有|有些什么|有什么东西)/.test(input);

export function executeSceneSurvey(save:SavePackage,input:string,proposal:EnvironmentSurveyProposal|undefined,
  requestId:string,actorId=save.player_state.entity_id,containerId:string|null=null){
  assert(containerId?broadContainerObservation(save,input,actorId)===containerId:isBroadSceneObservation(input),
    '环境概览必须由当前行动明确授权');
  const here=locationOf(save,actorId);
  assert(here&&currentMap(save).locations.some(l=>l.id===here),'当前权威地点不存在');
  const existing=save.environment_state?.surveys?.filter(s=>s.location_id===here&&(s.container_id??null)===containerId).at(-1);
  const upgrading=Boolean(containerId&&existing&&!existing.complete_empty&&!existing.complete_contents&&
    explicitCompleteContainerCheck(input));
  if(!existing)assert(proposal,'首次场景观察缺少受限环境提案');
  const candidate=proposal?environmentSurveyProposalSchema.parse(proposal):undefined;
  if(candidate?.complete_empty){
    const a=candidate.empty_assessment,context=environmentContext(save,undefined,actorId,containerId);
    if(!containerId||candidate.features.length||!explicitCompleteContainerCheck(input)||!a||
      a.authorized_intent!=='observe'||!a.scope_complete||a.existence!=='absent'||
      a.classification!=='ordinary_item'||a.same_as!==null||a.contradicts_known||
      a.resource_advantage||!a.world_compatible||!a.scene_compatible||
      !a.basis.every(b=>(b.source==='world'?context.world_description:context.scene_description).includes(b.quote)))
      throw new EnvironmentAdmissionError('invalid_empty_scope','empty_assessment',
        '完整空容器判断缺少与当前授权和权威场景相符的依据');
  }
  if(candidate?.complete_contents){
    const a=candidate.contents_assessment,context=environmentContext(save,undefined,actorId,containerId);
    if(!containerId||candidate.complete_empty||!candidate.features.length||!explicitCompleteContainerCheck(input)||!a||
      a.authorized_intent!=='observe'||!a.scope_complete||a.existence!=='absent'||
      a.classification!=='ordinary_item'||a.same_as!==null||a.contradicts_known||
      a.resource_advantage||!a.world_compatible||!a.scene_compatible||
      !a.basis.every(b=>(b.source==='world'?context.world_description:context.scene_description).includes(b.quote)))
      throw new EnvironmentAdmissionError('invalid_complete_scope','contents_assessment',
        '非空容器穷尽判断缺少与当前授权和权威场景相符的剩余范围依据');
  }
  const actor=save.entities.find(e=>e.id===actorId&&e.components.character);
  assert(actor&&Number(actor.components.condition?.hp??1)>0,'当前人物不能观察场景');
  const registry=createRegistry(save.definition.enabled_modules);
  registry.actions.register('FREEFORM_ACTION',{parameters:z.strictObject({}),execute(c){
    let survey=c.save.environment_state?.surveys?.filter(s=>s.location_id===here&&(s.container_id??null)===containerId).at(-1);
    if(!survey||upgrading&&candidate&&(candidate.complete_empty||candidate.complete_contents)){
      const ids:string[]=[];
      const completeEmpty=Boolean(containerId&&candidate?.complete_empty&&candidate.features.length===0&&
        explicitCompleteContainerCheck(input)&&
        !c.save.entities.some(e=>e.components.item?.container_id===containerId)&&
        !(c.save.environment_state?.resolutions??[]).some(r=>r.container_id===containerId&&r.status==='present')&&
        !(c.save.gm_state.hidden_truth?.commitments??[]).some(truth=>truth.evidence.some(e=>
          e.placement?.anchor_entity_id===containerId||e.placement?.location_id===here)));
      for(const feature of candidate?.features??[]){
        const a=feature.assessment;
        if(a.authorized_intent!=='observe'||!a.scope_complete||a.existence!=='present'||
          !['ordinary_item','environment_detail'].includes(a.classification)||a.resource_advantage||
          a.contradicts_known||!a.world_compatible||!a.scene_compatible||
          !['unclaimed','shared'].includes(a.ownership))continue;
        const result=admit(c.save,{name:feature.name,source_quote:input,intent:'observe',...(containerId?{container_id:containerId}:{})},a,requestId,actorId);
        if(result.record?.status==='present'&&!ids.includes(result.record.id))ids.push(result.record.id);
      }
      const contained=c.save.entities.filter(e=>e.components.item?.container_id===containerId&&
        e.components.location?.location_id===here);
      const completeContents=Boolean(containerId&&candidate?.complete_contents&&ids.length===candidate.features.length&&
        ids.length>0&&contained.length===ids.length&&contained.every(entity=>ids.some(id=>
          c.save.environment_state?.resolutions.find(r=>r.id===id)?.entity_id===entity.id))&&
        !(c.save.gm_state.hidden_truth?.commitments??[]).some(truth=>truth.evidence.some(e=>
          e.placement?.anchor_entity_id===containerId||e.placement?.location_id===here)));
      c.save.environment_state??={resolutions:[]};
      c.save.environment_state.surveys??=[];
      assert(c.save.environment_state.surveys.length<128,'场景概览数量已达上限');
      c.save.environment_state.sequence=(c.save.environment_state.sequence??0)+1;
      survey={location_id:here,...(containerId?{container_id:containerId}:{}),source_request_id:requestId,at:structuredClone(c.save.runtime.time),
        record_ids:ids.slice(0,3),known_by:[actorId],...(completeEmpty?{complete_empty:true}:{}),
        ...(completeContents?{complete_contents:true}:{}),
        sequence:c.save.environment_state.sequence};
      c.save.environment_state.surveys.push(survey);
    }else if(!survey.known_by.includes(actorId))survey.known_by.push(actorId);
    const names:string[]=[];
    let unconfirmedCurrentContents=false;
    for(const id of survey.record_ids){
      const record=c.save.environment_state?.resolutions.find(r=>r.id===id);
      if(!record||record.status!=='present')continue;
      if(record.entity_id){
        const entity=c.save.entities.find(e=>e.id===record.entity_id);
        if(!entity||entity.components.location?.location_id!==here||
          (entity.components.item?.container_id??null)!==containerId)continue;
      }
      if(record.known_by&&!record.known_by.includes(actorId))record.known_by.push(actorId);
      names.push(record.name);
    }
    if((survey.complete_empty||survey.complete_contents)&&containerId){
      for(const entity of c.save.entities.filter(e=>e.components.item?.container_id===containerId&&
        e.components.location?.location_id===here&&
        Number(e.components.item.placed_sequence??0)>Number(survey.sequence??0))){
        if(!inspectableContained(c.save,entity,containerId,actorId,here)){
          unconfirmedCurrentContents=true;continue;
        }
        const origin=c.save.environment_state?.resolutions.find(r=>r.entity_id===entity.id&&r.status==='present');
        if(origin?.known_by&&!origin.known_by.includes(actorId))origin.known_by.push(actorId);
        names.push(String(entity.components.identity?.name??'物品'));
      }
    }
    c.advance(1);
    const check=prepareCheck(c.save,requestId,{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:containerId?'查看当前容器':'观察当前场景'},actor.id);
    resolveCheck(c.save,check,c.rng);
    c.facts.push(unconfirmedCurrentContents?'先前的完整检查记录仍在，但这次不能确认当前容器的全部内容。':
      survey.complete_empty&&names.length?`你再次检查当前容器，发现后来放入的${names.join('、')}。`:
      survey.complete_empty?'你充分检查了当前容器，确认在这次检查时它是空的。':
      survey.complete_contents?`你充分检查当前容器，当前确认的内容为${names.length?names.join('、'):'空'}。`:
      names.length?`你查看${containerId?'当前容器':'当前场景'}，确认了${names.join('、')}。`:
      `你查看${containerId?'当前容器':'当前场景'}，没有确认新的显著普通物品。`,
      '本次观察经过 1 分钟。');
  }});
  const turn=executeAction(save,{type:'FREEFORM_ACTION',parameters:{}},requestId,'ai',undefined,registry,true,actorId,
    actorId!==save.player_state.entity_id);
  const receipt=turn.save.resolution_receipts!.find(r=>r.request_id===requestId)!;
  receipt.semantic_action=actorId===save.player_state.entity_id?input.slice(0,1000):'INSPECT';
  if(actorId===save.player_state.entity_id)
    turn.save.last_turn={narrative:turn.facts.join(' '),speaker:null,dialogue:null,choices:[],context_actions:[]};
  return turn;
}

/** Share the World Gap admission record with ordinary local movement. A scene
 * detail is a physical anchor, not a new map location or an inventory item. */
export function resolveLocalSceneAnchor(save:SavePackage,query:EnvironmentQuery,
  assessment:EnvironmentAssessment|undefined,requestId:string){
  if(assessment&&!assessment.scope_complete)throw new EnvironmentAdmissionError('incomplete_scope','scope_complete',
    '局部目标的世界判定没有覆盖这一步的完整授权');
  if(assessment?.existence==='present'&&assessment.classification!=='environment_detail')
    throw new EnvironmentAdmissionError('invalid_local_anchor','classification','可移动的局部目标必须是场景设施，不能由普通物品代替');
  const result=admit(save,query,assessment,requestId);
  return result.record?.status==='present'&&result.record.classification==='environment_detail';
}

/** One scoped internal Core action. The normal service owns checkpoint, commit, idempotency and Narrator. */
export function executeEnvironmentQuery(save:SavePackage,input:string,raw:unknown,minutes:number,
  assessment:EnvironmentAssessment|undefined,requestId:string,actorId=save.player_state.entity_id){
  const query=validateEnvironmentQuery(input,raw),here=locationOf(save,actorId);
  if(assessment?.authorized_intent!==query.intent)throw new EnvironmentAdmissionError('authorization_mismatch','authorized_intent','环境查询尚未通过本次原始请求的操作范围核对');
  if(!assessment.scope_complete)throw new EnvironmentAdmissionError('incomplete_scope','scope_complete','本次环境查询没有覆盖当前阶段的完整授权；其他行动尚未执行');
  assert(here&&currentMap(save).locations.some(l=>l.id===here),'当前权威地点不存在');
  const actor=save.entities.find(e=>e.id===actorId&&e.components.character)!;
  assert(actor&&Number(actor.components.condition?.hp??1)>0&&
    (actorId!==save.player_state.entity_id||!save.foreground?.blocker),'当前状态不能检查环境');
  const registry=createRegistry(save.definition.enabled_modules);
  let outcome:EnvironmentReceipt|undefined;
  registry.actions.register('FREEFORM_ACTION',{parameters:z.strictObject({}),execute(c){
    // Resolve before time hooks, then recheck reachability/ownership after time advances.
    const resolved=admit(c.save,query,assessment,requestId,actorId),record=resolved.record;
    const entity=resolved.entity;
    c.advance(minutes);
    if(record?.source_request_id===requestId)record.at=structuredClone(c.save.runtime.time);
    const check=prepareCheck(c.save,requestId,{type:'DETERMINISTIC',domain:'perception',band:'normal',visibility:'public',stakes:'检查普通环境对象'},actor.id);
    resolveCheck(c.save,check,c.rng);
    outcome={resolution_id:record?.id??null,status:resolved.restricted?'unresolved':record?.status??'present',
      entity_id:entity?.id??null,taken:false,reason:resolved.budget?'budget':resolved.restricted||record?.status==='unresolved'?'restricted':record?.status==='absent'?'not_found':'observed'};
    if(outcome.status==='present'&&entity){
      const owned=Number((c.store.entity(actor.id).components.inventory?.items as Record<string,number>|undefined)?.[entity.id]??0)>0;
      const visible=environmentVisibleItems(c.save,actorId).some(e=>e.id===entity.id)||
        inspectableContained(c.save,entity,query.container_id??null,actorId,here);
      const acting=c.store.entity(actor.id);
      const accessible=visible&&Number(acting.components.condition?.hp??1)>0&&
        (actorId!==c.save.player_state.entity_id||!c.save.foreground?.blocker)&&
        acting.components.location?.location_id===here&&(owned||entity.components.location?.location_id===here)&&entity.components.item?.condition!=='destroyed';
      if(!accessible){outcome.reason='not_accessible';outcome.status='unresolved';}
      else if(query.intent==='take_if_available'){
        const owner=entity.components.item?.owner_id;
        const tags=entity.components.item?.tags as string[]|undefined;
        if(owner&&owner!==actor.id||record&&!record.take_allowed||tags?.includes('shared_fixture'))outcome.reason='permission_required';
        else if(owned)outcome.reason='already_held';
        else{putItemInInventory(c.save,entity.id,null,actor.id);outcome.taken=true;outcome.reason='taken';c.result_entities.items=[entity.id];}
      }
      if(accessible&&actorId===c.save.player_state.entity_id)
        c.store.entity(entity.id).components.discovery={known_to_player:true};
    }else if(outcome.status==='present'&&query.intent==='take_if_available')outcome.reason='permission_required';
    const fact=outcome.reason==='taken'?`你找到了${query.name}，并将这件物品收好。`:
      outcome.reason==='already_held'?`这件${query.name}已经由你持有，没有产生另一件。`:
      outcome.reason==='not_found'?`你检查了当前环境，在这次检查范围内没有找到${query.name}。`:
      outcome.reason==='permission_required'?`你看到了${query.name}，但这不表示你有权或能够将它拿走。`:
      outcome.status==='present'?`你观察到了${query.name}。${record?.description??String(entity?.components.identity?.description??'')}`:
      `你检查了当前环境，未能确认有可取得的${query.name}；没有获得物品。`;
    c.facts.push(fact,`本次检查经过 ${c.action.time_cost} 分钟。`);
  }});
  const turn=executeAction(save,{type:'FREEFORM_ACTION',parameters:{}},requestId,'ai',undefined,registry,
    true,actorId,actorId!==save.player_state.entity_id);
  assert(outcome,'环境查询缺少执行结果');
  const receipt=turn.save.resolution_receipts!.find(r=>r.request_id===requestId)!;
  receipt.semantic_action=actorId===save.player_state.entity_id?input.slice(0,1000):'INSPECT';receipt.environment=outcome;
  // environment is a fact-resolution receipt, not permission for arbitrary
  // door/flag/relationship mutations under the broad mechanical "state" effect.
  turn.save.action_facts=[...(turn.save.action_facts??[]),{request_id:requestId,actor_id:actor.id,target_id:outcome.entity_id,
    input,facts:turn.facts.slice(0,4),time:structuredClone(turn.save.runtime.time)}].slice(-100);
  if(actorId===save.player_state.entity_id)
    turn.save.last_turn={narrative:turn.facts.join(' '),speaker:null,dialogue:null,choices:[],context_actions:[]};
  return turn;
}
