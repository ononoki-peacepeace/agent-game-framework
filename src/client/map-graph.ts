import type {PublicLocation,PublicView} from '../shared/contracts.js';

export interface VisibleMapEdge {
  from:string;to:string;forward_minutes:number|null;reverse_minutes:number|null;
}
export interface DrawnMapEdge extends VisibleMapEdge {
  d:string;label:string;label_x:number;label_y:number;label_width:number;highlighted:boolean;
}
type Point={x:number;y:number};
const pair=(a:string,b:string)=>[a,b].sort().join('::');
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
const pointSegmentDistance=(p:Point,a:Point,b:Point)=>{
  const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/den)):0;
  return distance(p,{x:a.x+t*dx,y:a.y+t*dy});
};
function segmentsCross(a:Point,b:Point,c:Point,d:Point){
  const cross=(p:Point,q:Point,r:Point)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  return cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0;
}
function segmentsOverlap(a:Point,b:Point,c:Point,d:Point){
  if(a.x===b.x&&c.x===d.x&&Math.abs(a.x-c.x)<1)
    return Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))>2;
  if(a.y===b.y&&c.y===d.y&&Math.abs(a.y-c.y)<1)
    return Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))>2;
  return false;
}

/** Draw only registered, public, currently traversable directed edges at this exact map level. */
export function visibleRouteEdges(view:PublicView,nodes:PublicLocation[]){
  const ids=new Set(nodes.map(node=>node.id));
  const edges=new Map<string,VisibleMapEdge>();
  for(const route of view.routes){
    if(!ids.has(route.from)||!ids.has(route.to)||route.from===route.to)continue;
    const key=pair(route.from,route.to);
    const prior=edges.get(key)??{from:route.from,to:route.to,forward_minutes:null,reverse_minutes:null};
    if(route.from===prior.from&&route.to===prior.to)prior.forward_minutes=route.travel_minutes;
    else prior.reverse_minutes=route.travel_minutes;
    edges.set(key,prior);
  }
  return edges;
}

/** Keep authored positions where possible; give generated or colliding nodes stable open slots. */
export function mapNodePositions(nodes:PublicLocation[],view?:PublicView,scopeId?:string){
  const positions=new Map<string,Point>();
  const slots:Point[]=[];
  const side=Math.max(4,Math.ceil(Math.sqrt(nodes.length)));
  const step=78/Math.max(1,side-1);
  for(let row=0;row<side;row++)for(let column=0;column<side;column++)
    slots.push({x:11+column*step,y:11+row*step});
  for(const node of nodes){
    // A container's coordinate belongs to its parent map. On its interior map it
    // is an entrance marker, not a competing occupant of a child's floor position.
    if(scopeId===node.id&&nodes.length>1){positions.set(node.id,{x:50,y:9});continue;}
    const region=node.spatial?view?.regions?.find(item=>item.id===node.spatial!.region_id):undefined;
    const authored=region&&node.spatial?
      {x:region.width===1?50:11+78*node.spatial.x/(region.width-1),
        y:region.height===1?50:11+78*node.spatial.y/(region.height-1)}:
      node.position&&Number.isFinite(node.position.x)&&Number.isFinite(node.position.y)?
        {x:Math.max(10,Math.min(90,node.position.x)),y:Math.max(11,Math.min(88,node.position.y))}:null;
    // Authored coordinates are spatial evidence. Dense maps may require zoom, but
    // moving a registered node to a prettier slot would falsify its direction.
    if(authored&&[...positions.values()].every(existing=>distance(existing,authored)>.01)){
      positions.set(node.id,authored);continue;
    }
    const minimumGap=Math.min(13,step*.72);
    const candidates=slots.filter(p=>[...positions.values()].every(existing=>distance(existing,p)>=minimumGap));
    const chosen=candidates[0]??slots.reduce((best,p)=>{
      const score=Math.min(...[...positions.values()].map(existing=>distance(existing,p)));
      return score>best.score?{p,score}:best;
    },{p:{x:50,y:50},score:-1}).p;
    positions.set(node.id,chosen);
  }
  return positions;
}

/** Route edges around unrelated nodes and place distinct duration badges away from nodes/badges. */
export function layoutMapEdges(view:PublicView,nodes:PublicLocation[],positions:Map<string,Point>,
  recentRoute?:readonly string[]){
  const highlighted=new Set((recentRoute??[]).slice(1).map((id,index)=>pair(recentRoute![index],id)));
  const occupiedLabels:{x:number;y:number;width:number}[]=[];
  const priorPaths:{from:string;to:string;points:Point[]}[]=[];
  const drawn:DrawnMapEdge[]=[];
  for(const edge of visibleRouteEdges(view,nodes).values()){
    const a=positions.get(edge.from)!,b=positions.get(edge.to)!;
    const midpoint={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const candidates:Point[][]=[
      [a,b],[a,{x:b.x,y:a.y},b],[a,{x:a.x,y:b.y},b],
      ...[midpoint.x,28,34,40,60,66,72,10,90].map(x=>[a,{x,y:a.y},{x,y:b.y},b]),
      ...[midpoint.y,30,34,36,38,42,58,64,70,10,90].map(y=>[a,{x:a.x,y},{x:b.x,y},b]),
      ...[28,34,40,60,66,72].flatMap(x=>[30,34,36,38,42,58,64,70].map(y=>[a,{x,y:a.y},{x,y},{x:b.x,y},b])),
      ...[28,34,40,60,66,72].flatMap(x=>[30,34,36,38,42,58,64,70].map(y=>[a,{x:a.x,y},{x,y},{x,y:b.y},b])),
    ];
    const scorePath=(points:Point[])=>{
      let score=0;
      for(let i=1;i<points.length;i++){
        const p=points[i-1],q=points[i];
        if(p.x!==q.x&&p.y!==q.y)score+=1000;
        score+=distance(p,q)*.08;
        for(const node of nodes){
          if(node.id===edge.from||node.id===edge.to)continue;
          if(pointSegmentDistance(positions.get(node.id)!,p,q)<7.8)score+=400;
        }
        for(const previous of priorPaths){
          for(let j=1;j<previous.points.length;j++)
            if(segmentsOverlap(p,q,previous.points[j-1],previous.points[j]))score+=90;
            else if(![edge.from,edge.to].some(id=>id===previous.from||id===previous.to)&&
              segmentsCross(p,q,previous.points[j-1],previous.points[j]))score+=12;
        }
      }
      if(points.some(p=>p.x<6||p.x>94||p.y<5||p.y>91))score+=500;
      return score+points.length*1.4;
    };
    const selected=candidates.map(points=>points.filter((p,i)=>i===0||p.x!==points[i-1].x||p.y!==points[i-1].y))
      .map(points=>({points,score:scorePath(points)}))
      .sort((left,right)=>left.score-right.score)[0].points;
    const trim=(p:Point,q:Point)=>{
      const d=distance(p,q),amount=Math.min(5.5,d/3);
      return {x:p.x+(q.x-p.x)*amount/d,y:p.y+(q.y-p.y)*amount/d};
    };
    const points=[trim(selected[0],selected[1]),...selected.slice(1,-1),trim(selected.at(-1)!,selected.at(-2)!)];
    const label=edge.forward_minutes!==null&&edge.reverse_minutes!==null?
      edge.forward_minutes===edge.reverse_minutes?`${edge.forward_minutes}分 ↔`:
        `${edge.forward_minutes}→ ${edge.reverse_minutes}←`:
      edge.forward_minutes!==null?`${edge.forward_minutes}分 →`:`${edge.reverse_minutes}分 ←`;
    const labelWidth=Math.max(12,label.length*1.85+3);
    let badge={x:midpoint.x,y:midpoint.y,score:Infinity};
    for(let i=1;i<points.length;i++)for(const t of [.5,.3,.7])for(const offset of [5,-5,9,-9,13,-13]){
      const start=points[i-1],end=points[i],segmentLength=distance(start,end);
      if(segmentLength<1)continue;
      const normal={x:-(end.y-start.y)/segmentLength,y:(end.x-start.x)/segmentLength};
      const p={x:start.x+(end.x-start.x)*t+normal.x*offset,y:start.y+(end.y-start.y)*t+normal.y*offset};
      let score=Math.abs(t-.5)*4+Math.abs(offset)*.08-segmentLength*.03;
      if(p.x-labelWidth/2<2||p.x+labelWidth/2>98||p.y<7||p.y>91)score+=100;
      for(const node of nodes){const n=positions.get(node.id)!;
        if(Math.abs(p.x-n.x)<labelWidth/2+7&&Math.abs(p.y-n.y)<10)score+=100;
      }
      for(const old of occupiedLabels)
        if(Math.abs(p.x-old.x)<(labelWidth+old.width)/2+1&&Math.abs(p.y-old.y)<6.5)score+=100;
      if(score<badge.score)badge={...p,score};
    }
    occupiedLabels.push({x:badge.x,y:badge.y,width:labelWidth});
    priorPaths.push({from:edge.from,to:edge.to,points});
    drawn.push({...edge,d:`M ${points.map(point=>`${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' L ')}`,
      label,label_x:badge.x,label_y:badge.y,label_width:labelWidth,highlighted:highlighted.has(pair(edge.from,edge.to))});
  }
  return drawn;
}
