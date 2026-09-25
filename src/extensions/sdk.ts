/**
 * Reference rule templates for the two reviewed gameplay MVPs.
 * Declarative extensions do not use this file: they are described entirely by their manifest.
 */
export interface SDKContext {rng:()=>number;roundId:string;hp:number;healingItem:string|null}
export type Request={type:'economy';currency:string;delta:number}|{type:'damage'|'heal';amount:number}|{type:'consume';item_id:string;quantity:1};
export interface SDKAction {type:string;stake?:number;currency?:string;item_id?:string}
export interface BlackjackState {kind:'blackjack';phase:'playing'|'finished';round_id:string;deck:number[];player:number[];dealer:number[];stake:number;currency:string;result:string}
export interface CombatState {kind:'combat';phase:'playing'|'finished';round_id:string;enemy_hp:number;turn:number;result:string}
export interface DeclarativeState {kind:'declarative';values:Record<string,number|boolean|string>;last_action:string|null}
export type PlayState=BlackjackState|CombatState|DeclarativeState;
export const ensure=(value:unknown,message:string):asserts value=>{if(!value)throw Error(message);};
export function score(cards:number[]){let n=cards.reduce((total,c)=>total+Math.min(c%13+1,10),0);if(cards.some(c=>c%13===0)&&n+10<=21)n+=10;return n;}
function randomInt(rng:()=>number,max:number){const v=rng();if(!Number.isFinite(v)||v<0||v>=1)throw Error('无效程序随机');return Math.floor(v*max);}
export function blackjack(old:BlackjackState|null,action:SDKAction,ctx:SDKContext):{state:BlackjackState;requests:Request[]}{
 let state=old?structuredClone(old):null;const requests:Request[]=[];
 const finish=()=>{if(!state)throw Error('尚未开局');while(score(state.dealer)<17&&score(state.player)<=21)state.dealer.push(state.deck.pop()!);const p=score(state.player),d=score(state.dealer);state.result=p>21?'输':d>21||p>d?'赢':p===d?'平局':'输';state.phase='finished';const payout=state.result==='赢'?2*state.stake:state.result==='平局'?state.stake:0;if(payout)requests.push({type:'economy',currency:state.currency,delta:payout});};
 if(action.type==='start'){
   if(state?.phase==='playing')throw Error('当前牌局尚未结束，请继续原局');
   const deck=Array.from({length:52},(_,i)=>i);for(let i=51;i>0;i--){const j=randomInt(ctx.rng,i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
   state={kind:'blackjack',phase:'playing',round_id:ctx.roundId,deck,player:[deck.pop()!,deck.pop()!],dealer:[deck.pop()!,deck.pop()!],stake:action.stake??0,currency:action.currency??'',result:''};
   if(state.stake)requests.push({type:'economy',currency:state.currency,delta:-state.stake});
   if(score(state.player)===21||score(state.dealer)===21)finish();
 }else{
   if(!state||state.phase!=='playing')throw Error('当前没有进行中的牌局');
   if(action.type==='hit'){state.player.push(state.deck.pop()!);if(score(state.player)>=21)finish();}
   else if(action.type==='stand')finish();else throw Error('不支持的牌局动作');
 }
 return {state:state!,requests};
}
export function combat(old:CombatState|null,action:SDKAction,ctx:SDKContext):{state:CombatState;requests:Request[]}{
 if(action.type==='start'){if(old?.phase==='playing')throw Error('当前战斗尚未结束');if(ctx.hp<=0)throw Error('当前生命不足，不能开始战斗');return {state:{kind:'combat',phase:'playing',round_id:ctx.roundId,enemy_hp:20,turn:0,result:''},requests:[]};}
 if(!old||old.phase!=='playing')throw Error('当前没有进行中的战斗');const state=structuredClone(old),requests:Request[]=[];state.turn++;
 if(action.type==='flee'){state.phase='finished';state.result='已撤退';return {state,requests};}
 if(action.type==='attack'){state.enemy_hp=Math.max(0,state.enemy_hp-(3+randomInt(ctx.rng,5)));if(state.enemy_hp===0){state.phase='finished';state.result='训练胜利（无自动奖励）';return {state,requests};}}
 else if(action.type==='heal'){if(!ctx.healingItem||action.item_id!==ctx.healingItem)throw Error('未配置可用的治疗物品');requests.push({type:'consume',item_id:ctx.healingItem,quantity:1},{type:'heal',amount:Math.min(20,100-ctx.hp)});}
 else throw Error('不支持的战斗动作');
 const damage=2+randomInt(ctx.rng,4);requests.push({type:'damage',amount:damage});if(ctx.hp+(action.type==='heal'?Math.min(20,100-ctx.hp):0)-damage<=0){state.phase='finished';state.result='训练失败，生命耗尽';}return {state,requests};
}
export function playView(state:PlayState|null){if(!state)return null;if(state.kind==='combat')return state;if(state.kind==='declarative')return state;return {kind:state.kind,phase:state.phase,round_id:state.round_id,player:state.player,dealer:state.phase==='playing'?[state.dealer[0],null]:state.dealer,stake:state.stake,currency:state.currency,result:state.result};}
