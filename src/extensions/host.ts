import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import type {GameService} from '../server/service.js';
import {assert,safeParse,type SavePackage} from '../core/schema.js';
import {secureRng} from '../core/dice.js';
import {blackjack,combat,playView,type PlayState,type Request} from './sdk.js';
import {extensionActionSchema,manifestSchema,type ExtensionManifest} from './schema.js';
export const transactionSchema=z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().min(0),request_id:z.string().uuid()});
const card=z.number().int().min(0).max(51);
const playSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('blackjack'),phase:z.enum(['playing','finished']),round_id:z.string(),deck:z.array(card).max(52),player:z.array(card).min(2).max(22),dealer:z.array(card).min(2).max(22),stake:z.number().int().min(0).max(100),currency:z.string(),result:z.string().max(100)}),
 z.strictObject({kind:z.literal('combat'),phase:z.enum(['playing','finished']),round_id:z.string(),enemy_hp:z.number().int().min(0).max(20),turn:z.number().int().min(0),result:z.string().max(100)}),
 z.strictObject({kind:z.literal('declarative'),values:z.record(z.string(),z.union([z.number().finite().min(-1_000_000).max(1_000_000),z.boolean(),z.string().max(60)])),last_action:z.string().max(40).nullable()}),
]);
export function validatedPlay(raw:unknown,manifest:ExtensionManifest):PlayState|null{
 if(raw===null)return null;const state=safeParse(playSchema,raw);
 if(manifest.template==='declarative'){
   assert(state.kind==='declarative','扩展状态类型不匹配');
   for(const field of manifest.fields){
     const value=state.values[field.key];
     assert(field.type==='flag'?typeof value==='boolean':field.type==='text'?typeof value==='string':typeof value==='number',`扩展字段 ${field.key} 类型不匹配`);
     assert(Object.hasOwn(state.values,field.key),`扩展字段 ${field.key} 缺失`);
   }
   for(const key of Object.keys(state.values))assert(manifest.fields.some(field=>field.key===key),`扩展状态出现未声明字段 ${key}`);
   return state;
 }
 assert((manifest.template==='blackjack')===(state.kind==='blackjack'),'扩展状态类型不匹配');
 if(state.kind==='blackjack'){const cards=[...state.deck,...state.player,...state.dealer];assert(cards.length===52&&new Set(cards).size===52,'牌堆状态损坏');}return state;
}
// Declarative extensions may open anywhere; scene-scoped surfaces are filtered by the client.
export function declarativeOpen(){return true;}
/** Declarative extensions start from the field defaults declared in their own manifest. */
export function initialState(manifest:ExtensionManifest):PlayState|null{
 if(manifest.template!=='declarative')return null;
 return {kind:'declarative',values:Object.fromEntries(manifest.fields.map(field=>[field.key,field.initial])),last_action:null};
}
export function sceneMatches(save:SavePackage,manifest:ExtensionManifest){
 if(manifest.template==='declarative')return declarativeOpen();
 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;const location=[...(save.definition.map?.locations??[]),...save.map_state.dynamic_locations].find(l=>l.id===player.components.location?.location_id);const text=[location?.name,...(location?.tags??[])].join(' ');
 return manifest.triggers.some(t=>t==='casino'?/casino|赌场|赌馆|博彩/i.test(text):/training|训练|练习|竞技/i.test(text));
}
export class ExtensionHost {
 private approved:Record<string,ExtensionManifest[]>={};readonly ready:Promise<void>;private writes:Promise<void>=Promise.resolve();
 constructor(readonly service:GameService,readonly directory:string){this.ready=this.load();}
 private async load(){try{const raw=JSON.parse(await readFile(join(this.directory,'approved.json'),'utf8'));this.approved=safeParse(z.record(z.string(),z.array(manifestSchema)),raw);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 private has(manifest:ExtensionManifest){return (this.approved[manifest.extension_id]??[]).some(m=>JSON.stringify(m)===JSON.stringify(manifest));}
 async nextVersion(id:string,current?:string){await this.ready;const versions=[...(this.approved[id]??[]).map(m=>m.version),...(current?[current]:[])];if(!versions.length)return '0.1.0';versions.sort((a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];});const [major,minor,patch]=versions.at(-1)!.split('.').map(Number);return [major,minor,patch+1].join('.');}
 async approve(manifest:ExtensionManifest){await this.ready;const parsed=safeParse(manifestSchema,manifest);this.approved[parsed.extension_id]??=[];const same=this.approved[parsed.extension_id].find(m=>m.version===parsed.version);assert(!same||JSON.stringify(same)===JSON.stringify(parsed),'相同版本不可覆盖，请生成新版本');if(!this.has(parsed))this.approved[parsed.extension_id].push(parsed);
 const payload=JSON.stringify(this.approved,null,2);this.writes=this.writes.then(async()=>{await mkdir(this.directory,{recursive:true});const tmp=join(this.directory,randomUUID()+'.tmp');await writeFile(tmp,payload);await rename(tmp,join(this.directory,'approved.json'));});await this.writes;}
 async list(){await this.ready;const save=await this.service.current();return Object.entries(save.extensions??{}).map(([id,e])=>({id,name:e.manifest.name,version:e.version,manifest:e.manifest,enabled:e.enabled,installed:e.installed,available:this.has(e.manifest),can_open:e.enabled&&e.installed&&this.has(e.manifest)&&sceneMatches(save,e.manifest),state:playView(validatedPlay(e.state,e.manifest)),warning:this.has(e.manifest)?null:'本机缺少已验证的对应扩展版本；状态已保留为休眠。'}));}
 async install(raw:unknown,manifest:ExtensionManifest,migrationConfirmed=false){await this.ready;assert(this.has(manifest),'扩展尚未通过安装验证');const tx=safeParse(transactionSchema,raw);return this.service.extensionTransaction(tx,{install:manifest.extension_id,version:manifest.version,migrationConfirmed},save=>{const entries=save.extensions??={},old=entries[manifest.extension_id];if(old){assert(old.manifest.template===manifest.template,'升级不能更换状态类型');const state=validatedPlay(old.state,old.manifest) as {phase?:string}|null;assert(state?.phase!=='playing','请先结束当前局，再更新扩展');}
 let nextState=old?.state??initialState(manifest);
 if(old&&manifest.template==='declarative'){
 const changed=JSON.stringify(old.manifest.fields.map(f=>[f.key,f.type]))!==JSON.stringify(manifest.fields.map(f=>[f.key,f.type]));
 assert(!changed||migrationConfirmed,'字段结构变化需要确认迁移');
 if(changed){const before=validatedPlay(old.state,old.manifest);assert(before?.kind==='declarative','旧状态不可迁移');nextState={kind:'declarative',values:Object.fromEntries(manifest.fields.map(f=>[f.key,old.manifest.fields.some(o=>o.key===f.key&&o.type===f.type)?before.values[f.key]:f.initial])),last_action:null};}
 }
 validatedPlay(nextState,manifest);
 entries[manifest.extension_id]={version:manifest.version,framework_api_version:'1',manifest,enabled:true,installed:true,state:nextState as never,...(old?{previous:old.manifest,previous_state:structuredClone(old.state)}:{})};});}
 async manage(id:string,raw:unknown,command:'enable'|'disable'|'uninstall'|'rollback'){
 await this.ready;const tx=safeParse(transactionSchema,raw);return this.service.extensionTransaction(tx,{extension:id,command},save=>{const e=save.extensions?.[id];assert(e,'扩展不存在');assert((validatedPlay(e.state,e.manifest) as {phase?:string}|null)?.phase!=='playing','当前局尚未结束；可关闭界面保留，或完成本局后管理扩展');

 if(command==='enable'){assert(this.has(e.manifest),'本机缺少已验证版本');e.enabled=true;e.installed=true;}
 else if(command==='disable')e.enabled=false;
 else if(command==='uninstall'){e.enabled=false;e.installed=false;}
 else{assert(e.previous&&this.has(e.previous),'没有可用的上一版本');const previous=e.previous,previousState=e.previous_state===undefined?e.state:e.previous_state;validatedPlay(previousState,previous);e.previous=e.manifest;e.previous_state=structuredClone(e.state);e.manifest=previous;e.state=previousState;e.version=previous.version;}
 });}
 // Declarative actions only touch the extension's own namespace; canonical effects would have to be
 // requested through the framework transaction API and validated here first.
 private applyDeclarative(entry:NonNullable<SavePackage['extensions']>[string],action:{type:string;field?:string}){
 const manifest=entry.manifest,spec=manifest.declarative_actions.find(candidate=>candidate.id===action.type);assert(spec,`未声明的扩展动作: ${action.type}`);
 const field=manifest.fields.find(candidate=>candidate.key===spec.field);assert(field,`扩展动作引用了不存在的字段: ${spec.field}`);
 const state=validatedPlay(entry.state,manifest);assert(state?.kind==='declarative','扩展状态类型不匹配');
 const values=state.values,current=values[spec.field];
 if(spec.op==='increment'||spec.op==='decrement'){assert(typeof current==='number','该字段不是数字');const delta=(spec.op==='increment'?1:-1)*(spec.value??1);values[spec.field]=Math.max(-1_000_000,Math.min(1_000_000,current+delta));}
 else if(spec.op==='set'){assert(spec.value!==undefined,'该动作缺少目标值');assert(field.type!=='flag','flag 字段请使用 toggle');assert(typeof current==='number','该字段不是数字');values[spec.field]=Math.max(-1_000_000,Math.min(1_000_000,spec.value));}
 else{assert(field.type==='flag'&&typeof current==='boolean','toggle 只能用于 flag 字段');values[spec.field]=!current;}
 entry.state={...state,values,last_action:spec.id} as never;

 this.service.logger.info('extension.declarative.action',{module:'extension',metadata:{extension_id:manifest.extension_id,action:spec.id,field:spec.field,value:values[spec.field]}});
 }
 async act(id:string,raw:unknown){await this.ready;const input=safeParse(transactionSchema.extend({action:extensionActionSchema}),raw),action=input.action;return this.service.extensionTransaction({game_id:input.game_id,expected_revision:input.expected_revision,request_id:input.request_id},{extension:id,action},save=>{
 const entry=save.extensions?.[id];assert(entry?.enabled&&entry.installed&&this.has(entry.manifest),'扩展未启用或对应版本尚未验证');const manifest=entry.manifest,old=validatedPlay(entry.state,manifest);assert(sceneMatches(save,manifest),'当前位置不符合扩展触发条件');
 if(manifest.template==='declarative'){this.applyDeclarative(entry,action);return;}

 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,balances=player.components.wallet?.balances as Record<string,number>|undefined;
 if(action.type==='start'){const stake=action.stake??0;assert(stake===0||manifest.allow_betting&&stake<=manifest.max_stake,'下注超出已安装扩展允许范围');if(stake)assert(action.currency&&balances&&Object.hasOwn(balances,action.currency)&&balances[action.currency]>=stake,'货币无效或余额不足');}
 const context={roundId:randomUUID(),rng:secureRng,hp:Number(player.components.condition?.hp??0),healingItem:manifest.healing_item_id};
 const out=manifest.template==='blackjack'?blackjack(old as any,action,context):combat(old as any,action,context);
 for(const req of out.requests)this.applyRequest(save,manifest,req);
 entry.state=validatedPlay(out.state,manifest) as any;
 const summary=out.state as {phase?:string;result?:string;round_id?:string;last_action?:string|null};
 this.service.logger.info('extension.result.proposed',{module:'extension',request_id:input.request_id,metadata:{extension_id:id,action:action.type,phase:summary.phase??null,result:summary.result??summary.last_action??null,round_id:summary.round_id??null}});
 });}
 private applyRequest(save:SavePackage,manifest:ExtensionManifest,request:Request){
 const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,permissions=manifest.permissions.write;
 if(request.type==='economy'){assert(permissions.includes('request currency transaction'),'扩展无经济权限');const balances=player.components.wallet?.balances as Record<string,number>|undefined;assert(balances&&Object.hasOwn(balances,request.currency)&&save.definition.ruleset.currencies[request.currency],'扩展交易货币不存在');assert(Number.isSafeInteger(request.delta)&&Math.abs(request.delta)<=manifest.max_stake*2&&balances[request.currency]+request.delta>=0,'扩展交易被拒绝');balances[request.currency]+=request.delta;}
 else if(request.type==='consume'){assert(permissions.includes('request consume item')&&request.item_id===manifest.healing_item_id,'扩展无物品权限');const items=player.components.inventory?.items as Record<string,number>|undefined;assert(items&&(items[request.item_id]??0)>=1,'治疗物品不足');items[request.item_id]--;}
 else {assert(permissions.includes('request damage/heal'),'扩展无生命修改权限');const c=player.components.condition;assert(c&&typeof c.hp==='number'&&request.amount>=0&&request.amount<=20,'生命请求无效');c.hp=Math.max(0,Math.min(100,c.hp+(request.type==='heal'?request.amount:-request.amount)));}
 }
}
