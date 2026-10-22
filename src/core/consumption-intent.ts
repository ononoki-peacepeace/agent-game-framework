import type {SavePackage} from './schema.js';
import {publicView} from './state.js';
import {WorldBlockedError} from '../agent/outcome.js';
import {consumptionRuleSchema} from './consumption-contract.js';
export function consumptionQuantity(raw:string){
 if(/^\d+$/.test(raw))return Number(raw);
 const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
 if(Object.hasOwn(digits,raw))return digits[raw];
 const match=/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(raw);
 return match?(match[1]?digits[match[1]]:1)*10+(match[2]?digits[match[2]]:0):NaN;
}
/** A bounded standalone command, grounded in source text and public canonical
 * assets. Never turn a mixed/negative/question sentence or guessed model ID into consumption. */
export function consumptionActionForInput(save:SavePackage,input:string){
 const text=input.trim().replace(/[。！!]$/,'');
 const direct=/^(?:我)?(?:现在|直接|尝试|然后|随后|再)*(吃|喝|用)(掉|完|下)?(?:了)?([^，,。；;！？!?]+)$/.exec(text);
 const inverse=/^(?:我)?(?:把|将)([^，,。；;！？!?]+?)(吃|喝|用)(掉|完|下)$/.exec(text);
 if(!direct&&!inverse)return null;
 const verb=direct?.[1]??inverse![2],finish=direct?.[2]??inverse![3];
 let object=(direct?.[3]??inverse![1]).replace(/^(?:这|那)(?=[零一二两三四五六七八九十\d])/,'');
 const amount=/^([零一二两三四五六七八九十\d]+)(?:份|个|块|张|瓶|枚|件|支)/.exec(object);
 if(amount)object=object.slice(amount[0].length);
 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,inventory=(player.components.inventory?.items??{}) as Record<string,number>;
 const visible=new Set(publicView(save).entities.map(e=>e.id));
 const known=new Set((save.resolution_receipts??[]).filter(r=>r.actor_id===player.id).flatMap(r=>r.result_entities?.items??[]));
 let items=save.entities.filter(e=>e.components.item&&(visible.has(e.id)||known.has(e.id)||e.components.discovery?.known_to_player===true)&&String(e.components.identity?.name)===object);
 if(!object||object==='它'){
  const last=save.resolution_receipts?.findLast(receipt=>receipt.actor_id===player.id),ids=last?.result_entities?.items??[];
  if(ids.length!==1)throw new WorldBlockedError('prerequisite','请明确要消耗的已登记物品。');
  items=save.entities.filter(e=>e.id===ids[0]&&e.components.item&&(inventory[e.id]??0)>0);
 }
 if(!items.length){if(finish)throw new WorldBlockedError('unavailable','没有可绑定的已登记消耗物品，不能凭描述生成资源。');return null;}
 const held=items.filter(e=>(inventory[e.id]??0)>0);if(held.length)items=held;
 if(items.length!==1)throw new WorldBlockedError('prerequisite','有多件同名物品，请先明确要消耗哪一件。');
 const item=items[0],rule=consumptionRuleSchema.safeParse(item.components.item?.consumable);
 if(!save.definition.enabled_modules.includes('inventory')||!rule.success)
  throw new WorldBlockedError('unavailable','该物品没有世界声明的消耗能力；这次没有消耗物品。');
 if(rule.data.method!==({吃:'eat',喝:'drink',用:'use'} as Record<string,string>)[verb])
  throw new WorldBlockedError('unavailable','这种消耗方式不符合物品的世界规则。');
 const quantity=amount?consumptionQuantity(amount[1]):finish==='完'?inventory[item.id]??1:1;
 if(!Number.isInteger(quantity)||quantity<1||quantity>1000000)throw new WorldBlockedError('prerequisite','消耗数量必须是已定义的正整数份数。');
 return {type:'CONSUME_ITEM',target_id:item.id,parameters:{quantity}};
}

/** Stage boundary only, not permission or an item binding. */
export function startsConsumptionCommand(input:string){
 return /^(?:我)?(?:现在|直接|尝试|然后|随后|接着|再)*(?:[吃喝用](?:掉|完|下)|[吃喝](?:[零一二两三四五六七八九十\d]+)(?:份|个|块|张|瓶|枚|件|支))/.test(input.trim());
}
