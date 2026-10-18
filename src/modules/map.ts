import { z } from 'zod';
import { assert, id, locationSchema, routeSchema, type SavePackage } from '../core/schema.js';
import { addDynamicLocation, currentMap, localHierarchyTransition, routePath, seedKnownLocations } from '../core/map.js';
import type { ActionContext, Module } from '../core/registry.js';
import {worldAssert} from '../agent/outcome.js';
import {recordNpcTravelExperience} from '../agent/npc-experience.js';

/** Deterministic placeholder used only when a world enables the map capability without map data. */
export const placeholderLocation = { id: 'start', name: '起点', description: '这个世界尚未登记其它地点。', tags: [] };

export const mapModule: Module = {
  id: 'map', version: '0.1.0', requires: ['core'],
  manifest: {
    api_version: '1', provides: ['map.graph', 'location.current'],
    state_ownership: ['definition.map', 'map_state', 'components.location'],
    state_schema_version: 'map.v1', migration_version: 1, supports_enable_disable: true, supports_remove: true,
    setup(save: SavePackage) {
      if (!save.definition.map || !save.definition.map.locations.length) save.definition.map = { locations: [structuredClone(placeholderLocation)], routes: [] };
      const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
      if (player && !player.components.location) player.components.location = { location_id: save.definition.map.locations[0].id };
      const initial = save.definition.entities.find(entity => entity.id === save.player_state.entity_id);
      if (initial && !initial.components.location) initial.components.location = { location_id: save.definition.map.locations[0].id };
      seedKnownLocations(save);
    },
  },
  components: { location: { schema: z.strictObject({ location_id: id }), project: d => d } },
  panels: [{ id: 'map', label: '地图', module: 'map', order: 30, mobile_group: 'primary', presentation_type: 'panel' }],
  actions: {
    MOVE: { ui: { label: '前往', visibility: 'contextual' },
      capability:{intent:'move',description:'沿当前世界已知路线前往唯一绑定的地点',target_role:'destination',parameter_roles:{},completion_kind:'location_at'},
      parameters: z.strictObject({companions:z.enum(['none','willing']).optional()}), execute(c) {
      const mover=c.store.entity(c.action.actor_id);
      worldAssert(!mover.components.physical_state?.restrained_by,'unavailable','当前仍受已结算的身体控制，不能直接离场');
      worldAssert(Number(mover.components.condition?.hp??100)>0,'unavailable','当前身体状态无法自行移动');
      worldAssert(!c.save.entities.some(entity=>entity.components.physical_state?.restrained_by===mover.id),
        'unavailable','请先松开已建立的身体控制，再离开当前地点');
      const location = c.store.component<{ location_id: string }>(c.action.actor_id, 'location');
      const map=currentMap(c.save),target=map.locations.find(entry=>entry.id===c.action.target_id);
      worldAssert(target&&target.lifecycle?.status!=='closed','closed','该地点目前无法进入');
      const closed=new Set(map.locations.filter(entry=>entry.lifecycle?.status==='closed').map(entry=>entry.id));
      const known=new Set(c.save.map_state.known_location_ids);
      const available=map.routes.filter(r=>!closed.has(r.from)&&!closed.has(r.to)&&
        (c.action.actor_id!==c.save.player_state.entity_id||(known.has(r.from)&&known.has(r.to)))&&
        r.conditions.every(x=>c.save.gm_state.flags[x.flag]===x.equals));
      const path=routePath(available,location.location_id,c.action.target_id??'');
      // An independent NPC journey ends an earlier promise to follow from this
      // location. Returning later must not silently rejoin an old party.
      if(c.action.actor_id!==c.save.player_state.entity_id){
        const ownIntent=c.save.npc_agent_state?.[c.action.actor_id]?.travel_intent;
        if(ownIntent)delete c.save.npc_agent_state![c.action.actor_id].travel_intent;
      }
      const companions=c.action.actor_id===c.save.player_state.entity_id&&c.action.parameters.companions!=='none'?
        c.save.entities.filter(entity=>entity.id!==c.action.actor_id&&entity.components.character&&
          entity.components.location?.location_id===location.location_id&&
          !entity.components.physical_state?.restrained_by&&Number(entity.components.condition?.hp??100)>0&&
          c.save.npc_agent_state?.[entity.id]?.travel_intent?.status==='willing'&&
          // Consent is a recorded decision, not a revision-bound cache. Ordinary
          // turns and Undo can advance revision without changing this agreement.
          c.save.npc_agent_state[entity.id].travel_intent!.origin_location_id===location.location_id):[];
      const endSoloDeparture=()=>{
        if(c.action.actor_id!==c.save.player_state.entity_id||c.action.parameters.companions!=='none')return;
        // Leaving explicitly alone ends offers made for this departure. Returning
        // later must require a new agreement instead of silently re-forming a party.
        for(const entity of c.save.entities){
          const intent=c.save.npc_agent_state?.[entity.id]?.travel_intent;
          if(entity.components.location?.location_id===location.location_id&&
            intent?.origin_location_id===location.location_id)
            delete c.save.npc_agent_state![entity.id].travel_intent;
        }
      };
      const moveCompanions=(to:string)=>{
        for(const companion of companions){
          // The same registered route and world clock apply to the whole group.
          // A character who independently left the origin is excluded above.
          c.store.update(companion.id,'location',{location_id:to});
          delete c.store.entity(companion.id).components.scene_position;
          const intent=c.save.npc_agent_state?.[companion.id]?.travel_intent;
          if(intent){intent.origin_location_id=to;intent.recorded_revision=c.save.state_revision+1;}
          c.emit({type:'on_entity_changed',entity_id:companion.id});
        }
      };
      const finishMove=()=>{
        c.result_entities.moved_companions=companions.map(entity=>entity.id);
        recordNpcTravelExperience(c.save,c.action.id,c.action.actor_id,
          companions.map(entity=>entity.id),c.movement_route!);
      };
      if(!path?.length&&localHierarchyTransition(c.save,location.location_id,c.action.target_id??'')){
        const from=location.location_id,to=c.action.target_id!;
        endSoloDeparture();
        c.movement_route={origin_id:from,destination_id:to,location_ids:[from,to],
          edges:[{from,to,travel_minutes:1,kind:'hierarchy',conditions:[]}],total_minutes:1};
        c.emit({type:'on_location_leave',location_id:from});c.advance(1);
        c.store.update(c.action.actor_id,'location',{location_id:to});delete c.store.entity(c.action.actor_id).components.scene_position;
        moveCompanions(to);
        finishMove();
        c.emit({type:'on_entity_changed',entity_id:c.action.actor_id});c.emit({type:'on_travel_complete',location_id:to});c.emit({type:'on_location_enter',location_id:to});
        c.facts.push(`进入 ${map.locations.find(entry=>entry.id===to)!.name}，用时 1 分钟。`);
        return;
      }
      worldAssert(path?.length, 'route_unavailable','当前没有通往这个地点的可用路线');
      endSoloDeparture();
      c.movement_route={origin_id:location.location_id,destination_id:c.action.target_id!,
        location_ids:[location.location_id,...path.map(route=>route.to)],
        edges:path.map(route=>({from:route.from,to:route.to,travel_minutes:route.travel_minutes,
          kind:'registered' as const,conditions:route.conditions.map(condition=>({...condition}))})),
        total_minutes:path.reduce((sum,route)=>sum+route.travel_minutes,0)};
      for(const route of path){
        c.emit({ type: 'on_location_leave', location_id: route.from });
        c.advance(route.travel_minutes);
        c.store.update(c.action.actor_id, 'location', { location_id: route.to });
        delete c.store.entity(c.action.actor_id).components.scene_position;
        moveCompanions(route.to);
        c.emit({ type: 'on_entity_changed', entity_id: c.action.actor_id });
        c.emit({ type: 'on_travel_complete', location_id: route.to });
        c.emit({ type: 'on_location_enter', location_id: route.to });
        c.facts.push(`移动至 ${map.locations.find(l=>l.id===route.to)!.name}，用时 ${route.travel_minutes} 分钟。`);
      }
      finishMove();
      if(companions.length)c.facts.push(`同行人物沿同一路线抵达：${companions.map(entity=>String(entity.components.identity?.name??entity.id)).join('、')}。`);
    } },
    REGISTER_LOCATION: { ui: { label: '登记新地点', visibility: 'internal' }, parameters: z.strictObject({ location: locationSchema, routes: z.array(routeSchema).max(8).default([]) }), execute(c) {
      addDynamicLocation(c.save, c.action.parameters.location, (c.action.parameters.routes ?? []) as unknown[], true);
      c.facts.push('已登记新地点。');
    } },
  },
  validate(save) {
    const map = currentMap(save), locations = map.locations.map(location => location.id);
    assert(locations.length > 0, '启用 map 模块的世界必须至少有一个地点');
    assert(new Set(locations).size === locations.length, '地点 ID 重复');
    for (const location of map.locations) if (location.parent_id) {
      assert(location.parent_id !== location.id && locations.includes(location.parent_id), `地点 ${location.id} 的 parent_id 无效`);
      let cursor: string | null | undefined = location.parent_id; const seen = new Set([location.id]);
      while (cursor) { assert(!seen.has(cursor), '地图层级存在循环'); seen.add(cursor); cursor = map.locations.find(l => l.id === cursor)?.parent_id; }
    }
    for (const route of map.routes) assert(locations.includes(route.from) && locations.includes(route.to), '路线引用未知地点');
    const regions=new Map(map.regions.map(region=>[region.id,region]));
    assert(regions.size===map.regions.length,'地图区域 ID 重复');
    for(const region of map.regions)if(region.scope_location_id)
      assert(locations.includes(region.scope_location_id),`地图区域 ${region.id} 的所属地点不存在`);
    const occupied=new Set<string>();
    for(const location of map.locations)if(location.spatial){
      const region=regions.get(location.spatial.region_id);
      assert(region,`地点 ${location.id} 引用了不存在的地图区域`);
      assert(location.spatial.x<region.width&&location.spatial.y<region.height,
        `地点 ${location.id} 超出地图区域边界`);
      const cell=`${region.id}:${location.spatial.x}:${location.spatial.y}`;
      assert(!occupied.has(cell),`地图区域中多个地点占用同一格：${cell}`);occupied.add(cell);
    }
    for(const route of map.routes){
      const from=map.locations.find(location=>location.id===route.from),to=map.locations.find(location=>location.id===route.to);
      if(from?.spatial&&to?.spatial&&from.spatial.region_id!==to.spatial.region_id)
        assert(route.gateway,'跨地图区域路线必须登记稳定入口和出口');
      if(!route.gateway)continue;
      const source=regions.get(route.gateway.from_region_id),target=regions.get(route.gateway.to_region_id);
      assert(source&&target&&source.id!==target.id,'跨区域入口必须连接两个已登记的不同区域');
      assert(from?.spatial?.region_id===source.id&&to?.spatial?.region_id===target.id,
        '跨区域入口与路线端点所属区域不一致');
      const edge=(point:{x:number;y:number},region:{width:number;height:number},direction:string)=>
        direction==='other'||direction==='east'&&point.x===region.width-1||
        direction==='west'&&point.x===0||direction==='north'&&point.y===0||
        direction==='south'&&point.y===region.height-1;
      assert(edge(from.spatial!,source,route.gateway.exit_direction)&&
        edge(to.spatial!,target,route.gateway.entry_direction),'跨区域入口方向与边界坐标不一致');
    }
    const routeKeys = map.routes.map(r => `${r.from}:${r.to}`);
    assert(new Set(routeKeys).size === routeKeys.length, '路线重复');
    const player = save.entities.find(entity => entity.id === save.player_state.entity_id);
    assert(player?.components.location, '启用 map 模块时玩家必须有 location');
    for (const entity of save.entities) if (entity.components.location) assert(locations.includes(String(entity.components.location.location_id)), `实体 ${entity.id} 的地点不存在`);
    for (const id of save.map_state.known_location_ids) assert(locations.includes(id), `已知地点列表引用未知地点: ${id}`);
    for (const event of save.definition.events) {
      assert(!event.location_id || locations.includes(event.location_id), '事件地点不存在');
      assert(!event.reveal_location_id || locations.includes(event.reveal_location_id), '事件揭示地点不存在');
    }
  },
  prompt: 'map/location 是 canonical 地理事实。MOVE 只能沿已登记的 route；不要凭空移动人物或改写地图。',
};
