import type {SavePackage} from '../core/schema.js';

export type ItemPossessionInventory={items?:Record<string,number>;placements?:Record<string,string|null>};

function statedQuantity(raw:string|undefined){
 if(raw===undefined)return null;
 if(/^\d+$/.test(raw))return Number(raw);
 const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
 if(Object.hasOwn(digits,raw))return digits[raw];
 const tens=/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(raw);
 return tens?(tens[1]?digits[tens[1]]:1)*10+(tens[2]?digits[tens[2]]:0):null;
}

/** Check explicit present player possession, not past pickup/transfer events.
 * Receipts authorize changes; the settled inventory answers what is held now.
 * Typed speech is removed by the caller before this check. No entities mutate. */
export function itemPossessionIssues(save:SavePackage,prose:string,settledInventories:readonly ItemPossessionInventory[]=[]){
 const player=save.entities.find(entity=>entity.id===save.player_state.entity_id);
 const inventory=player?.components.inventory as ItemPossessionInventory|undefined;
 const items=save.entities.filter(entity=>entity.components.item&&entity.components.identity?.name);
 const names=[...new Set(items.map(entity=>String(entity.components.identity!.name)))].sort((a,b)=>b.length-a.length);
 if(!names.length)return [];
 const escaped=names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const modifiers='(?:仍然|依然|仍|已经|现在|此刻|还|正|一直)*';
 const carrying=new RegExp(`^(?:现在|此刻)?你${modifiers}(没有|并未|并非|不是)?(拿着|握着|持有|带着|手里有|手中有)(?:这|那)?(?:(\\d+|[零〇一二两三四五六七八九十]+)(?:张|件|个|枚|块|支|本|只|瓶|份))?(${escaped})`);
 const located=new RegExp(`^(${escaped})${modifiers}(不在|在|留在)你的(手中|手里|背包里|背包中)`);
 const issues:{index:number;text:string}[]=[];
 let offset=0;
 for(const clause of prose.split(/[，,。；;！？!?\n]/)){
  const text=clause.trim(),carried=carrying.exec(text),location=located.exec(text);
  if(carried||location){
   const name=carried?.[4]??location![1],quantity=statedQuantity(carried?.[3]);
   const negative=carried?Boolean(carried[1]):location![2]==='不在';
   const inHand=carried?/拿着|握着|手里有|手中有/.test(carried[2]):/手中|手里/.test(location![3]);
   // A sequential scene may describe an earlier settled held state. Explicit
   // "now/still" assertions must match the final inventory instead.
   const current=/现在|此刻|仍然|依然|仍|还/.test((carried??location)![0].replace(name,''));
   const states=current||!settledInventories.length?[inventory]:[...settledInventories,inventory];
   const matching=items.filter(entity=>String(entity.components.identity!.name)===name);
   if(matching.some(entity=>{
    return !states.some(state=>{
     const actual=inHand&&state?.placements?.[entity.id]?0:Number(state?.items?.[entity.id]??0);
     const supported=quantity===null?actual>0:actual===quantity;
     return supported!==negative;
    });
   }))issues.push({index:offset+clause.indexOf(text),text:(carried??location)![0]});
  }
  offset+=clause.length+1;
 }
 return issues;
}
