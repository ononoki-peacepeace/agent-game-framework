import {expect,it} from 'vitest';
import type {SavePackage} from '../src/core/schema.js';
import {randomUUID} from 'node:crypto';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {createRegistry} from '../src/modules/index.js';
import {WorldBlockedError} from '../src/agent/outcome.js';
import {readPhysicalState} from '../src/core/perception-state.js';
import {consumptionActionForInput} from '../src/core/consumption-intent.js';
import {executeFreeform} from '../src/core/freeform.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
const consume={type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:1}};
it.each(['shortage','foreign','damaged','destroyed','sealed','dead','restrained','flag','equipped','contents','nonconsumable'])(
 'refuses %s before quantity/time mutation',async variant=>{
 const {save}=await consumptionWorld('commerce'),actor=save.entities.find(e=>e.id==='player')!,item=save.entities.find(e=>e.id==='qa_bread')!;
 if(variant==='shortage')actor.components.inventory!.items={qa_bread:0};
 if(variant==='damaged'||variant==='destroyed')item.components.item!.condition=variant;
 if(variant==='dead')actor.components.condition!.hp=0;
 if(variant==='restrained')actor.components.physical_state={...readPhysicalState(actor),restrained_by:'npc_lin'};
 if(variant==='flag')item.components.item!.consumable={method:'eat',minutes:2,required_flags:[{flag:'meal_allowed',equals:true}]};
 if(variant==='nonconsumable')delete item.components.item!.consumable;
 if(variant==='equipped')actor.components.equipment={slots:{hand:'qa_bread'}};
 if(variant==='sealed'){
  save.entities.push({id:'qa_box',type:'item',components:{item:{weight:1,stackable:false,container:true,tags:['sealed']}}});
  actor.components.inventory!.items={qa_box:1,qa_bread:1};actor.components.inventory!.placements={qa_bread:'qa_box'};
 }
 if(variant==='contents'){
  item.components.item!.container=true;actor.components.inventory!.items={qa_bread:1,qa_other_bread:1};actor.components.inventory!.placements={qa_other_bread:'qa_bread'};
 }
 const action={...consume,target_id:variant==='foreign'?'qa_other_bread':'qa_bread'},before=structuredClone(save);
 expect(()=>executeAction(save,action,randomUUID())).toThrow(WorldBlockedError);expect(save).toEqual(before);
});
it.each([0,-1,1.5,'1'])('rejects invalid inventory units %s',async amount=>{
 const {save}=await consumptionWorld('commerce'),before=structuredClone(save);
 expect(()=>executeAction(save,{...consume,target_id:'qa_bread',parameters:{quantity:amount}},randomUUID())).toThrow();expect(save).toEqual(before);
});
it.each(['quantity','body','location','permission'])('rechecks live %s after time hooks without committing a stale mutation',async boundary=>{
 const {save}=await consumptionWorld('commerce'),before=structuredClone(save),registry=createRegistry(save.definition.enabled_modules);
 registry.events.on('on_time_advance',c=>{
  const actor=c.store.entity('player');
  if(boundary==='quantity')(actor.components.inventory!.items as Record<string,number>).qa_bread=0;
  if(boundary==='body')actor.components.condition!.hp=0;
  if(boundary==='location')actor.components.location={location_id:'station'};
  if(boundary==='permission')c.store.entity('qa_bread').components.item!.consumable={method:'eat',minutes:1};
 });
 expect(()=>executeAction(save,{...consume,target_id:'qa_bread'},randomUUID(),'player',undefined,registry)).toThrow(WorldBlockedError);expect(save).toEqual(before);
});
it.each(narrativeWorldKinds)('routes source-authorized consume and refuses ambiguous/exhausted targets in %s',async kind=>{
 const {save}=await consumptionWorld(kind),ai=new AIRuntime({name:'offline-no-interpretation',generate:async()=>{throw Error('No model needed');}});
 expect(await ai.interpret(save,'吃掉两份面包')).toEqual({...consume,target_id:'qa_bread',parameters:{quantity:2}});
 const turn=executeFreeform(save,'吃掉两份面包',{},randomUUID());expect(quantity(turn.save)).toBe(1);
 const withNpcReceipt=executeAction(turn.save,{type:'INSPECT',parameters:{}},randomUUID(),'ai',undefined,undefined,true,'npc_lin',true).save;
 expect(quantity(executeFreeform(withNpcReceipt,'吃掉一份',{},randomUUID()).save)).toBe(0);
 expect(consumptionActionForInput(save,'不要吃掉面包，只查看它')).toBeNull();expect(consumptionActionForInput(save,'吃掉面包吗？')).toBeNull();
 const ambiguous=structuredClone(save);(ambiguous.entities.find(e=>e.id==='player')!.components.inventory!.items as Record<string,number>).qa_other_bread=1;
 expect(()=>consumptionActionForInput(ambiguous,'吃掉一份面包')).toThrow();
 const exhausted=executeAction(turn.save,{...consume,target_id:'qa_bread'},randomUUID()).save;
 expect(()=>executeFreeform(exhausted,'吃掉一份面包',{},randomUUID())).toThrow(WorldBlockedError);
 expect(()=>executeFreeform(exhausted,'吃掉一份不存在的食物',{},randomUUID())).toThrow(WorldBlockedError);
},30000);
it.each(['unsupported','locked','remote','foreign','ancestor'])('does not infer container opening permission from capability alone: %s',async variant=>{
 const {save}=await consumptionWorld('commerce');
 const box:SavePackage['entities'][number]={id:'qa_box',type:'item',components:{identity:{name:'木盒',description:'当前容器',avatar_id:null},location:{location_id:'square'},item:{weight:1,stackable:false,container:true,openable:true,tags:['sealed']},interactable:{kind:'container',leads_to:null,knockable:false,access:variant==='locked'?'locked':'public'}}};
 if(variant==='unsupported')box.components.item.openable=false;
 if(variant==='remote')box.components.location!.location_id='station';
 if(variant==='foreign')box.components.item.owner_id='npc_lin';
 if(variant==='ancestor'){
  save.entities.push({id:'qa_outer',type:'item',components:{location:{location_id:'square'},item:{weight:1,stackable:false,container:true,tags:['sealed']}}});box.components.item.container_id='qa_outer';
 }
 save.entities.push(box);const before=structuredClone(save);
 let outcome:unknown;try{outcome=executeAction(save,{type:'OPEN_CONTAINER',target_id:box.id,parameters:{}},randomUUID());}catch(error){outcome={error:String(error)};}
 await import('node:fs/promises').then(fs=>fs.writeFile(`.agent-runtime/codex/consumption-open-${variant}-${randomUUID()}.json`,JSON.stringify({save,outcome},null,2)));
 expect(outcome).toHaveProperty('error');expect(save).toEqual(before);
});

it.each(narrativeWorldKinds)('never replaces an unexecuted consume tail with an ordinary pickup activity in %s',async kind=>{
 const {save}=await consumptionWorld(kind),actor=save.entities.find(e=>e.id==='player')!,bread=save.entities.find(e=>e.id==='qa_bread')!;
 delete (actor.components.inventory!.items as Record<string,number>).qa_bread;bread.components.location={location_id:actor.components.location!.location_id};bread.components.item!.stackable=false;
 const input='拿起面包，然后吃掉一份',proposal={narrative:'未信任候选',minutes:1,target_id:null,facts:[],relationship:null,item_move:{item_id:'qa_bread',to:'held',position_label:null},completion_quote:input,
  resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',visibility:'public',stakes:'拾取然后消耗',stages:[],evidence_ids:[]}};
 let actual:unknown;try{actual=executeFreeform(save,input,proposal,randomUUID());}catch(error){actual={error:String(error),world:error instanceof WorldBlockedError};}
 await import('node:fs/promises').then(fs=>fs.writeFile(`.agent-runtime/codex/consumption-tail-${kind}-${randomUUID()}.json`,JSON.stringify({save,input,proposal,actual},null,2)));
 expect(actual).toMatchObject({world:true});
},30000);
