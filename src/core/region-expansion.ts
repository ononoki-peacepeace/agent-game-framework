import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,type SavePackage} from './schema.js';
import {currentMap,revealLocation} from './map.js';

export const frontierDirectionSchema=z.enum(['north','east','south','west']);
export type FrontierDirection=z.infer<typeof frontierDirectionSchema>;
const placeKey=z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
export const regionExpansionProposalSchema=z.strictObject({
  name:z.string().min(1).max(120),width:z.number().int().min(2).max(12),height:z.number().int().min(2).max(12),
  entry:z.strictObject({name:z.string().min(1).max(120),description:z.string().min(1).max(800),
    x:z.number().int().min(0).max(11),y:z.number().int().min(0).max(11)}),
  places:z.array(z.strictObject({key:placeKey,name:z.string().min(1).max(120),
    description:z.string().min(1).max(800),x:z.number().int().min(0).max(11),
    y:z.number().int().min(0).max(11)})).min(1).max(8),
  routes:z.array(z.strictObject({from:placeKey,to:placeKey,travel_minutes:z.number().int().min(1).max(120)})).min(1).max(40),
  gateway_minutes:z.number().int().min(1).max(240),return_gateway:z.boolean(),
  geographic_basis:z.string().min(20).max(500),
});
export const regionExpansionReviewSchema=z.strictObject({supported:z.boolean(),reason:z.string().min(1).max(500)});
export type RegionExpansionProposal=z.infer<typeof regionExpansionProposalSchema>;
export type RegionExpansionReview=z.infer<typeof regionExpansionReviewSchema>;

const opposite:Record<FrontierDirection,FrontierDirection>={north:'south',east:'west',south:'north',west:'east'};
const signature=(save:SavePackage,anchorId:string,direction:FrontierDirection)=>
  createHash('sha256').update(`${save.game_id}:region:${anchorId}:${direction}`).digest('hex').slice(0,24);

/** World authorization is a recorded expandable region and an actual boundary anchor. */
export function regionFrontier(save:SavePackage,anchorId:string,direction:FrontierDirection){
  const map=currentMap(save),anchor=map.locations.find(location=>location.id===anchorId);
  const region=map.regions.find(item=>item.id===anchor?.spatial?.region_id);
  if(!anchor?.spatial||!region||region.expansion!=='allowed')return null;
  const {x,y}=anchor.spatial;
  if(!(direction==='north'&&y===0||direction==='east'&&x===region.width-1||
    direction==='south'&&y===region.height-1||direction==='west'&&x===0))return null;
  if(!save.map_state.known_location_ids.includes(anchorId))return null;
  if(map.routes.some(route=>route.from===anchorId&&route.gateway?.exit_direction===direction))return null;
  return {anchor,region};
}

/** Mutates only a transaction clone. No NPCs, events or hidden truths are generated here. */
export function commitRegionExpansion(save:SavePackage,anchorId:string,direction:FrontierDirection,
  rawProposal:RegionExpansionProposal,rawReview:RegionExpansionReview){
  const frontier=regionFrontier(save,anchorId,direction);
  assert(frontier,'当前位置不是获准扩展的地图边界出口');
  const proposal=regionExpansionProposalSchema.parse(rawProposal),review=regionExpansionReviewSchema.parse(rawReview);
  assert(review.supported,'新区域未通过世界地理审查');
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
  assert(player?.components.location?.location_id===anchorId,'玩家必须位于实际边界出口');
  const regionId=`region_${signature(save,anchorId,direction)}`;
  const existingMap=currentMap(save);
  assert(!existingMap.regions.some(region=>region.id===regionId),'该边界已生成区域');
  assert(!existingMap.regions.some(region=>region.scope_location_id===frontier.region.scope_location_id&&
    region.name.normalize('NFKC').trim().toLocaleLowerCase()===
      proposal.name.normalize('NFKC').trim().toLocaleLowerCase()),'同一层级已有同名区域');
  const entry=proposal.entry;
  assert(entry.x<proposal.width&&entry.y<proposal.height,'新区域入口坐标越界');
  assert(direction==='east'&&entry.x===0||direction==='west'&&entry.x===proposal.width-1||
    direction==='north'&&entry.y===proposal.height-1||direction==='south'&&entry.y===0,
  '新区域入口不在对应边界');
  const keys=new Set(['entry']),cells=new Set([`${entry.x}:${entry.y}`]);
  for(const place of proposal.places){
    assert(!keys.has(place.key),'新区域地点键重复');keys.add(place.key);
    assert(place.x<proposal.width&&place.y<proposal.height,'新区域地点坐标越界');
    const cell=`${place.x}:${place.y}`;assert(!cells.has(cell),'新区域地点坐标冲突');cells.add(cell);
  }
  const routeKeys=new Set<string>();
  for(const route of proposal.routes){
    assert(keys.has(route.from)&&keys.has(route.to)&&route.from!==route.to,'新区域路线引用无效地点');
    const key=`${route.from}:${route.to}`;assert(!routeKeys.has(key),'新区域路线重复');routeKeys.add(key);
  }
  const reached=new Set(['entry']);
  for(let i=0;i<keys.size;i++)for(const route of proposal.routes)
    if(reached.has(route.from))reached.add(route.to);
  assert(reached.size===keys.size,'新区域存在从入口不可达的地点');
  const idFor=(key:string)=>`loc_${signature(save,anchorId,direction)}_${key}`;
  const places=[{key:'entry',...entry},...proposal.places];
  const existing=currentMap(save);
  assert(places.every(place=>!existing.locations.some(location=>location.id===idFor(place.key))),
    '新区域地点 ID 与既有世界冲突');
  save.map_state.dynamic_regions??=[];
  save.map_state.dynamic_regions.push({id:regionId,name:proposal.name,
    scope_location_id:frontier.region.scope_location_id,width:proposal.width,height:proposal.height,
    expansion:'closed'});
  for(const place of places)save.map_state.dynamic_locations.push({id:idFor(place.key),name:place.name,
    description:place.description,tags:['region_place'],parent_id:frontier.region.scope_location_id,
    kind:place.key==='entry'?'gateway':'poi',map_level:frontier.anchor.map_level,
    known_by_default:false,spatial:{region_id:regionId,x:place.x,y:place.y},
    lifecycle:{status:'active',visibility:'public',origin:'existing_detail',
      creation_reason:proposal.geographic_basis,source_ref:anchorId,recorded_at:structuredClone(save.runtime.time)}});
  for(const route of proposal.routes)save.map_state.dynamic_routes.push({from:idFor(route.from),
    to:idFor(route.to),travel_minutes:route.travel_minutes,conditions:[]});
  save.map_state.dynamic_routes.push({from:anchorId,to:idFor('entry'),travel_minutes:proposal.gateway_minutes,
    conditions:[],gateway:{from_region_id:frontier.region.id,to_region_id:regionId,
      exit_direction:direction,entry_direction:opposite[direction]}});
  if(proposal.return_gateway)save.map_state.dynamic_routes.push({from:idFor('entry'),to:anchorId,
    travel_minutes:proposal.gateway_minutes,conditions:[],gateway:{from_region_id:regionId,
      to_region_id:frontier.region.id,exit_direction:opposite[direction],entry_direction:direction}});
  for(const place of places)revealLocation(save,idFor(place.key));
  return {region_id:regionId,entry_id:idFor('entry')};
}
