import type {GameService} from '../server/service.js';
import type {SavePackage} from '../core/schema.js';
import {applyLocationSearch,locationReviewSchema,locationSearchContext,locationSearchSchema,
  type LocationSearch} from '../core/location-lifecycle.js';
import {ProviderError,CandidateValidationError,generationRepair,generationBudget,takeGeneration,type GenerationRepair} from '../ai/failures.js';
import {z} from 'zod';
import {GameError} from '../core/schema.js';

/** One search against the current canonical world. A proposed detail receives a separate world-fit review. */
export async function exploreLocation(service:GameService,save:SavePackage,query:string,requestId:string,
  scope?:{anchor_id:string|null;excluded_destination_ids:string[];source_quote:string}){
  const context=locationSearchContext(save);
  const authorization=scope?{...scope,instruction:'参照地点不是局部区域本身；保留原始空间范围和停止条件。禁止以可达或名称相近替代符合条件。'}:null;
  const budget=generationBudget(4); // at most two proposals and two reviewer attempts in total
  const read=async<T>(schema:z.ZodType<T>,data:unknown,repair?:GenerationRepair|null):Promise<T>=>{
    const observed:{failure?:{reason:string;detail:string;schema_feedback?:{issues:import('../ai/failures.js').SchemaRepairIssue[];previous_output:unknown}}}={};
    const value=await service.ai.systemAgent(schema,save.definition.prompt_profile,repair?{context:data,generation_repair:repair}:data,{...save,ai:{threads:{}}},failure=>{observed.failure=failure;},
      {retryTruncated:false,validationRepair:false,signal:takeGeneration(budget)});
    if(value)return value;
    const failure=observed.failure;
    if(failure?.schema_feedback)throw new CandidateValidationError('location_search',failure.schema_feedback.issues,failure.schema_feedback.previous_output);
    throw new ProviderError(failure?.reason??'location_search_unavailable',failure?.detail??'no candidate','地点搜索的模型响应不可用');
  };
  let proposalRepair:GenerationRepair|null=null;
  for(let attempt=0;attempt<2;attempt++){
  try{
  const decision=await read(locationSearchSchema,{
    instruction:'你是持续世界的地点搜索提案者，只输出 JSON，不改世界。玩家正在尝试寻找某类地点，不要求他先知道地点名。先匹配 known=true 的真实地点；其次匹配已有但未知、可由当前公开位置合理探索或向在场人物询问而发现的地点；两者都没有时，只有当前世界设定、城市规模和既有地理真正支持一个尚未细化的普通地点，才用 propose。世界不支持、没有可靠线索或仅因玩家愿望而产生的地点必须 none。已有地点不能再提案同类副本。propose 的 parent_id 与 anchor_id 必须是已有且当前可达的地点；source_ref 引用给定 world ID 或父级/连接点 ID；creation_reason 说明独立于玩家请求的世界成因，不能只复述请求。hidden 地点不能由一般搜索直接揭示。method 表示真实发现渠道：public_map、local_exploration 或 inquiry；没有可信渠道则 none。普通搜索不自动生成人物、营业状态或交易结果。只返回 schema JSON。',
    query,context,authorization,
  },proposalRepair);
  if(!decision)throw new ProviderError('location_search_unavailable','location search did not return a valid decision',
    '地点搜索的模型响应不可用');
  const excluded=new Set(scope?.excluded_destination_ids??[]);
  if(decision.location_id&&(excluded.has(decision.location_id)||decision.location_id===scope?.anchor_id))
    return {kind:'incompatible' as const,reason:'匹配地点不符合本次局部空间授权范围。',location:null};
  if(decision.decision==='none'&&(decision.location_id!==null||decision.proposal!==null)||
     ['known','discover'].includes(decision.decision)&&(!decision.location_id||decision.proposal!==null)||
     decision.decision==='propose'&&(decision.location_id!==null||!decision.proposal))
    throw new CandidateValidationError('location_search',[{path:'decision',code:'payload_mismatch',expected:'none无地点；known/discover引用已有ID；propose仅携带proposal',message:'地点决策类型与负载不一致'}],decision);
  let review:z.infer<typeof locationReviewSchema>|null|undefined;
  const readReview=async(data:unknown)=>{
    let repair:GenerationRepair|null=null;
    for(let retry=0;retry<2;retry++)try{return await read(locationReviewSchema,data,repair);}
    catch(error){repair=generationRepair(error);if(!repair)throw error;if(retry===1)throw new ProviderError('location_review_invalid','review correction exhausted','地点世界审核仍未通过结构校验，尚未登记地点');}
    throw new Error('Unreachable location review budget');
  };
  if(decision.decision==='propose'&&decision.proposal){
    review=await readReview({
      instruction:'你是独立的世界一致性审查者，只输出 JSON。只依据现有世界设定、地理、已有地点和提案理由判断：这个地点是否可以视为世界本来合理存在但此前未细化的一部分。玩家想要它不是证据。若与已确立事实、题材、地理、规模或已有同类地点冲突，supported=false。不要将未来可能建造的地点说成已经存在。',
      query,context,authorization,proposal:decision.proposal,
      hierarchy_policy:'parent_id 表示空间包含而非管理归属；室外区域不因靠近建筑就属于建筑内部。连接点可以位于父区域的后代地点，路线不要求与父子关系相同。名称只描述稳定空间，不复制行动、时长或终止条件。',
    });
  }else if((decision.decision==='known'||decision.decision==='discover')&&decision.location_id){
    review=await readReview({
      instruction:'你独立核对地点搜索匹配，只输出 JSON。根据玩家实际寻找的类别和条件，给定的已存在地点是否真的符合，而非仅仅同在一个区域？发现渠道与公开状态是否合理？若是当地探索而玩家尚未抵达该地点的已知父级或连接点，只审查“先沿已知路线到连接点、到达后重新搜索”是否合理；此刻不能把未知地点直接揭示给玩家。若名称、描述、类别不足以支持玩家要求的关键条件，supported=false。',
      query,context,authorization,match:context.locations.find(loc=>loc.id===decision.location_id)??null,
      method:decision.method,
    });
  }
  if(decision.decision!=='none'&&!review)throw new ProviderError('location_review_unavailable',
    'location review did not return a valid decision','地点审核的模型响应不可用');
  if(decision.decision!=='none'&&!review?.supported)
    return {kind:'incompatible' as const,reason:'当前世界没有足够依据支持这样的地点，不能将其具体化。',location:null};
  if(decision.decision==='none'){
    service.logger.info('agent.location_search.no_match',{module:'agent',metadata:{reason:decision.reason}});
    return {kind:'none' as const,reason:'目前没有找到符合条件的可靠地点或线索。',location:null};
  }
  // Validate on a clone before asking the transaction layer to commit. Repeat inside the exclusive commit.
  let preview:ReturnType<typeof applyLocationSearch>;
  try{preview=applyLocationSearch(structuredClone(save),decision as LocationSearch,query,review??undefined);}
  catch(error){
    if(!(error instanceof GameError))throw error;
    service.logger.info('agent.location_search.proposal_rejected',{module:'agent',metadata:{reason:error.message}});
    return {kind:'incompatible' as const,reason:'这个地点提案未通过世界地理与状态校验。',location:null};
  }
  if(preview.location&&excluded.has(preview.location.id))return {kind:'incompatible' as const,
    reason:'寻找该区域所需的接近路线超出了本次移动授权。',location:null};
  if(preview.kind==='known'||preview.kind==='approach')return preview;
  await service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId},
    {location_search:{query,decision,review}},next=>{applyLocationSearch(next,decision,query,review??undefined);});
  return preview;
  }catch(error){proposalRepair=generationRepair(error);if(!proposalRepair||attempt===1||budget.remaining<=0)throw error;
    service.logger?.warn('agent.location_search.repair',{module:'agent',metadata:{stage:proposalRepair.stage,issue_paths:proposalRepair.issues.map(i=>i.path),attempt:attempt+1}});}
  }
  throw new Error('Unreachable location proposal budget');
}
