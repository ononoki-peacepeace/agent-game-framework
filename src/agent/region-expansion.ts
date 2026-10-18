import type {GameService} from '../server/service.js';
import {validateSave} from '../core/state.js';
import {currentMap} from '../core/map.js';
import type {SavePackage} from '../core/schema.js';
import {commitRegionExpansion,frontierDirectionSchema,regionFrontier,regionExpansionProposalSchema,
  regionExpansionReviewSchema,type FrontierDirection} from '../core/region-expansion.js';
import {ProviderError} from '../ai/failures.js';

/** Only a real, authorized boundary may create an adjacent map region. */
export async function expandMapFrontier(service:GameService,save:SavePackage,anchorId:string,
  direction:FrontierDirection,requestId:string){
  frontierDirectionSchema.parse(direction);
  const map=currentMap(save),anchor=map.locations.find(location=>location.id===anchorId);
  const existing=map.routes.find(route=>route.from===anchorId&&route.gateway?.exit_direction===direction);
  if(existing)return {kind:'existing' as const,entry_id:existing.to};
  const region=map.regions.find(item=>item.id===anchor?.spatial?.region_id);
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  if(!anchor?.spatial||!region||!regionFrontier(save,anchorId,direction)||
    player?.components.location?.location_id!==anchorId)return {kind:'blocked' as const,
      reason:'这里没有可以据实延伸的地图边界。'};
  const context={world:save.definition.world.description.slice(0,1600),
    geography:save.definition.gm_state.notes.slice(0,800),
    source_region:{id:region.id,name:region.name,width:region.width,height:region.height,
      scope_location_id:region.scope_location_id},
    anchor:{id:anchor.id,name:anchor.name,description:anchor.description.slice(0,500),
      x:anchor.spatial.x,y:anchor.spatial.y},direction,
    nearby_places:map.locations.filter(place=>place.spatial?.region_id===region.id)
      .map(place=>({name:place.name,x:place.spatial!.x,y:place.spatial!.y})).slice(0,30)};
  let validationFailure='';
  for(let attempt=0;attempt<2;attempt++){
    const proposal=await service.ai.systemAgent(regionExpansionProposalSchema,save.definition.prompt_profile,{
      instruction:'你是持续世界的相邻地图区域提案者，只输出 JSON，不改世界。仅为明确允许扩展的已登记区域边界提出一块与既有地理相容的普通公开区域。玩家想去某处不是地点存在的证据；不得造人物、秘密、关键线索、事件或特殊捷径。entry 位于所给方向的对侧边界；places 是入口之外的少量真实普通地点，key 唯一；routes 必须从 entry 可达，只有真实可走的有向边，返回通路是否存在由世界地理决定。尺寸不必填满，坐标是区域局部坐标。geographic_basis 要说明独立于玩家愿望的世界依据。不改已有区域、地点或路线。如果收到 validation_failure，修正结构与地理错误，不删既有事实。',
      context,...(validationFailure?{validation_failure:validationFailure}:{})},
    {...save,ai:{threads:{}}});
    if(!proposal){
      validationFailure='上一份区域提案未满足结构合同或模型没有完整返回；保留原边界与世界设定，重新输出完整提案。';
      if(attempt===0)continue;
      throw new ProviderError('region_expansion_unavailable',
        'region expansion proposal unavailable','相邻区域生成暂时不可用');
    }
    const review=await service.ai.systemAgent(regionExpansionReviewSchema,save.definition.prompt_profile,{
      instruction:'独立审查相邻区域提案是否由世界设定和现有地理支持。玩家的愿望和空白画布都不是地理依据。若提案改写既有空间事实、凭空引入秘密或方向/规模不合设定，supported=false。只输出 JSON。',
      context,proposal},{...save,ai:{threads:{}}});
    if(!review){
      validationFailure='独立地理审查响应不可用；仍需通过审查，不得直接提交提案。';
      if(attempt===0)continue;
      throw new ProviderError('region_expansion_review_unavailable',
        'region expansion review unavailable','相邻区域审查暂时不可用');
    }
    if(!review.supported)return {kind:'blocked' as const,reason:'现有世界资料不支持在这个方向形成新区域。'};
    let created:{region_id:string;entry_id:string};
    try{
      const preview=structuredClone(save);
      created=commitRegionExpansion(preview,anchorId,direction,proposal,review);
      validateSave(preview);
    }catch(error){
      validationFailure=error instanceof Error?error.message.slice(0,300):String(error).slice(0,300);
      service.logger.warn('map.region_expansion.invalid',{module:'map',metadata:{attempt:attempt+1,
        anchor_id:anchorId,direction,reason:validationFailure}});
      if(attempt===1)throw new ProviderError('region_expansion_invalid',
        `region expansion candidate invalid: ${validationFailure}`,'相邻区域未能通过地图结构校验');
      continue;
    }
    await service.agentTransaction({game_id:save.game_id,expected_revision:save.state_revision,request_id:requestId},
      {region_expansion:{anchor_id:anchorId,direction,proposal,review}},next=>{
        commitRegionExpansion(next,anchorId,direction,proposal,review);
      });
    return {kind:'created' as const,entry_id:created.entry_id};
  }
  throw new ProviderError('region_expansion_invalid','region expansion exhausted','相邻区域未能通过地图结构校验');
}
