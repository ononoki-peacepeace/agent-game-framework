import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {routePath} from '../src/core/map.js';
import {layoutMapEdges,mapNodePositions,visibleRouteEdges} from '../src/client/map-graph.js';
import {panelRegistry} from '../src/client/panels.js';
import type {PublicLocation,PublicView} from '../src/shared/contracts.js';

async function ring(){
  const f=await sparseSetup(),view=await f.service.view() as PublicView;
  const nodes:PublicLocation[]=['dorm','garden','court','dining','hall','library','clinic'].map((id,index)=>({
    id,name:`地点${index}`,description:'',tags:[],parent_id:'hub',position:{x:18+index%3*32,y:22+Math.floor(index/3)*28},
  }));
  const child=nodes.map(node=>node.id);
  const routes=child.flatMap((id,index)=>{
    const next=child[(index+1)%child.length],minutes=index===0?5:index===1?2:3;
    return [{from:id,to:next,travel_minutes:minutes},{from:next,to:id,travel_minutes:minutes}];
  });
  view.locations=[{id:'hub',name:'区域',description:'',tags:[],position:{x:50,y:50}},...nodes];
  view.routes=[...routes,{from:'hub',to:'dorm',travel_minutes:4},{from:'dorm',to:'hub',travel_minutes:4}];
  view.entities.find(entity=>entity.id===view.player_id)!.components.location={location_id:'court'};
  return {view,nodes,child};
}

describe('map connection graph',()=>{
  it.each([[4,3],[5,5],[9,9]])('keeps a %i by %i irregular map stable without collapsing nodes',async(width,height)=>{
    const {view}=await ring();
    const nodes:PublicLocation[]=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      if(x===1&&y===1)continue; // a blank grid cell is not a route
      nodes.push({id:`cell_${x}_${y}`,name:`地点${x}-${y}`,description:'',tags:[],parent_id:'hub'});
    }
    const first=mapNodePositions(nodes,view,'hub');
    const second=mapNodePositions(nodes,{...view,revision:view.revision+1},'hub');
    expect(first.size).toBe(nodes.length);
    expect(new Set([...first.values()].map(point=>`${point.x.toFixed(4)}:${point.y.toFixed(4)}`)).size).toBe(nodes.length);
    expect([...second]).toEqual([...first]);
    expect(visibleRouteEdges({...view,routes:[]},nodes).size).toBe(0);
  });
  it('draws every direct visible edge exactly once and never invents a shortcut',async()=>{
    const {view,nodes}=await ring(),scope=view.locations;
    const projected=visibleRouteEdges(view,scope);
    expect(projected.size).toBe(8);
    expect(projected.get('dorm::garden')).toMatchObject({forward_minutes:5,reverse_minutes:5});
    expect(projected.get('court::garden')).toMatchObject({forward_minutes:2,reverse_minutes:2});
    expect(projected.has('court::dorm')).toBe(false);
    expect(routePath(view.routes,'dorm','court')?.map(edge=>edge.to)).toEqual(['garden','court']);
    expect(routePath(view.routes,'dorm','court')?.reduce((sum,edge)=>sum+edge.travel_minutes,0)).toBe(7);
    const positions=mapNodePositions(scope,view,'hub'),drawn=layoutMapEdges(view,scope,positions,['dorm','garden','court']);
    expect(drawn).toHaveLength(8);
    expect(drawn.filter(edge=>edge.highlighted).map(edge=>[edge.from,edge.to])).toEqual([
      ['dorm','garden'],['garden','court']]);
    expect(drawn.every(edge=>edge.forward_minutes!==null||edge.reverse_minutes!==null)).toBe(true);
    expect(positions.get('hub')).toEqual({x:50,y:9});
    expect(nodes.every(node=>positions.get(node.id)?.x===node.position?.x&&positions.get(node.id)?.y===node.position?.y)).toBe(true);
  });
  it('keeps duration badges off nodes and each other on a seven-place cycle',async()=>{
    const {view}=await ring(),nodes=view.locations,positions=mapNodePositions(nodes,view,'hub');
    const drawn=layoutMapEdges(view,nodes,positions);
    for(const edge of drawn){
      for(const node of nodes){const p=positions.get(node.id)!;
        expect(Math.abs(edge.label_x-p.x)<edge.label_width/2+6&&Math.abs(edge.label_y-p.y)<7).toBe(false);
      }
      for(const other of drawn)if(other!==edge)
        expect(Math.abs(edge.label_x-other.label_x)<(edge.label_width+other.label_width)/2+1&&
          Math.abs(edge.label_y-other.label_y)<6.5).toBe(false);
    }
  });
  it('shows directed and asymmetric costs without adding a reverse route',async()=>{
    const {view}=await ring();view.routes=[{from:'dorm',to:'garden',travel_minutes:5},
      {from:'garden',to:'court',travel_minutes:2},{from:'court',to:'garden',travel_minutes:3}];
    const edges=visibleRouteEdges(view,view.locations);
    expect(edges.get('dorm::garden')).toMatchObject({forward_minutes:5,reverse_minutes:null});
    expect(edges.get('court::garden')).toMatchObject({forward_minutes:2,reverse_minutes:3});
    expect(routePath(view.routes,'garden','dorm')).toBeNull();
  });
  it('includes a parent-child edge only on a level where both endpoints are shown',async()=>{
    const {view,nodes}=await ring();
    expect(visibleRouteEdges(view,nodes).has('dorm::hub')).toBe(false);
    expect(visibleRouteEdges(view,[view.locations[0],...nodes]).has('dorm::hub')).toBe(true);
  });
  it('keeps authored floor coordinates and edge geometry fixed when the player moves',async()=>{
    const {view}=await ring(),nodes=view.locations;
    const first=mapNodePositions(nodes,view,'hub');
    const paths=layoutMapEdges(view,nodes,first).map(edge=>edge.d);
    view.entities.find(entity=>entity.id===view.player_id)!.components.location={location_id:'dining'};
    const second=mapNodePositions(nodes,view,'hub');
    expect([...second]).toEqual([...first]);
    expect(layoutMapEdges(view,nodes,second).map(edge=>edge.d)).toEqual(paths);
    expect(paths.every(path=>!path.includes(' Q '))).toBe(true);
  });
  it('does not draw distinct routes on top of one another through a shared lane',async()=>{
    const {view}=await ring(),nodes=view.locations;
    const drawn=layoutMapEdges(view,nodes,mapNodePositions(nodes,view,'hub'));
    const segments=(d:string)=>{
      const points=[...d.matchAll(/(-?\d+\.\d+) (-?\d+\.\d+)/g)].map(match=>({x:Number(match[1]),y:Number(match[2])}));
      return points.slice(1).map((point,index)=>[points[index],point] as const);
    };
    for(let i=0;i<drawn.length;i++)for(let j=i+1;j<drawn.length;j++)
      for(const [a,b] of segments(drawn[i].d))for(const [c,d] of segments(drawn[j].d)){
        const vertical=a.x===b.x&&c.x===d.x&&Math.abs(a.x-c.x)<.01&&
          Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))>2;
        const horizontal=a.y===b.y&&c.y===d.y&&Math.abs(a.y-c.y)<.01&&
          Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))>2;
        expect(vertical||horizontal,`${drawn[i].from}-${drawn[i].to} overlaps ${drawn[j].from}-${drawn[j].to}`).toBe(false);
      }
  });
  it('projects a committed movement route for highlighting without changing the save',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id);
    const before=structuredClone(save);
    save.resolution_receipts=[...(save.resolution_receipts??[]),{
      request_id:'fixture-route',action_id:'fixture-route',actor_id:save.player_state.entity_id,target_id:'station',
      semantic_action:'MOVE',kind:'DETERMINISTIC',prerequisites:[],check_id:'',rolls:[],outcome:'success',time_cost:3,
      canonical_facts:[],effects:['time','position'],commit_status:'committed',movement_route:{
        origin_id:here,destination_id:'station',location_ids:[here,'station'],
        edges:[{from:here,to:'station',travel_minutes:3,kind:'registered',conditions:[]}],total_minutes:3,
      },
    }];
    save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location={location_id:'station'};
    const view=publicView(save);
    expect(view.recent_movement_route).toEqual({location_ids:[here,'station'],total_minutes:3});
    expect(before.resolution_receipts).not.toEqual(save.resolution_receipts);
    const html=renderToStaticMarkup(createElement(panelRegistry.map,{view,busy:false,act:()=>{}}));
    expect(html).toContain('map-route-travelled');
    expect(html).toContain('上次移动');
  });
});
