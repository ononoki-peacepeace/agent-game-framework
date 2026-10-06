import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform,localDestination} from '../src/core/freeform.js';
import {classifyChoiceExecution,executableChoices} from '../src/core/choice-availability.js';
import {bindStorageAction} from '../src/core/action-binding.js';
import {handleAgentInput} from '../src/agent/executor.js';
import type {Inventory} from '../src/modules/inventory.js';
import {validateSave} from '../src/core/state.js';
import type {SavePackage} from '../src/core/schema.js';

const choice='合上作业本收进书包，准备出门';
const storageProposal=()=>({narrative:'结算候选',minutes:2,target_id:null,facts:[],relationship:null,item_move:null,
  storage_move:{item_name:'作业本',item_id:null,container_name:'书包',container_id:null},completion_quote:choice,
  required_conditions:[],resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'整理随身物品并准备出门',stages:[],evidence_ids:[]}});
const narration={narrative:'你合上作业本，将它收进书包，整理好出门前需要的东西。',speaker:null,dialogue:null,
  choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]};
function addStorageItem(save:SavePackage,id:string,name:string,container=false,location?:string){
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  save.entities.push({id,type:'item',components:{identity:{name,description:'测试物品',avatar_id:null},
    location:{location_id:location??player.components.location!.location_id},
    item:{weight:0.3,stackable:false,container,tracking:'tracked'}}});
}
function addStoragePair(save:SavePackage){addStorageItem(save,'qa_notebook','作业本');addStorageItem(save,'qa_bag','书包',true);}

describe('generated choice and ordinary storage settlement',()=>{
  it('preserves the full generated choice through planning and commits both storage and preparation evidence',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    save.last_turn={narrative:'你在书桌前写完作业本的一页。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    await f.store.write(save);
    const scope={scope:'now' as const,day_offset:0,window:'any' as const};
    const planner=vi.spyOn(f.ai,'planGoals').mockResolvedValue({goals:[
      {goal_id:'close_notebook',type:'WORLD_ACTION',normalized_goal:'合上作业本',depends_on:[],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
      {goal_id:'put_notebook_in_bag',type:'WORLD_ACTION',normalized_goal:'收进书包',depends_on:['close_notebook'],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
      {goal_id:'prepare_to_leave',type:'WORLD_ACTION',normalized_goal:'准备出门',depends_on:['put_notebook_in_bag'],condition:null,branch:null,temporal_scope:scope,target_entities:[]},
    ]});
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    const freeform=vi.spyOn(f.ai,'freeform').mockResolvedValue(storageProposal());
    vi.spyOn(f.ai,'narrate').mockResolvedValue(narration);
    const result=await handleAgentInput(f.service,{request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,input:choice});
    const after=await f.service.current(),player=after.entities.find(entity=>entity.id===after.player_state.entity_id)!;
    const notebook=after.entities.find(entity=>entity.components.identity?.name==='作业本')!;
    const bag=after.entities.find(entity=>entity.components.identity?.name==='书包')!;
    expect(result.plan?.goals).toHaveLength(1);
    expect(planner).not.toHaveBeenCalled();
    expect(result.plan?.goals[0]).toMatchObject({normalized_goal:choice,status:'completed'});
    expect(freeform).toHaveBeenCalledWith(expect.anything(),choice);
    expect(after.state_revision).toBe(save.state_revision+1);
    const inventory=player.components.inventory as Inventory|undefined;
    expect(inventory?.items).toMatchObject({[notebook.id]:1,[bag.id]:1});
    expect(inventory?.placements?.[notebook.id]).toBe(bag.id);
    expect(player.components.scene_position).toEqual(save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.scene_position);
    expect(after.resolution_receipts?.at(-1)?.effects).toEqual(expect.arrayContaining(['time','inventory','activity']));
    expect(after.resolution_receipts?.at(-1)?.storage).toEqual({item_id:notebook.id,container_id:bag.id});
    expect(after.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
    expect(after.action_facts?.at(-1)?.facts).toEqual(expect.arrayContaining([
      `物品已收纳：作业本 → 书包`,
    ]));
  });
  it('filters storage choices when the item has no public source or inventory is unavailable',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(executableChoices(save,[choice])).toEqual([]);
    save.last_turn={narrative:'作业本放在眼前。',speaker:null,dialogue:null,choices:[],context_actions:[]};
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    save.entities.push({id:'qa_known_elsewhere',type:'item',components:{
      identity:{name:'作业本',description:'普通作业本',avatar_id:null},
      location:{location_id:'elsewhere'},item:{weight:0.3,stackable:false},
    }});
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    save.entities.pop();
    addStoragePair(save);
    expect(classifyChoiceExecution(save,choice)).toBe('CONDITIONALLY_EXECUTABLE');
    save.definition.enabled_modules=save.definition.enabled_modules.filter(module=>!['inventory','commerce','equipment'].includes(module));
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
  });
  it('rolls back when a source item is ungrounded or no storage plan is provided',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),before=structuredClone(save);
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('没有对应实体');
    expect(save).toEqual(before);
    addStoragePair(save);
    save.last_turn={narrative:'作业本在书桌上。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    expect(()=>executeFreeform(save,choice,{...storageProposal(),storage_move:null},randomUUID())).toThrow('物品收纳');
    expect(save.state_revision).toBe(before.state_revision);
  });
  it('does not invent a duplicate item when a matching canonical item exists but is inaccessible',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStorageItem(save,'qa_bag','书包',true);
    save.last_turn={narrative:'作业本在书桌上。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    save.entities.push({id:'qa_notebook_elsewhere',type:'item',components:{
      identity:{name:'作业本',description:'普通作业本',avatar_id:null},
      location:{location_id:'elsewhere'},item:{weight:0.3,stackable:false},
    }});
    const before=structuredClone(save);
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('当前不可接触');
    expect(save).toEqual(before);
  });
  it('ignores invented IDs only when public names and grounding independently validate, but rejects a conflicting real ID',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    save.last_turn={narrative:'作业本在书桌上。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    const valid=executeFreeform(save,choice,{...storageProposal(),storage_move:{
      item_name:'作业本',item_id:'model_guess',container_name:'书包',container_id:'bag_guess'}},randomUUID());
    expect(valid.save.resolution_receipts?.at(-1)?.effects).toContain('inventory');
    const unrelated=save.entities.find(entity=>entity.id!==save.player_state.entity_id)!;
    expect(()=>executeFreeform(save,choice,{...storageProposal(),storage_move:{
      item_name:'作业本',item_id:unrelated.id,container_name:'书包',container_id:null}},randomUUID()))
      .toThrow('物品引用与当前状态不一致');
  });
  it('normalizes a model synonym list only to the container name actually spoken by the player',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    save.last_turn={narrative:'作业本在书桌上。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    const turn=executeFreeform(save,choice,{...storageProposal(),storage_move:{
      item_name:'作业本',item_id:null,container_name:'书包/随身背包',container_id:null,
    }},randomUUID());
    expect(turn.save.entities.filter(entity=>entity.components.identity?.name==='书包')).toHaveLength(1);
    expect(turn.save.entities.some(entity=>entity.components.identity?.name==='书包/随身背包')).toBe(false);
  });
  it('uses canonical storage bindings instead of a provider-invented source ID prerequisite',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    save.last_turn={narrative:'作业本在书桌上。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    const turn=executeFreeform(save,choice,{...storageProposal(),required_conditions:[
      {kind:'entity_exists',subject_id:save.player_state.entity_id},
      {kind:'item_accessible',subject_id:'model_guess'},
      {kind:'entity_exists',subject_id:'作业本'},
      {kind:'entity_exists',subject_id:'书包'},
      {kind:'capability',subject_id:'inventory.storage'},
    ]},randomUUID());
    expect(turn.save.resolution_receipts?.at(-1)?.effects).toContain('inventory');
    expect(()=>validateSave(turn.save)).not.toThrow();
    addStorageItem(save,'qa_remote_item','远处物品',false,'elsewhere');
    expect(()=>executeFreeform(save,choice,{...storageProposal(),required_conditions:[
      {kind:'item_accessible',subject_id:'qa_remote_item'},
    ]},randomUUID())).toThrow('可触及');
  });
  it('does not treat preparing to leave as an actual exit',()=>{
    expect(localDestination(choice)).toBeNull();
    expect(localDestination('穿鞋拿钥匙出门')).toBe('屋外');
  });
  it('settles a scene item washed and returned to another local position in one turn',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    save.entities.push({id:'qa_cup',type:'item',components:{identity:{name:'杯子',description:'普通杯子',avatar_id:null},
      location:{location_id:here},item:{weight:0.3,stackable:false}}});
    const input='把杯子洗好放回架子';
    const turn=executeFreeform(save,input,{...storageProposal(),storage_move:null,completion_quote:input,
      item_move:{item_id:'qa_cup',to:'scene' as const,position_label:'架子'}},randomUUID());
    const cup=turn.save.entities.find(entity=>entity.id==='qa_cup')!;
    expect(cup.components.location?.location_id).toBe(here);
    expect(cup.components.scene_position?.label).toBe('架子');
    expect(turn.save.resolution_receipts?.at(-1)?.effects).toContain('inventory');
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
    expect(turn.save.action_facts?.at(-1)?.facts).not.toContain(`已完成玩家目标：${input}`);
  });
  it('can take an accessible key and actually exit when the player asks to leave',async()=>{
    const f=await sparseSetup(),save=await f.service.current(),here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    save.entities.push({id:'qa_key',type:'item',components:{identity:{name:'钥匙',description:'普通钥匙',avatar_id:null},
      location:{location_id:here},item:{weight:0.1,stackable:false}}});
    const input='穿鞋拿钥匙出门';
    const turn=executeFreeform(save,input,{...storageProposal(),storage_move:null,completion_quote:input,
      item_move:{item_id:'qa_key',to:'held' as const,position_label:null}},randomUUID());
    const player=turn.save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    expect((player.components.inventory as Inventory|undefined)?.items.qa_key).toBe(1);
    expect(player.components.scene_position?.label).toBe('屋外');
    expect(turn.save.resolution_receipts?.at(-1)?.effects).toEqual(expect.arrayContaining(['inventory','position']));
    expect(turn.save.resolution_receipts?.at(-1)?.effects).not.toContain('progress');
  });
});

describe('shared canonical storage binding',()=>{
  it('binds scene and held sources with the same availability used by Choice and Freeform',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    const scene=bindStorageAction(save,choice);
    expect(scene.item).toMatchObject({status:'bound',known:true,visible:true,reachable:true,
      usableForAction:true,possession:'scene'});
    expect(scene.container).toMatchObject({status:'bound',visible:true,reachable:true,usableForAction:true});
    expect(classifyChoiceExecution(save,choice)).toBe('CONDITIONALLY_EXECUTABLE');
    const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    (player.components.inventory as Inventory).items.qa_notebook=1;
    delete save.entities.find(entity=>entity.id==='qa_notebook')!.components.location;
    const held=bindStorageAction(save,choice);
    expect(held.item).toMatchObject({status:'bound',visible:true,reachable:true,
      usableForAction:true,possession:'held'});
    expect(classifyChoiceExecution(save,choice)).toBe('CONDITIONALLY_EXECUTABLE');
    expect(executeFreeform(save,choice,storageProposal(),randomUUID()).save.resolution_receipts?.at(-1)?.effects).toContain('inventory');
  });
  it('does not use scene prose or a generated Choice to invent a missing container',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStorageItem(save,'qa_notebook','作业本');
    save.last_turn={narrative:'书包就在旁边。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    const before=structuredClone(save),binding=bindStorageAction(save,choice);
    expect(binding.item.status).toBe('bound');
    expect(binding.container).toMatchObject({status:'missing',known:false,visible:false,reachable:false,usableForAction:false});
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('没有对应实体');
    expect(save).toEqual(before);
  });
  it('distinguishes a known remote container from a visible and reachable one',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStorageItem(save,'qa_notebook','作业本');
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    const remote=save.definition.map!.locations.find(location=>location.id!==here)!.id;
    save.map_state.known_location_ids.push(remote);
    addStorageItem(save,'qa_bag','书包',true,remote);
    const before=structuredClone(save),binding=bindStorageAction(save,choice);
    expect(binding.container).toMatchObject({status:'bound',known:true,visible:false,reachable:false,
      usableForAction:false,possession:'elsewhere'});
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('当前不可接触');
    expect(save).toEqual(before);
  });
  it('requires both the storage capability and an actual container role',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    save.entities.find(entity=>entity.id==='qa_bag')!.components.item!.container=false;
    const before=structuredClone(save),binding=bindStorageAction(save,choice);
    expect(binding.container).toMatchObject({status:'bound',visible:true,reachable:true,usableForAction:false});
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('不是当前可用的容器');
    expect(save).toEqual(before);
    save.entities.find(entity=>entity.id==='qa_bag')!.components.item!.container=true;
    save.definition.enabled_modules=save.definition.enabled_modules.filter(module=>!['inventory','commerce','equipment'].includes(module));
    expect(bindStorageAction(save,choice).capability).toBe(false);
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('没有物品收纳能力');
  });
  it('selects the unique reachable same-name entity and refuses two reachable duplicates',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    addStorageItem(save,'qa_remote_bag','书包',true,'station');
    expect(bindStorageAction(save,choice).container.entity?.id).toBe('qa_bag');
    expect(executeFreeform(save,choice,storageProposal(),randomUUID()).save.entities
      .find(entity=>entity.id==='qa_remote_bag')?.components.location?.location_id).toBe('station');
    addStorageItem(save,'qa_second_bag','书包',true);
    const before=structuredClone(save);
    expect(bindStorageAction(save,choice).container.status).toBe('ambiguous');
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('不唯一');
    expect(save).toEqual(before);
  });
  it('rechecks an offered Choice against the latest state without changing time or revision on failure',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    addStoragePair(save);
    expect(classifyChoiceExecution(save,choice)).toBe('CONDITIONALLY_EXECUTABLE');
    save.last_turn={narrative:'物品在眼前。',speaker:null,dialogue:null,choices:[choice],context_actions:[]};
    save.entities.find(entity=>entity.id==='qa_bag')!.components.location={location_id:'station'};
    const before=structuredClone(save),binding=bindStorageAction(save,choice);
    expect(binding.container).toMatchObject({status:'bound',reachable:false,usableForAction:false});
    expect(classifyChoiceExecution(save,choice)).toBe('NOT_EXECUTABLE');
    expect(()=>executeFreeform(save,choice,storageProposal(),randomUUID())).toThrow('当前不可接触');
    expect(save).toEqual(before);
  });
});
