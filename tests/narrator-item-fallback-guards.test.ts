import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {executeAction} from '../src/core/runtime.js';
import {canonicalItemFallback} from '../src/narrative/item-fallback.js';
import {prepareNarrativeWorld} from './fixtures/narrative-worlds.js';
it('does not authorize an item story from inventory alone, a mismatched action or an unconfirmed outcome',async()=>{
 const save=structuredClone((await prepareNarrativeWorld('commerce')).save),turn=executeAction(save,
  {type:'MOVE_ITEM',parameters:{item_id:'qa_paper',to:'held',container_id:null,position_label:null}},randomUUID());
 const receipt=turn.save.resolution_receipts!.at(-1)!,before=structuredClone(turn.save);
 expect(canonicalItemFallback(turn.save,turn.action,receipt,false)).toBe('你把纸片拿在手中。');
 expect(canonicalItemFallback(turn.save,turn.action,receipt,true)).toBeNull();
 for(const patch of [{request_id:randomUUID()},{canonical_facts:[]},{outcome:'failure' as const},
  {semantic_action:'TRANSFER_ITEM'},{effects:[]},{actor_id:'npc_lin'}])
  expect(canonicalItemFallback(turn.save,turn.action,{...receipt,...patch},false)).toBeNull();
 expect(turn.save).toEqual(before);
},30000);
