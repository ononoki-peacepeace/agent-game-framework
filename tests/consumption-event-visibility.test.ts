import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {consumptionWorld} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {executeAction} from '../src/core/runtime.js';
import {visibleNpcConsumptions,projectConsumptionForNarrator} from '../src/narrative/item-consumption.js';
it.each(narrativeWorldKinds)('exposes only known NPC event-time consumption in %s',async kind=>{
 const {save}=await consumptionWorld(kind),here=save.entities.find(e=>e.id==='player')!.components.location!.location_id;
 const remote=save.definition.map!.locations.find(l=>l.id!==here)!.id;
 const turn=executeAction(save,{type:'CONSUME_ITEM',target_id:'qa_other_bread',parameters:{quantity:1}},randomUUID(),'ai',undefined,undefined,false,'npc_lin',true);
 const receipt=turn.save.resolution_receipts!.at(-1)!;
 const projected=projectConsumptionForNarrator(turn.save,receipt)!;
 expect(projected).toMatchObject({consumed_quantity:1,status:'completed'});
 for(const privateField of ['before_quantity','after_quantity','requested_quantity'])expect(projected).not.toHaveProperty(privateField);
 expect(receipt.consumption!.location_id).toBe(here);expect(visibleNpcConsumptions(turn.save,[receipt])).toEqual([receipt]);
 // Later movement is not evidence that the earlier event occurred elsewhere.
 turn.save.entities.find(e=>e.id==='npc_lin')!.components.location={location_id:remote};
 expect(visibleNpcConsumptions(turn.save,[receipt])).toEqual([receipt]);
 const old=structuredClone(receipt);delete old.consumption!.location_id;
 expect(visibleNpcConsumptions(turn.save,[old])).toEqual([]);
 const away=structuredClone(receipt);away.consumption!.location_id=remote;
 expect(visibleNpcConsumptions(turn.save,[away])).toEqual([]);expect(projectConsumptionForNarrator(turn.save,away)).toBeNull();
 turn.save.entities.find(e=>e.id==='npc_lin')!.components.discovery={known_to_player:false};
 expect(visibleNpcConsumptions(turn.save,[receipt])).toEqual([]);expect(projectConsumptionForNarrator(turn.save,receipt)).toBeNull();
},30000);
