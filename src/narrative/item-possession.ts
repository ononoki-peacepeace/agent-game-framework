import type {SavePackage} from '../core/schema.js';
import {publicView} from '../core/state.js';

export type ItemPossessionInventory={items?:Record<string,number>;placements?:Record<string,string|null>};

function statedQuantity(raw:string|undefined){
 if(raw===undefined)return null;
 if(/^\d+$/.test(raw))return Number(raw);
 const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
 if(Object.hasOwn(digits,raw))return digits[raw];
 const tens=/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(raw);
 return tens?(tens[1]?digits[tens[1]]:1)*10+(tens[2]?digits[tens[2]]:0):null;
}

/** Check explicit present possession, not past pickup/transfer events.
 * Receipts authorize changes; the settled inventory answers what is held now.
 * Typed speech is removed by the caller before this check. No entities mutate. */
export function itemPossessionIssues(save:SavePackage,prose:string,settledInventories:readonly ItemPossessionInventory[]=[]){
 const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
 const visible=new Set(publicView(save).entities.map(entity=>entity.id));
 const actors=save.entities.filter(entity=>visible.has(entity.id)&&(entity.id===player?.id||
  entity.components.character&&entity.components.identity?.name&&entity.components.location?.location_id===player?.components.location?.location_id));
 const items=save.entities.filter(entity=>entity.components.item&&entity.components.identity?.name);
 const names=[...new Set(items.map(entity=>String(entity.components.identity!.name)))].sort((a,b)=>b.length-a.length);
 if(!names.length)return [];
 const escaped=names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const modifiers='(?:仍然|依然|仍|已经|现在|此刻|还|正|一直)*';
 const escape=(name:string)=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const parsers=actors.map(actor=>{
  const subject=actor.id===player?.id?'你|玩家':escape(String(actor.components.identity?.name??''));
  return {actor,
   carrying:new RegExp(String.raw`^(?:现在|此刻)?(?:${subject})${modifiers}(没有|并未|并非|不是)?(拿着|握着|持有|带着|手里有|手中有)(?:这|那)?(?:(\d+|[零〇一二两三四五六七八九十]+)(?:张|件|个|枚|块|支|本|只|瓶|份))?(${escaped})`),
   located:new RegExp(`^(${escaped})${modifiers}(不在|在|留在)(?:${subject})的(手中|手里|背包里|背包中)`)};
 });
 const issues:{index:number;text:string}[]=[];
 let offset=0;
 for(const clause of prose.split(/[，,。；;！？!?\n]/)){
  const text=clause.trim();
  for(const {actor,carrying,located} of parsers){
   const inventory=actor.components.inventory as ItemPossessionInventory|undefined;
   const carried=carrying.exec(text),location=located.exec(text);
   if(carried||location){
    const name=carried?.[4]??location![1],quantity=statedQuantity(carried?.[3]);
    const negative=carried?Boolean(carried[1]):location![2]==='不在';
    const inHand=carried?/拿着|握着|手里有|手中有/.test(carried[2]):/手中|手里/.test(location![3]);
    // A sequential scene may describe an earlier settled held state. Explicit
    // "now/still" assertions must match the final inventory instead.
    const current=/现在|此刻|仍然|依然|仍|还/.test((carried??location)![0].replace(name,''));
    // Only player inventories are retained for event-time compound claims.
    // An unmarked NPC clause in a multi-stage scene is not forced into "now".
    if(actor.id!==player?.id&&settledInventories.length&&!current)continue;
    const history=actor.id===player?.id?settledInventories:[];
    const states=current||!history.length?[inventory]:[...history,inventory];
    const matching=items.filter(entity=>String(entity.components.identity!.name)===name);
    // A display name can refer to several canonical items. Compare their total
    // for this actor within each single settled image, never across time.
    const supported=states.some(state=>{
     const actual=matching.reduce((total,entity)=>total+
      (inHand&&state?.placements?.[entity.id]?0:Number(state?.items?.[entity.id]??0)),0);
     return (quantity===null?actual>0:actual===quantity)!==negative;
    });
    if(!supported)issues.push({index:offset+clause.indexOf(text),text:(carried??location)![0]});
   }
  }
  offset+=clause.length+1;
 }
 return issues;
}
