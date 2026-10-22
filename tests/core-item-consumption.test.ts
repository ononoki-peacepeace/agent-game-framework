import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {validateSave,newSave} from '../src/core/state.js';
const run=randomUUID();
it.each(narrativeWorldKinds)('settles actual partial-stack and final consumption without inventing benefits in %s',async kind=>{
 const {save}=await consumptionWorld(kind),before=structuredClone(save);
 const authored=newSave(save.definition);expect(quantity(authored)).toBe(3);
 expect(authored.entities.find(e=>e.id==='qa_bread')!.components.item!.consumable).toEqual({method:'eat',minutes:2});
 const action={type:'CONSUME_ITEM',target_id:'qa_bread',parameters:{quantity:2}};
 let actual:unknown;
 try{actual=executeAction(save,action,randomUUID());}catch(error){actual={error:String(error)};}
 await writeFile(`.agent-runtime/codex/consumption-core-${run}-${kind}.json`,JSON.stringify({input:save,action,actual},null,2));
 expect(actual).not.toHaveProperty('error');
 const first=actual as ReturnType<typeof executeAction>;
 expect(quantity(first.save)).toBe(1);expect(quantity(first.save,'qa_other_bread','npc_lin')).toBe(2);
 expect(first.action.time_cost).toBe(2);expect(first.save.runtime.time.minute).toBe(before.runtime.time.minute+2);
 expect(first.save.entities.find(e=>e.id==='player')!.components.condition?.hp).toBe(before.entities.find(e=>e.id==='player')!.components.condition?.hp);
 expect(first.save.resolution_receipts!.at(-1)).toMatchObject({semantic_action:'CONSUME_ITEM',outcome:'success',consumption:{item_id:'qa_bread',method:'eat',before_quantity:3,consumed_quantity:2,after_quantity:1,status:'completed'}});
 const last=executeAction(first.save,{...action,parameters:{quantity:1}},randomUUID());
 expect(quantity(last.save)).toBe(0);expect(last.save.entities.find(e=>e.id==='qa_bread')!.components.location).toBeUndefined();
 expect(()=>executeAction(last.save,action,randomUUID())).toThrow();expect(validateSave(last.save)).toEqual(last.save);expect(save).toEqual(before);
},30000);
