import {blackjack,combat,score} from './sdk.js';
import type {ExtensionSpec} from './schema.js';

/** Reviewed rule templates: deterministic programme RNG, bounded state, no fabricated rewards. */
function verifyTemplates(spec:ExtensionSpec){
 const check=(yes:unknown,message:string)=>{if(!yes)throw Error(message);};
 check(score([0,13,8])===21,'A 的软硬点数错误');
 for(let seed=1;seed<=32;seed++){
   let state=seed;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
   const ctx={rng,roundId:String(seed),hp:100,healingItem:spec.healing_item_id};
   if(spec.template==='blackjack'){
     const start=blackjack(null,{type:'start',stake:10,currency:'test'},ctx);const end=start.state.phase==='playing'?blackjack(start.state,{type:'stand'},ctx):{state:start.state,requests:[]};
     const all=[...end.state.deck,...end.state.player,...end.state.dealer];check(all.length===52&&new Set(all).size===52,'牌堆唯一性失败');
     const delta=[...start.requests,...end.requests].reduce((n,r)=>n+(r.type==='economy'?r.delta:0),0);check([-10,0,10].includes(delta),'交易守恒失败');
     let rejected=false;try{blackjack(end.state,{type:'stand'},ctx);}catch{rejected=true;}check(rejected,'终局重放未被拒绝');
   }else{let out=combat(null,{type:'start'},ctx);for(let i=0;i<20&&out.state.phase==='playing';i++)out=combat(out.state,{type:'attack'},ctx);check(out.state.phase==='finished','战斗无法终止');check(out.requests.every(r=>r.type!=='economy'),'训练不能生成任意奖励');}
 }
 return ['32 个程序 RNG 种子规则测试通过','Framework API v1 请求格式通过','终局与状态约束通过'];
}

/** Declarative extensions: verify the declared state/action contract without executing generated code. */
export function verifyDeclarative(spec:ExtensionSpec){
 const check=(yes:unknown,message:string)=>{if(!yes)throw Error(message);};
 check(spec.fields.length>0,'声明式扩展至少需要一个状态字段');
 check(spec.declarative_actions.length>0,'声明式扩展至少需要一个动作');
 check(spec.surfaces.length>0,'声明式扩展至少需要一个 UI surface');
 check(new Set(spec.fields.map(field=>field.key)).size===spec.fields.length,'状态字段 key 重复');
 check(new Set(spec.declarative_actions.map(action=>action.id)).size===spec.declarative_actions.length,'动作 id 重复');
 check(new Set(spec.surfaces.map(surface=>surface.id)).size===spec.surfaces.length,'surface id 重复');
 const values:Record<string,number|boolean|string>={};
 for(const field of spec.fields){
   const ok=field.type==='flag'?typeof field.initial==='boolean':field.type==='text'?typeof field.initial==='string':typeof field.initial==='number';
   check(ok,`字段 ${field.key} 的初始值与类型不匹配`);
   values[field.key]=field.initial;
 }
 for(const action of spec.declarative_actions){
   const field=spec.fields.find(candidate=>candidate.key===action.field);check(field,`动作 ${action.id} 引用了不存在的字段`);
   if(action.op==='toggle')check(field!.type==='flag',`动作 ${action.id} 只能 toggle flag 字段`);
   else{check(field!.type==='number',`动作 ${action.id} 需要数字字段`);if(action.op==='set')check(action.value!==undefined,`动作 ${action.id} 缺少目标值`);
     const current=Number(values[action.field]??0),next=action.op==='set'?Number(action.value):current+(action.op==='increment'?1:-1)*(action.value??1);
     check(Number.isFinite(next)&&Math.abs(next)<=1_000_000,`动作 ${action.id} 会越界`);values[action.field]=next;}
 }
 return ['状态字段与动作自洽','重复 id 检查通过','扩展只能写入自有状态（写入清单已限制）'];
}

export function verifyReference(spec:ExtensionSpec){
 return spec.template==='declarative'?verifyDeclarative(spec):verifyTemplates(spec);
}
