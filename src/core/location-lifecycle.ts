import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,id,type SavePackage} from './schema.js';
import {addDynamicLocation,currentMap,locationById,revealLocation,routePath} from './map.js';

/** The Director may describe a place, but only this boundary can make it canonical. */
export const locationProposalSchema=z.strictObject({
  name:z.string().min(1).max(120),category:id,description:z.string().min(1).max(1000),
  parent_id:id,anchor_id:id,travel_minutes:z.number().int().min(1).max(240),
  visibility:z.enum(['hidden','locally_known','public']),
  creation_reason:z.string().min(15).max(500),source_ref:id,
});
export const locationSearchSchema=z.strictObject({
  decision:z.enum(['known','discover','propose','none']),
  location_id:id.nullable(),proposal:locationProposalSchema.nullable(),
  method:z.enum(['public_map','local_exploration','inquiry','none']),
  reason:z.string().min(1).max(500),
});
export const locationReviewSchema=z.strictObject({
  supported:z.boolean(),reason:z.string().min(1).max(400),
});
export type LocationSearch=z.infer<typeof locationSearchSchema>;
export type LocationProposal=z.infer<typeof locationProposalSchema>;
const normalized=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase();
const reachable=(save:SavePackage,from:string,to:string)=>{
  const routes=currentMap(save).routes.filter(route=>route.conditions.every(c=>save.gm_state.flags[c.flag]===c.equals));
  return from===to||Boolean(routePath(routes,from,to));
};
function playerLocation(save:SavePackage){return String(save.entities.find(e=>e.id===save.player_state.entity_id)?.components.location?.location_id??'');}

export function locationSearchContext(save:SavePackage){
  const map=currentMap(save),known=new Set(save.map_state.known_location_ids);
  return {
    world:{title:save.definition.meta.title,description:save.definition.world.description.slice(0,1800),
      rules:save.definition.gm_state.notes.slice(0,600)},
    player_location:playerLocation(save),known_ids:[...known],
    locations:map.locations.map(loc=>({id:loc.id,name:loc.name,description:loc.description.slice(0,350),
      category:loc.kind??null,tags:loc.tags,parent_id:loc.parent_id??null,
      visibility:loc.lifecycle?.visibility??(loc.known_by_default===false?'locally_known':'public'),
      status:loc.lifecycle?.status??'active',known:known.has(loc.id)})),
    routes:map.routes.map(route=>({from:route.from,to:route.to,travel_minutes:route.travel_minutes})),
  };
}

/** Shared structural validation for exploration and background creation. */
export function commitProposedLocation(save:SavePackage,proposal:LocationProposal,origin:'existing_detail'|'world_event',
  sourceRef:string,forcedId?:string,recordedAt=save.runtime.time){
  assert(save.definition.enabled_modules.includes('map'),'当前世界没有地图');
  const map=currentMap(save),parent=locationById(save,proposal.parent_id),anchor=locationById(save,proposal.anchor_id);
  assert(parent&&anchor&&parent.lifecycle?.status!=='closed'&&anchor.lifecycle?.status!=='closed','新地点需要真实可用的父级与连接点');
  assert(proposal.source_ref===parent.id||proposal.source_ref===anchor.id||proposal.source_ref===save.definition.meta.id,
    '地点存在理由必须引用当前世界或真实地点');
  // Physical containment and route connectivity have different jobs. An
  // outdoor sibling may connect to a courtyard nested under another building.
  const ancestry=new Set<string>();let ancestor:typeof anchor|undefined=anchor;
  while(ancestor&&!ancestry.has(ancestor.id)){
    ancestry.add(ancestor.id);ancestor=ancestor.parent_id?locationById(save,ancestor.parent_id):undefined;
  }
  assert(ancestry.has(parent.id),'新地点连接点必须位于指定区域');
  assert(reachable(save,playerLocation(save),anchor.id),'新地点连接点目前不可达');
  assert(!map.locations.some(loc=>loc.parent_id===parent.id&&normalized(loc.name)===normalized(proposal.name)),
    '同一区域已有同名地点');
  // A repeated search for a category in the same area resolves the existing place first.
  assert(!map.locations.some(loc=>loc.parent_id===parent.id&&loc.kind===proposal.category&&loc.lifecycle?.status!=='closed'),
    '同一区域已有符合类别的地点');
  const signature=[save.game_id,parent.id,normalized(proposal.name),proposal.category].join(':');
  const generated='loc_'+createHash('sha256').update(signature).digest('hex').slice(0,24);
  const locationId=forcedId??generated;
  assert(!map.locations.some(loc=>loc.id===locationId),'地点 ID 已存在');
  const location={id:locationId,name:proposal.name,description:proposal.description,tags:[proposal.category],
    parent_id:parent.id,kind:proposal.category,map_level:(parent.map_level??0)+1,known_by_default:false,
    lifecycle:{status:'active' as const,visibility:proposal.visibility,origin,
      creation_reason:proposal.creation_reason,source_ref:sourceRef,recorded_at:structuredClone(recordedAt)}};
  addDynamicLocation(save,location,[
    {from:anchor.id,to:locationId,travel_minutes:proposal.travel_minutes,conditions:[]},
    {from:locationId,to:anchor.id,travel_minutes:proposal.travel_minutes,conditions:[]},
  ],false);
  return location;
}

export function applyLocationSearch(save:SavePackage,raw:LocationSearch,query:string,review?:z.infer<typeof locationReviewSchema>){
  const choice=locationSearchSchema.parse(raw),known=new Set(save.map_state.known_location_ids),here=playerLocation(save);
  if(choice.decision==='none'){
    assert(choice.location_id===null&&choice.proposal===null,'空结果不能携带地点');
    return {kind:'none' as const,reason:choice.reason,location:null};
  }
  if(choice.decision==='known'||choice.decision==='discover'){
    assert(choice.location_id&&choice.proposal===null,'匹配必须引用一个已有地点');
    const location=locationById(save,choice.location_id);assert(location&&location.lifecycle?.status!=='closed','地点不存在或已经关闭');
    if(choice.decision==='known')assert(known.has(location.id),'模型选中的地点尚未公开');
    else{
      assert(!known.has(location.id),'地点已经被发现');
      const visibility=location.lifecycle?.visibility??'locally_known';
      assert(visibility!=='hidden','隐藏地点需要独立的真实线索，不能由泛泛搜索揭示');
      assert(choice.method!=='none','发现必须有可信渠道');
      if(visibility==='locally_known'){
        assert(choice.method!=='public_map','仅当地知晓的地点不能从公开地图直接揭示');
        const incoming=currentMap(save).routes.filter(r=>r.to===location.id&&known.has(r.from)&&
          r.conditions.every(c=>save.gm_state.flags[c.flag]===c.equals));
        const anchor=incoming.find(r=>r.from===here)?.from??
          (location.parent_id&&known.has(location.parent_id)?location.parent_id:incoming[0]?.from);
        assert(anchor&&known.has(anchor)&&reachable(save,here,anchor),'玩家还没有能够接触此地点的当地线索');
        if(choice.method==='local_exploration'&&anchor!==here)
          return {kind:'approach' as const,reason:'先到附近再继续寻找。',location:locationById(save,anchor)!};
        if(choice.method==='inquiry')assert(save.entities.some(e=>e.id!==save.player_state.entity_id&&
          e.components.character&&e.components.location?.location_id===here),'当前没有可询问的人');
      }
      revealLocation(save,location.id);
    }
    return {kind:choice.decision,reason:choice.reason,location};
  }
  assert(choice.location_id===null&&choice.proposal&&review?.supported===true,'世界依据不足，不能具体化新地点');
  assert(choice.method!=='none','具体化地点也必须有发现渠道');
  assert(choice.proposal.visibility!=='hidden','普通搜索不能直接发现隐藏地点');
  assert(choice.proposal.visibility!=='locally_known'||choice.method!=='public_map',
    '当地知晓的地点不能通过公开地图发现');
  if(choice.method==='inquiry')assert(save.entities.some(e=>e.id!==save.player_state.entity_id&&
    e.components.character&&e.components.location?.location_id===here),'当前没有可询问的人');
  if(choice.method==='local_exploration'&&choice.proposal.anchor_id!==here){
    const anchor=locationById(save,choice.proposal.anchor_id);
    assert(anchor&&known.has(anchor.id)&&reachable(save,here,anchor.id),'探索连接点尚不可达');
    return {kind:'approach' as const,reason:'先到附近再继续寻找。',location:anchor};
  }
  const created=commitProposedLocation(save,choice.proposal,'existing_detail',`exploration:${query.slice(0,100)}`);
  revealLocation(save,created.id);
  return {kind:'propose' as const,reason:choice.reason,location:created};
}

export function setLocationStatus(save:SavePackage,locationId:string,status:'active'|'closed',sourceRef:string,
  recordedAt=save.runtime.time){
  const loc=save.map_state.dynamic_locations.find(entry=>entry.id===locationId);
  assert(loc?.lifecycle,'只能更改已有生命周期记录的动态地点');
  if(status==='closed')assert(!save.entities.some(e=>e.components.location?.location_id===locationId),'仍有人处于该地点，不能关闭');
  loc.lifecycle={...loc.lifecycle,status,source_ref:sourceRef,recorded_at:structuredClone(recordedAt)};
}
