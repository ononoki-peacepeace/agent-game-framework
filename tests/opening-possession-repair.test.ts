import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {ensureOrdinaryItem,putItemInInventory} from '../src/modules/inventory.js';
import {repairOpeningPossessionsForAction} from '../src/core/initial-possession-repair.js';
import {validateSave} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {checkpointTurn} from '../src/core/turn-history.js';

describe('evidence-bound opening possession repair',()=>{
  it('repairs a damaged revision-zero opening snapshot and continues the original action atomically',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const camera=ensureOrdinaryItem(save,'相机',0.7,true),film=ensureOrdinaryItem(save,'胶卷',0.1);
    putItemInInventory(save,camera.id);
    putItemInInventory(save,film.id,camera.id);
    save.definition.entities=structuredClone(save.entities);
    const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    delete (player.components.inventory!.items as Record<string,number>)[camera.id];
    delete (player.components.inventory!.items as Record<string,number>)[film.id];
    delete (player.components.inventory!.placements as Record<string,string|null>)[camera.id];
    delete (player.components.inventory!.placements as Record<string,string|null>)[film.id];
    save.entities=save.entities.filter(e=>e.id!==camera.id&&e.id!==film.id);
    await f.store.write(validateSave(save));
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'MOVE_ITEM',parameters:{item_id:camera.id,to:'held',container_id:null,position_label:null}});
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你拿稳相机。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const request={game_id:save.game_id,expected_revision:0,request_id:randomUUID(),input:'我拿起相机'};
    await f.service.turn(request);
    const after=await f.service.current(),owner=after.entities.find(e=>e.id===save.player_state.entity_id)!;
    expect((owner.components.inventory!.items as Record<string,number>)[camera.id]).toBe(1);
    expect((owner.components.inventory!.items as Record<string,number>)[film.id]).toBe(1);
    expect(after.entities.filter(e=>e.id===camera.id||e.id===film.id)).toHaveLength(2);
    expect(after.resolution_receipts?.at(-1)?.canonical_facts.join(' ')).toContain('结构化开局记录');
    expect(after.state_revision).toBe(1);
    await f.service.turn(request);
    expect((await f.service.current()).state_revision).toBe(1);
    await f.service.undo({game_id:save.game_id,expected_revision:1,request_id:randomUUID()});
    const undone=await f.service.current();
    expect(undone.entities.some(e=>e.id===camera.id)).toBe(false);
    expect((undone.entities.find(e=>e.id===owner.id)?.components.inventory!.items as Record<string,number>)[camera.id]).toBeUndefined();
  });

  it('refuses historical or ambiguous possession repair even when biography or baseline mentions the item',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const camera=ensureOrdinaryItem(save,'相机',0.7);
    putItemInInventory(save,camera.id);
    save.definition.entities=structuredClone(save.entities);
    const current=structuredClone(save);
    delete (current.entities.find(e=>e.id===current.player_state.entity_id)!.components.inventory!.items as Record<string,number>)[camera.id];
    current.entities=current.entities.filter(e=>e.id!==camera.id);
    current.state_revision=260;
    expect(repairOpeningPossessionsForAction(current,'我使用相机拍照')).toBeNull();
    current.state_revision=0;
    current.entities.push({id:'other_camera',type:'item',components:{identity:{name:'相机',description:'',avatar_id:null,gender:null,age:null},
      item:{weight:0.7,stackable:false}}});
    expect(repairOpeningPossessionsForAction(current,'我使用相机拍照')).toBeNull();
  });
  it('uses a valid last-turn before image when an unrelated action lost a previously held item',async()=>{
    const f=await sparseSetup(),before=await f.service.current();
    const camera=ensureOrdinaryItem(before,'相机',0.7);
    putItemInInventory(before,camera.id);
    before.definition.entities=structuredClone(before.entities);
    const actionId=randomUUID(),after=executeAction(before,{type:'WAIT',parameters:{minutes:1}},actionId).save;
    delete (after.entities.find(e=>e.id===after.player_state.entity_id)!.components.inventory!.items as Record<string,number>)[camera.id];
    after.entities=after.entities.filter(e=>e.id!==camera.id);
    after.state_revision=1;
    checkpointTurn(before,after,actionId);
    const repaired=repairOpeningPossessionsForAction(after,'我使用相机拍照');
    expect(repaired?.itemIds).toEqual([camera.id]);
    expect((repaired?.save.entities.find(e=>e.id===before.player_state.entity_id)?.components.inventory?.items as Record<string,number>)[camera.id]).toBe(1);
    after.resolution_receipts![0].effects.push('inventory');
    checkpointTurn(before,after,actionId);
    expect(repairOpeningPossessionsForAction(after,'我使用相机拍照')).toBeNull();
  });
});
