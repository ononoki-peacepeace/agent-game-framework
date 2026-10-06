import type {ContextActionSuggestion,PublicActionMeta} from '../shared/contracts.js';
export type AffordanceFamilyId='communicate'|'observe'|'approach'|'interact'|'help'|'use_item'|'follow'|'steal'|'intercept'|'attack';
export interface AffordanceItem {key:string;label:string;kind:'canonical'|'suggestion';action?:PublicActionMeta;suggestion?:ContextActionSuggestion}
export interface AffordanceFamily {id:string;label:string;items:AffordanceItem[]}
const labels:Record<AffordanceFamilyId,string>={communicate:'交流',observe:'观察',approach:'接近',interact:'互动',help:'帮助',use_item:'使用物品',follow:'跟踪',steal:'偷窃',intercept:'拦截',attack:'攻击'};
const ordered=Object.keys(labels) as AffordanceFamilyId[];
export function affordanceFamily(value:{type?:string;label?:string;intent?:string;family?:string}):AffordanceFamilyId{
 const explicit=value.family as AffordanceFamilyId|undefined;if(explicit&&ordered.includes(explicit))return explicit;
 const text=[value.type,value.label,value.intent].filter(Boolean).join(' ').toLowerCase();
 if(/attack|combat|攻击|袭击|揍|打(?!听|招呼)/.test(text))return 'attack';
 if(/intercept|block|拦截|拦住|阻挡/.test(text))return 'intercept';
 if(/steal|pickpocket|偷|扒窃/.test(text))return 'steal';
 if(/follow|track|跟踪|尾随/.test(text))return 'follow';
 if(/help|assist|救助|帮助|协助/.test(text))return 'help';
 if(/use|give|item|递|交给|使用物品/.test(text))return 'use_item';
 if(/inspect|observe|look|观察|查看|打量|留意/.test(text))return 'observe';
 if(/approach|move_to|接近|靠近|走到/.test(text))return 'approach';
 if(/talk|speak|social|chat|ask|交流|交谈|聊|问|招呼/.test(text))return 'communicate';
 return 'interact';
}
export function groupAffordances(actions:PublicActionMeta[],suggestions:ContextActionSuggestion[],includeUnmatchedActions=false):AffordanceFamily[]{
 const map=new Map<string,AffordanceFamily>();
 const add=(id:string,label:string,item:AffordanceItem)=>{const group=map.get(id)??{id,label,items:[]};if(!group.items.some(existing=>existing.kind===item.kind&&existing.label===item.label&&existing.suggestion?.intent===item.suggestion?.intent))group.items.push(item);map.set(id,group);};
 for(const [index,suggestion] of suggestions.entries()){
  const category=suggestion.category?.trim();const id=category?`category:${category.normalize('NFKC').toLowerCase()}`:affordanceFamily(suggestion);
  add(id,category??labels[affordanceFamily(suggestion)],{key:`suggestion:${index}:${suggestion.label}`,label:suggestion.label,kind:'suggestion',suggestion});
 }
 for(const action of actions){
  const family=affordanceFamily(action);
  const matching=[...map.values()].find(group=>group.items.some(item=>item.suggestion&&affordanceFamily(item.suggestion)===family));
  if(matching)add(matching.id,matching.label,{key:`action:${action.type}`,label:action.label,kind:'canonical',action});
  else if(includeUnmatchedActions)add(family,labels[family],{key:`action:${action.type}`,label:action.label,kind:'canonical',action});
 }
 return [...ordered.flatMap(id=>map.has(id)?[map.get(id)!]:[]),...[...map.values()].filter(group=>!ordered.includes(group.id as AffordanceFamilyId))];
}

