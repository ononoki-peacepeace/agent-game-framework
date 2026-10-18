import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {fresh} from './helpers.js';
import {sparseSetup} from './sparse-fixture.js';
import {executeFreeform} from '../src/core/freeform.js';
import {publicView,validateSave} from '../src/core/state.js';
import {environmentContext,executeEnvironmentQuery,executeSceneSurvey,broadContainerObservation} from '../src/core/environment.js';
import {putItemInInventory} from '../src/modules/inventory.js';
import {ensureOrdinaryItem} from '../src/modules/inventory.js';
import {executeAction} from '../src/core/runtime.js';
import {settleAutonomousNpcTurn,decideNpc,type NpcDecision} from '../src/agent/npc-agent.js';
import {emptyNpcAgentState} from '../src/agent/npc-state.js';
import {AIRuntime} from '../src/ai/runtime.js';
import type {GameService} from '../src/server/service.js';

const proposal={narrative:'尝试走到局部位置',minutes:2,target_id:null,facts:[],relationship:null,
  item_move:null,storage_move:null,completion_quote:null,required_conditions:[],
  resolution:{type:'DETERMINISTIC' as const,domain:'general',band:'normal' as const,
    visibility:'public' as const,stakes:'局部移动',stages:[],evidence_ids:[]}};
const assessment=(quote:string,existence:'present'|'absent')=>({authorized_intent:'observe' as const,
  scope_complete:true,classification:'environment_detail' as const,existence,
  ownership:'shared' as const,world_compatible:true,scene_compatible:true,
  contradicts_known:false,resource_advantage:false,weight:0,
  description:'局部静态设施',basis:[{source:'scene' as const,quote}],same_as:null});

describe('broad scene survey',()=>{
  it('returns an invalid source quote to the same assessor and accepts its corrected candidate',async()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    save.definition.map!.locations.find(l=>l.id===actor.components.location!.location_id)!.description='这间房用于阅读。';
    let calls=0;
    const ai=new AIRuntime({name:'fixture',async generate(){calls++;
      return {data:{features:[{name:'书桌',assessment:assessment(calls===1?'虚构依据':'这间房用于阅读','present')}]}};}});
    const result=await ai.surveyEnvironment(save,'我观察这个房间');
    expect(calls).toBe(2);
    expect(result.features[0].assessment.basis[0].quote).toBe('这间房用于阅读');
    expect(save.environment_state).toBeUndefined();
  });
  it('commits a player room overview through the service and reuses it on retry',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location!.location_id;
    save.definition.map!.locations.find(l=>l.id===here)!.description='这间书房用于阅读和写作。';
    await f.store.write(save);
    const survey=vi.spyOn(f.ai,'surveyEnvironment').mockResolvedValue({features:[
      {name:'书桌',assessment:assessment('这间书房用于阅读和写作','present')}]});
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你环顾书房，看见书桌。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const request_id=randomUUID(),request={game_id:save.game_id,expected_revision:save.state_revision,request_id,input:'我观察这个书房。'};
    await f.service.turn(request);
    const after=await f.service.current();
    expect(after.environment_state?.resolutions).toHaveLength(1);
    expect(after.environment_state?.surveys).toHaveLength(1);
    expect(survey).toHaveBeenCalledOnce();
    await f.service.turn(request);
    expect((await f.service.current()).environment_state?.resolutions).toHaveLength(1);
    expect(survey).toHaveBeenCalledOnce();
    await f.service.undo({game_id:after.game_id,expected_revision:after.state_revision,request_id:randomUUID()});
    expect((await f.service.current()).environment_state?.surveys).toBeUndefined();
  });
  it('serializes two competing room surveys without cloning an ordinary item',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location!.location_id;
    save.definition.map!.locations.find(l=>l.id===here)!.description='这间书房用于阅读和写作。';
    await f.store.write(save);
    vi.spyOn(f.ai,'surveyEnvironment').mockResolvedValue({features:[{name:'普通纸片',assessment:{
      ...assessment('阅读和写作','present'),classification:'ordinary_item',weight:0.05}}]});
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你看到普通纸片。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const req={game_id:save.game_id,expected_revision:save.state_revision,input:'我观察这个书房。'};
    const results=await Promise.allSettled([f.service.turn({...req,request_id:randomUUID()}),
      f.service.turn({...req,request_id:randomUUID()})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const after=validateSave(await f.service.current());
    expect(after.environment_state?.resolutions.filter(r=>r.name==='普通纸片')).toHaveLength(1);
    expect(after.entities.filter(e=>e.components.identity?.name==='普通纸片')).toHaveLength(1);
    expect(after.environment_state?.surveys).toHaveLength(1);
  });
  it('establishes ordinary scene facts once and repeats without generating inventory',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const place=save.definition.map!.locations.find(l=>l.id===actor.components.location!.location_id)!;
    place.description='这间书房用于阅读和写作。';
    const input='我观察这个书房。';
    const first=executeSceneSurvey(save,input,{features:[{name:'书桌',assessment:assessment('这间书房用于阅读和写作','present')}]},randomUUID());
    const checked=validateSave(first.save);
    expect(checked.environment_state?.surveys).toHaveLength(1);
    expect(checked.environment_state?.resolutions).toMatchObject([{name:'书桌',status:'present'}]);
    expect(checked.entities.find(e=>e.id===actor.id)?.components.inventory?.items).toEqual(actor.components.inventory?.items);
    expect(checked.runtime.time.minute).toBe(save.runtime.time.minute+1);
    const repeat=executeSceneSurvey(checked,input,undefined,randomUUID());
    expect(repeat.save.environment_state?.resolutions).toHaveLength(1);
    expect(repeat.save.environment_state?.surveys).toHaveLength(1);
    expect(repeat.facts.join(' ')).toContain('书桌');
  });
  it('lets a later player see the NPC broad survey while leaving a private targeted find private',()=>{
    const save=fresh(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
    const here=player.components.location!.location_id;
    npc.components.location={location_id:here};
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有供日常写作的陈设。';
    const npcInput='观察这个房间';
    const observed=executeSceneSurvey(save,npcInput,{features:[{name:'书桌',assessment:assessment('供日常写作的陈设','present')}]},randomUUID(),npc.id);
    expect(JSON.stringify(publicView(observed.save))).not.toContain('书桌');
    const later=executeSceneSurvey(observed.save,'我观察这个房间',undefined,randomUUID());
    expect(later.save.environment_state?.resolutions[0].known_by).toEqual([npc.id,player.id]);
    expect(publicView(later.save).locations.find(l=>l.id===here)?.description).toContain('书桌');
    expect(later.save.environment_state?.surveys).toHaveLength(1);
  });
});

describe('scoped container contents',()=>{
  it('upgrades a bounded overview to a proven nonempty complete scope and keeps later placement historical',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const name='普通纸片',input='我查看木盒里的普通纸片';
    const ordinary={...assessment('普通木盒','present'),classification:'ordinary_item' as const,weight:0.05};
    const found=executeEnvironmentQuery(staged,input,{name,source_quote:input,intent:'observe',container_id:container.id},1,
      ordinary,randomUUID()).save;
    const feature={name,assessment:ordinary};
    const preview=executeSceneSurvey(found,'我查看木盒里有什么',{features:[feature]},randomUUID(),actor.id,container.id).save;
    expect(preview.environment_state?.surveys?.[0].complete_contents).toBeUndefined();
    const full='我仔细检查木盒里面全部内容';
    const complete=executeSceneSurvey(preview,full,{features:[feature],complete_contents:true,
      contents_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}},
    randomUUID(),actor.id,container.id).save;
    expect(complete.environment_state?.surveys).toHaveLength(2);
    expect(complete.environment_state?.surveys?.[1]).toMatchObject({complete_contents:true,record_ids:[expect.any(String)]});
    const missing='我查看木盒里的普通木尺';
    const absent=executeEnvironmentQuery(complete,missing,{name:'普通木尺',source_quote:missing,intent:'observe',container_id:container.id},1,
      ordinary,randomUUID()).save;
    expect(absent.environment_state?.resolutions.find(r=>r.name==='普通木尺')).toMatchObject({status:'absent',
      sequence:complete.environment_state?.surveys?.[1].sequence});
    const laterItem=ensureOrdinaryItem(absent,'普通木尺',0.05);putItemInInventory(absent,laterItem.id);
    const placed=executeAction(absent,{type:'MOVE_ITEM',parameters:{item_id:laterItem.id,to:'scene_container',
      container_id:container.id,position_label:null}},randomUUID()).save;
    const later=executeEnvironmentQuery(placed,missing,{name:'普通木尺',source_quote:missing,intent:'observe',container_id:container.id},1,
      ordinary,randomUUID()).save;
    expect(later.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'present',entity_id:laterItem.id});
    expect(later.environment_state?.surveys?.[1].complete_contents).toBe(true);
    expect(validateSave(later)).toBeDefined();
  });
  it('declines a complete nonempty claim when an unlisted item already occupies the container',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const existing=ensureOrdinaryItem(staged,'既有纸条',0.05);existing.components.location={location_id:here};
    existing.components.item!.container_id=container.id;
    const result=executeSceneSurvey(staged,'我仔细检查木盒里面全部内容',{features:[{name:'普通纸片',
      assessment:{...assessment('普通木盒','present'),classification:'ordinary_item',weight:0.05}}],
      complete_contents:true,contents_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}},
    randomUUID(),actor.id,container.id).save;
    expect(result.environment_state?.surveys?.[0].complete_contents).toBeUndefined();
    expect(result.last_turn?.narrative).not.toContain('充分检查当前容器');
  });
  it('hides an authored contained item until the player explicitly checks that container',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const item=ensureOrdinaryItem(staged,'普通纸片',0.05);
    item.components.location={location_id:here};item.components.item!.container_id=container.id;
    expect(publicView(staged).entities.some(e=>e.id===item.id)).toBe(false);
    const input='我查看木盒里的普通纸片';
    const found=executeEnvironmentQuery(staged,input,{name:'普通纸片',source_quote:input,intent:'observe',
      container_id:container.id},1,{...assessment('普通木盒','present'),classification:'ordinary_item',weight:0.05},
    randomUUID()).save;
    expect(found.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'present',entity_id:item.id});
    expect(publicView(found).entities.some(e=>e.id===item.id)).toBe(true);
    expect(found.entities.filter(e=>e.components.identity?.name==='普通纸片')).toHaveLength(1);
  });
  it('commits an exhaustive upgrade once through HTTP service and Undo restores the prior partial view',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const name='普通纸片',input='我查看木盒里的普通纸片';
    const ordinary={...assessment('普通木盒','present'),classification:'ordinary_item' as const,weight:0.05};
    const found=executeEnvironmentQuery(staged,input,{name,source_quote:input,intent:'observe',container_id:container.id},1,
      ordinary,randomUUID()).save;
    const feature={name,assessment:ordinary};
    const partial=executeSceneSurvey(found,'我查看木盒里有什么',{features:[feature]},randomUUID(),actor.id,container.id).save;
    await f.store.write(partial);
    const survey=vi.spyOn(f.ai,'surveyEnvironment').mockResolvedValue({features:[feature],complete_contents:true,
      contents_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}});
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你仔细检查木盒，确认只有普通纸片。',speaker:null,
      dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const request={game_id:partial.game_id,expected_revision:partial.state_revision,request_id:randomUUID(),
      input:'我仔细检查木盒里面全部内容'};
    await f.service.turn(request);
    const completed=await f.service.current();
    expect(completed.environment_state?.surveys).toHaveLength(2);
    expect(completed.environment_state?.surveys?.[1].complete_contents).toBe(true);
    await f.service.turn(request);
    expect((await f.service.current()).environment_state?.surveys).toHaveLength(2);
    expect(survey).toHaveBeenCalledOnce();
    await f.service.undo({game_id:completed.game_id,expected_revision:completed.state_revision,request_id:randomUUID()});
    const undone=await f.service.current();
    expect(undone.environment_state?.surveys).toHaveLength(1);
    expect(undone.environment_state?.surveys?.[0].complete_contents).toBeUndefined();
  });
  it('repairs an invented remainder basis before proposing a complete nonempty scope',async()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    let calls=0;
    const ai=new AIRuntime({name:'fixture',async generate(){calls++;
      return {data:{features:[{name:'普通纸片',assessment:{...assessment('普通木盒','present'),
        classification:'ordinary_item',weight:0.05}}],complete_contents:true,
        contents_assessment:{...assessment(calls===1?'虚构剩余依据':'普通木盒','absent'),
          classification:'ordinary_item'}}};}});
    const proposal=await ai.surveyEnvironment(staged,'我仔细检查木盒里面全部内容',actor.id,container.id);
    expect(calls).toBe(2);
    expect(proposal.contents_assessment?.basis[0].quote).toBe('普通木盒');
    expect(staged.environment_state?.surveys).toBeUndefined();
  });
  it('binds a genuinely complete empty-container check and excludes later retroactive contents',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const full='我仔细检查木盒里面是否为空';
    expect(broadContainerObservation(staged,full)).toBe(container.id);
    const checked=executeSceneSurvey(staged,full,{features:[],complete_empty:true,
      empty_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}},randomUUID(),actor.id,container.id).save;
    expect(checked.environment_state?.surveys?.[0]).toMatchObject({container_id:container.id,complete_empty:true});
    const name='普通纸片',input='我查看木盒里的普通纸片';
    const query={name,source_quote:input,intent:'observe' as const,container_id:container.id};
    const ordinary={...assessment('普通','present'),classification:'ordinary_item' as const,weight:0.05};
    const absent=executeEnvironmentQuery(checked,input,query,1,ordinary,randomUUID()).save;
    expect(absent.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'absent',entity_id:null});
    expect(absent.environment_state?.resolutions[0]).toMatchObject({status:'absent',container_id:container.id});
    const item=ensureOrdinaryItem(absent,name,0.05);putItemInInventory(absent,item.id);
    const moved=executeAction(absent,{type:'MOVE_ITEM',parameters:{item_id:item.id,to:'scene_container',container_id:container.id,position_label:null}},randomUUID()).save;
    const later=executeEnvironmentQuery(moved,input,query,1,ordinary,randomUUID()).save;
    expect(later.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'present',entity_id:item.id});
    expect(later.environment_state?.resolutions[0].status).toBe('absent');
    const rechecked=executeSceneSurvey(later,full,undefined,randomUUID(),actor.id,container.id).save;
    expect(rechecked.last_turn?.narrative).toContain('后来放入的普通纸片');
    expect(rechecked.environment_state?.surveys?.[0].complete_empty).toBe(true);
    expect(validateSave(later)).toBeDefined();
  });
  it('does not disclose a later protected placement through an old complete survey',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const input='我仔细检查木盒里面是否为空';
    const checked=executeSceneSurvey(staged,input,{features:[],complete_empty:true,
      empty_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}},
    randomUUID(),actor.id,container.id).save;
    checked.entities.push({id:'later_sealed_evidence',type:'item',components:{identity:{name:'密封证物',description:'受保护的后入物'},
      location:{location_id:here},discovery:{known_to_player:false},item:{weight:0.1,stackable:false,
        container:false,container_id:container.id,placed_sequence:(checked.environment_state!.surveys![0].sequence??0)+1,
        tags:['evidence'],tracking:'tracked'}}});
    expect(publicView(checked).entities.some(e=>e.id==='later_sealed_evidence')).toBe(false);
    const repeat=executeSceneSurvey(checked,input,undefined,randomUUID(),actor.id,container.id).save;
    expect(repeat.last_turn?.narrative).not.toContain('密封证物');
    expect(repeat.last_turn?.narrative).not.toContain('它是空的');
    expect(repeat.last_turn?.narrative).toContain('不能确认当前容器的全部内容');
    expect(validateSave(repeat)).toBeDefined();
  });
  it('does not certify an occupied container empty even if the assessor proposes it',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const item=ensureOrdinaryItem(staged,'普通纸片',0.05);
    item.components.location={location_id:here};item.components.item!.container_id=container.id;
    const result=executeSceneSurvey(staged,'我仔细检查木盒里面是否为空',
      {features:[],complete_empty:true,empty_assessment:{...assessment('普通木盒','absent'),classification:'ordinary_item'}},
      randomUUID(),actor.id,container.id).save;
    expect(result.environment_state?.surveys?.[0].complete_empty).toBeUndefined();
    expect(result.last_turn?.narrative).not.toContain('确认在这次检查时它是空的');
  });
  it('rejects a complete empty claim without a bound assessment and repairs an invalid quote',async()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),container=ensureOrdinaryItem(save,'木盒',0.4,true);
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const input='我仔细检查木盒里面是否为空';
    expect(()=>executeSceneSurvey(staged,input,{features:[],complete_empty:true},randomUUID(),actor.id,container.id))
      .toThrow('完整空容器判断缺少');
    let calls=0;
    const ai=new AIRuntime({name:'fixture',async generate(){calls++;
      return {data:{features:[],complete_empty:true,empty_assessment:{...assessment(calls===1?'虚构依据':'普通木盒','absent'),
        classification:'ordinary_item'}}};}});
    const repaired=await ai.surveyEnvironment(staged,input,actor.id,container.id);
    expect(calls).toBe(2);
    const checked=executeSceneSurvey(staged,input,repaired,randomUUID(),actor.id,container.id);
    expect(checked.save.environment_state?.surveys?.[0].complete_empty).toBe(true);
  });

  it('establishes one bounded overview per named container and reuses it through the service',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(e=>e.id===save.player_state.entity_id)!.components.location!.location_id;
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只放日常纸品的普通木盒。';
    const container=ensureOrdinaryItem(save,'木盒',0.4,true);
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    await f.store.write(staged);
    const input='我查看木盒里有什么';
    expect(broadContainerObservation(staged,input)).toBe(container.id);
    const survey=vi.spyOn(f.ai,'surveyEnvironment').mockResolvedValue({features:[
      {name:'普通纸片',assessment:{...assessment('放日常纸品','present'),classification:'ordinary_item',weight:0.05}}]});
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你看见木盒里的普通纸片。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const request={game_id:staged.game_id,expected_revision:staged.state_revision,request_id:randomUUID(),input};
    await f.service.turn(request);
    const after=await f.service.current();
    expect(after.environment_state?.surveys).toMatchObject([{container_id:container.id,record_ids:[expect.any(String)]}]);
    expect(after.environment_state?.resolutions).toMatchObject([{container_id:container.id,name:'普通纸片'}]);
    expect(after.entities.find(e=>e.components.identity?.name==='普通纸片')?.components.item?.container_id).toBe(container.id);
    await f.service.turn({...request,expected_revision:after.state_revision,request_id:randomUUID()});
    expect((await f.service.current()).environment_state?.surveys).toHaveLength(1);
    expect(survey).toHaveBeenCalledOnce();
  });

  it('materializes an ordinary item once inside an accessible scene container, then takes that same item',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=actor.components.location!.location_id,container=ensureOrdinaryItem(save,'木盒',0.4,true);
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    staged.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    const name='普通木尺',input='我查看木盒里的普通木尺';
    const query={name,source_quote:input,intent:'observe' as const,container_id:container.id};
    const ordinary={...assessment('普通木盒','present'),classification:'ordinary_item' as const,weight:0.1,
      ownership:'unclaimed' as const};
    const first=executeEnvironmentQuery(staged,input,query,1,ordinary,randomUUID()).save;
    const item=first.entities.find(e=>e.components.identity?.name===name)!;
    expect(item.components.item?.container_id).toBe(container.id);
    expect(first.environment_state?.resolutions[0]).toMatchObject({container_id:container.id,status:'present',entity_id:item.id});
    const second=executeEnvironmentQuery(first,input,query,1,ordinary,randomUUID()).save;
    expect(second.entities.filter(e=>e.components.identity?.name===name)).toHaveLength(1);
    const taken=executeEnvironmentQuery(second,'我拿起木盒里的普通木尺',
      {...query,source_quote:'我拿起木盒里的普通木尺',intent:'take_if_available'},1,
      {...ordinary,authorized_intent:'take_if_available'},randomUUID()).save;
    expect(taken.entities.find(e=>e.id===item.id)?.components.item?.container_id).toBeUndefined();
    expect((taken.entities.find(e=>e.id===actor.id)?.components.inventory?.items as Record<string,number>)[item.id]).toBe(1);
    expect(taken.environment_state?.resolutions).toHaveLength(1);
    expect(validateSave(taken)).toBeDefined();
  });

  it('keeps a complete negative container check historical after a later real placement',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=actor.components.location!.location_id,container=ensureOrdinaryItem(save,'木盒',0.4,true);
    putItemInInventory(save,container.id);
    const staged=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:container.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    staged.definition.map!.locations.find(l=>l.id===here)!.description='这里有一只普通木盒。';
    const name='普通木尺',input='我查看木盒里的普通木尺';
    const query={name,source_quote:input,intent:'observe' as const,container_id:container.id};
    const missing=executeEnvironmentQuery(staged,input,query,1,{...assessment('普通木盒','absent'),
      classification:'ordinary_item',ownership:'unclaimed'},randomUUID()).save;
    expect(missing.environment_state?.resolutions).toMatchObject([{status:'absent',container_id:container.id}]);
    const item=ensureOrdinaryItem(missing,name,0.1);
    putItemInInventory(missing,item.id);
    const moved=executeAction(missing,{type:'MOVE_ITEM',parameters:{item_id:item.id,to:'scene_container',container_id:container.id,position_label:null}},randomUUID()).save;
    const later=executeEnvironmentQuery(moved,input,query,1,{...assessment('普通木盒','absent'),
      classification:'ordinary_item',ownership:'unclaimed'},randomUUID()).save;
    expect(later.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'present',entity_id:item.id});
    expect(later.environment_state?.resolutions).toHaveLength(1);
    expect(later.environment_state?.resolutions[0].status).toBe('absent');
  });
  it('does not treat an unproven object placement as a later event that rewrites a negative check',()=>{
    const save=fresh(),actor=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id),name='普通木尺',input='我观察普通木尺';
    save.environment_state={resolutions:[{id:'env_old_absence',location_id:here,name,aliases:[],
      status:'absent',classification:'ordinary_item',entity_id:null,description:'此前未找到',take_allowed:false,
      source_request_id:randomUUID(),at:structuredClone(save.runtime.time),known_by:[actor.id]}]};
    const item=ensureOrdinaryItem(save,name,0.1);
    item.components.location={location_id:here};
    const checked=executeEnvironmentQuery(save,input,{name,source_quote:input,intent:'observe'},1,
      {...assessment('普通','present'),classification:'ordinary_item',weight:0.1},randomUUID()).save;
    expect(checked.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'unresolved',entity_id:null});
    expect(checked.environment_state?.resolutions).toHaveLength(1);
  });
});

describe('stale NPC location knowledge',()=>{
  it('keeps an earlier observation historical after another actor moves the item',async()=>{
    const save=fresh(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const npc=save.entities.find(e=>e.id==='npc_lin')!,other=save.entities.find(e=>e.id==='npc_qiao')!;
    const here=String(player.components.location!.location_id),name='普通木尺',input='我观察普通木尺';
    npc.components.location={location_id:here};other.components.location={location_id:here};
    save.definition.map!.locations.find(l=>l.id===here)!.description='这里有日常工具存放区。';
    const ordinary={...assessment('日常工具存放区','present'),classification:'ordinary_item' as const,
      weight:0.1,ownership:'unclaimed' as const};
    const found=executeEnvironmentQuery(save,input,{name,source_quote:input,intent:'observe'},1,ordinary,
      randomUUID(),npc.id).save;
    const record=found.environment_state!.resolutions[0],itemId=record.entity_id!;
    found.npc_agent_state??={};found.npc_agent_state[npc.id]=emptyNpcAgentState();
    found.npc_agent_state[npc.id].knowledge.push({id:`environment:${record.id}`,
      proposition:`在${here}观察到${name}。`,source_type:'observed',source_ref:record.id,
      learned_at:structuredClone(found.runtime.time),confidence:1});
    const held=executeAction(found,{type:'MOVE_ITEM',parameters:{item_id:itemId,to:'held',container_id:null,position_label:null}},
      randomUUID(),'ai',undefined,undefined,true,other.id).save;
    const moved=executeAction(held,{type:'MOVE',target_id:'station',parameters:{}},randomUUID(),
      'ai',undefined,undefined,true,other.id).save;
    const dropped=executeAction(moved,{type:'MOVE_ITEM',parameters:{item_id:itemId,to:'scene',container_id:null,position_label:null}},
      randomUUID(),'ai',undefined,undefined,true,other.id).save;
    let context:any;
    const service={ai:{npcDecision:async(_profile:unknown,received:unknown)=>{context=received;
      return {kind:'no_action',speech:null,vote_target:null,intent:'仍按所知行动',proposed_action:null,
        evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],
        decision_summary:'没有新观察',social_response:null};}}} as unknown as GameService;
    await decideNpc(service,dropped,npc.id,{kind:'world_event',description:'普通生活'});
    expect(context.knowledge.some((entry:{proposition:string})=>entry.proposition.includes(`在${here}观察到${name}`))).toBe(true);
    expect(context.scene.visible_entities.some((entry:{id:string})=>entry.id===itemId)).toBe(false);
    expect(context.knowledge.some((entry:{proposition:string})=>entry.proposition.includes(`在station观察到${name}`))).toBe(false);
    expect(dropped.entities.find(e=>e.id===itemId)?.components.location?.location_id).toBe('station');
  });
});

describe('local scene World Gap admission',()=>{
  it('lets a later Core arrival supersede an old failed room search without deleting its history',()=>{
    const save=fresh(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const here=String(player.components.location!.location_id),name='普通木尺';
    save.environment_state={resolutions:[{id:'env_prior_absence',location_id:here,name,aliases:[],
      status:'absent',classification:'ordinary_item',entity_id:null,description:'此前检查未发现',take_allowed:false,
      source_request_id:randomUUID(),at:structuredClone(save.runtime.time),known_by:[player.id]}]};
    const item=ensureOrdinaryItem(save,name,0.1);
    putItemInInventory(save,item.id);
    const moved=executeAction(save,{type:'MOVE_ITEM',parameters:{item_id:item.id,to:'scene',container_id:null,position_label:null}},randomUUID()).save;
    const input='我观察普通木尺';
    const seen=executeEnvironmentQuery(moved,input,{name,source_quote:input,intent:'observe'},1,
      {...assessment('普通','present'),classification:'ordinary_item',weight:0.1},randomUUID());
    expect(seen.save.environment_state?.resolutions).toHaveLength(1);
    expect(seen.save.environment_state?.resolutions[0].status).toBe('absent');
    expect(seen.save.resolution_receipts?.at(-1)?.environment).toMatchObject({status:'present',entity_id:item.id});
    expect(seen.save.entities.filter(e=>e.components.item&&e.components.identity?.name===name)).toHaveLength(1);
  });
  it('discovers the same NPC-founded item after real transfer from another scene',()=>{
    const save=fresh(),player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
    npc.components.location={location_id:'station'};
    save.definition.map!.locations.find(l=>l.id==='station')!.description='站台存放一些普通办公物品。';
    const name='普通木尺',npcInput='我观察普通木尺';
    const ordinary={...assessment('普通办公物品','present'),classification:'ordinary_item' as const,weight:0.1,ownership:'unclaimed' as const};
    const found=executeEnvironmentQuery(save,npcInput,{name,source_quote:npcInput,intent:'observe'},1,ordinary,randomUUID(),npc.id).save;
    const id=found.environment_state!.resolutions[0].entity_id!;
    const held=executeAction(found,{type:'MOVE_ITEM',parameters:{item_id:id,to:'held',container_id:null,position_label:null}},
      randomUUID(),'ai',undefined,undefined,true,npc.id).save;
    const moved=executeAction(held,{type:'MOVE',target_id:'square',parameters:{}},randomUUID(),
      'ai',undefined,undefined,true,npc.id).save;
    const dropped=executeAction(moved,{type:'MOVE_ITEM',parameters:{item_id:id,to:'scene',container_id:null,position_label:null}},
      randomUUID(),'ai',undefined,undefined,true,npc.id).save;
    expect(publicView(dropped).entities.some(e=>e.id===id)).toBe(false);
    const input='我观察普通木尺';
    const seen=executeEnvironmentQuery(dropped,input,{name,source_quote:input,intent:'observe'},1,ordinary,
      randomUUID()).save;
    expect(seen.environment_state?.resolutions).toHaveLength(1);
    expect(seen.environment_state?.resolutions[0].known_by).toEqual([npc.id,player.id]);
    expect(publicView(seen).entities.some(e=>e.id===id)).toBe(true);
  });
  it('uses the existing freeform HTTP transaction without a second movement commit',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id;
    save.definition.map!.locations.find(location=>location.id===here)!.description='书房有外墙和日常陈设。';
    await f.store.write(save);
    vi.spyOn(f.ai,'interpret').mockResolvedValue({type:'FREEFORM_ACTION',parameters:{}});
    vi.spyOn(f.ai,'freeform').mockResolvedValue(proposal);
    const assessor=vi.spyOn(f.ai,'assessEnvironment').mockResolvedValue(assessment('书房有外墙','present'));
    vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你走到窗边。',speaker:null,dialogue:null,
      choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]});
    const result=await f.service.turn({game_id:save.game_id,expected_revision:save.state_revision,
      request_id:randomUUID(),input:'我走到窗边'});
    const after=await f.service.current();
    expect(result.revision).toBe(save.state_revision+1);
    expect(after.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.scene_position?.label).toBe('窗边');
    expect(after.resolution_receipts?.filter(receipt=>receipt.effects.includes('position'))).toHaveLength(1);
    expect(assessor).toHaveBeenCalledOnce();
  });
  it('establishes one ordinary feature and local position in the same Core receipt',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const place=save.definition.map!.locations.find(location=>location.id===player.components.location!.location_id)!;
    place.description='书房有外墙和日常陈设。';
    const before=structuredClone(save);
    const turn=executeFreeform(save,'我走到窗边',proposal,randomUUID(),undefined,false,undefined,
      assessment('书房有外墙','present'));
    const next=validateSave(turn.save);
    expect(next.entities.find(entity=>entity.id===player.id)?.components.scene_position?.label).toBe('窗边');
    expect(next.environment_state?.resolutions).toMatchObject([{name:'窗边',status:'present',classification:'environment_detail'}]);
    expect(next.resolution_receipts?.at(-1)?.effects).toContain('position');
    expect(next.runtime.time.minute).toBe(before.runtime.time.minute+2);
    expect(save).toEqual(before);
    expect(publicView(next).locations.find(location=>location.id===place.id)?.description).toContain('窗边');
  });

  it('settles a known absence as a normal failed attempt and never redraws it',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    save.definition.map!.locations.find(location=>location.id===player.components.location!.location_id)!.description=
      '封闭的地下房间没有窗户。';
    const first=executeFreeform(save,'我走到窗边',proposal,randomUUID(),undefined,false,undefined,
      assessment('没有窗户','absent'));
    expect(first.save.entities.find(entity=>entity.id===player.id)?.components.scene_position).toBeUndefined();
    expect(first.save.resolution_receipts?.at(-1)?.outcome).toBe('failure');
    expect(first.save.runtime.time.minute).toBe(save.runtime.time.minute+2);
    const second=executeFreeform(first.save,'我走到窗边',proposal,randomUUID(),undefined,false,undefined,
      assessment('没有窗户','present'));
    expect(second.save.environment_state?.resolutions).toHaveLength(1);
    expect(second.save.environment_state?.resolutions[0].status).toBe('absent');
    expect(second.save.entities.find(entity=>entity.id===player.id)?.components.scene_position).toBeUndefined();
  });
  it('keeps a private world detail out of the player projection and assessor context',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
    const here=String(player.components.location!.location_id);
    save.environment_state={resolutions:[{id:'env_private_detail',location_id:here,name:'暗格',aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:'墙后有一处暗格',
      take_allowed:false,source_request_id:randomUUID(),at:structuredClone(save.runtime.time),known_by:[String(npc.id)]}]};
    expect(JSON.stringify(publicView(save))).not.toContain('墙后有一处暗格');
    expect(environmentContext(save).prior_resolutions).toEqual([]);
    const result=executeFreeform(save,'我走到暗格',proposal,randomUUID(),undefined,false,undefined,
      assessment('墙后','present'));
    expect(result.save.entities.find(entity=>entity.id===player.id)?.components.scene_position).toBeUndefined();
    expect(result.save.resolution_receipts?.at(-1)?.outcome).toBe('failure');
  });
  it('does not project another character private awareness and target list',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
    npc.components.physical_state={awareness:'alert',alert_to_ids:[player.id],restrained_by:null};
    const local=publicView(save).entities.find(entity=>entity.id===npc.id);
    expect(local?.components.physical_state).toMatchObject({awareness:'alert',alert_to_ids:[]});
    npc.components.location={location_id:'station'};
    const remote=publicView(save).entities.find(entity=>entity.id===npc.id);
    expect(remote?.components.physical_state).toBeUndefined();
    expect(save.entities.find(entity=>entity.id===npc.id)?.components.physical_state?.alert_to_ids).toEqual([player.id]);
  });
  it('rejects unknown or duplicate observers in a durable environment record',()=>{
    const save=fresh(),here=String(save.entities.find(entity=>entity.id===save.player_state.entity_id)!.components.location!.location_id);
    save.environment_state={resolutions:[{id:'env_observer_check',location_id:here,name:'壁龛',aliases:[],
      status:'present',classification:'environment_detail',entity_id:null,description:'普通壁龛',take_allowed:false,
      source_request_id:randomUUID(),at:structuredClone(save.runtime.time),known_by:['missing_actor']}]};
    expect(()=>validateSave(save)).toThrow('环境发现者');
    save.environment_state.resolutions[0].known_by=[save.player_state.entity_id,save.player_state.entity_id];
    expect(()=>validateSave(save)).toThrow('环境发现者');
  });
  it('does not reveal an NPC-discovered ordinary item in the same scene',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
    const here=String(player.components.location!.location_id);
    save.entities.push({id:'private_tool',type:'item',components:{
      identity:{name:'密藏工具',description:'NPC发现的工具',avatar_id:null,gender:null,age:null},
      location:{location_id:here},item:{weight:0.2,stackable:false,container:false,
        tags:['ordinary','gap_generated','non_tradeable'],tracking:'tracked'}}});
    save.environment_state={resolutions:[{id:'env_private_tool',location_id:here,name:'密藏工具',aliases:[],
      status:'present',classification:'ordinary_item',entity_id:'private_tool',description:'NPC发现的工具',
      take_allowed:true,source_request_id:randomUUID(),at:structuredClone(save.runtime.time),known_by:[npc.id]}]};
    const reloaded=validateSave(JSON.parse(JSON.stringify(save)));
    expect(publicView(reloaded).entities.some(entity=>entity.id==='private_tool')).toBe(false);
    putItemInInventory(reloaded,'private_tool',null,player.id);
    expect(publicView(validateSave(reloaded)).entities.some(entity=>entity.id==='private_tool')).toBe(true);
    reloaded.environment_state!.resolutions[0].known_by!.push(player.id);
    expect(publicView(reloaded).entities.some(entity=>entity.id==='private_tool')).toBe(true);
  });
  it('lets an NPC establish an ordinary item through the same Core World Gap without changing the player turn',()=>{
    const save=fresh(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
    const npc=save.entities.find(entity=>entity.id!==player.id&&entity.components.character)!;
    const here=String(player.components.location!.location_id),before=structuredClone(save.last_turn);
    npc.components.location={location_id:here};
    save.definition.map!.locations.find(location=>location.id===here)!.description='这间工坊有普通工具存放区。';
    const input='查看工坊里的普通木尺',requestId=randomUUID();
    const result=executeEnvironmentQuery(save,input,{name:'普通木尺',source_quote:input,intent:'observe'},1,
      {...assessment('普通工具存放区','present'),classification:'ordinary_item',ownership:'unclaimed',weight:0.2},
      requestId,npc.id);
    const next=validateSave(result.save),record=next.environment_state!.resolutions[0];
    expect(record).toMatchObject({name:'普通木尺',status:'present',known_by:[npc.id]});
    expect(next.resolution_receipts?.find(receipt=>receipt.request_id===requestId)?.actor_id).toBe(npc.id);
    expect(next.runtime.time).toEqual(save.runtime.time);
    expect(next.last_turn).toEqual(before);
    expect(publicView(next).entities.some(entity=>entity.id===record.entity_id)).toBe(false);
    const playerInput='我查看普通木尺';
    const discovered=executeEnvironmentQuery(next,playerInput,
      {name:'普通木尺',source_quote:playerInput,intent:'observe'},1,
      {...assessment('普通工具存放区','present'),classification:'ordinary_item',ownership:'unclaimed',weight:0.2},
      randomUUID());
    expect(discovered.save.environment_state?.resolutions).toHaveLength(1);
    expect(discovered.save.environment_state?.resolutions[0].known_by).toEqual([npc.id,player.id]);
    expect(publicView(discovered.save).entities.some(entity=>entity.id===record.entity_id)).toBe(true);
  });
  it('lets an autonomous NPC search privately, retain the result, and leave the player projection unchanged',async()=>{
    const initial=fresh(),npc=initial.entities.find(entity=>entity.id!==initial.player_state.entity_id&&entity.components.character)!;
    const here=String(npc.components.location!.location_id),reason='查看工坊里的普通木尺';
    initial.definition.map!.locations.find(location=>location.id===here)!.description='这间工坊有普通工具存放区。';
    const before=structuredClone(initial.runtime.time);
    const advanced=executeAction(initial,{type:'WAIT',parameters:{minutes:360}},randomUUID()).save;
    for(const other of advanced.entities.filter(entity=>entity.id!==npc.id&&entity.id!==advanced.player_state.entity_id&&entity.components.character)){
      advanced.npc_agent_state??={};advanced.npc_agent_state[other.id]=emptyNpcAgentState();
      advanced.npc_agent_state[other.id].last_autonomous_at=structuredClone(advanced.runtime.time);
    }
    let assessments=0;
    const decision:NpcDecision={kind:'proposed_action',speech:null,vote_target:null,intent:'寻找日常工具',
      proposed_action:{type:'INSPECT',target_id:null,reason,duration_minutes:null,
        environment_query:{name:'普通木尺',source_quote:reason,intent:'observe'}},
      evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],
      decision_summary:'按目标寻找普通木尺',social_response:null};
    let nextDecision=decision;
    const service={ai:{npcDecision:async()=>nextDecision,assessEnvironment:async()=>{
      assessments++;return {...assessment('普通工具存放区','present'),classification:'ordinary_item' as const,
        ownership:'unclaimed' as const,weight:0.2};}}} as unknown as GameService;
    const result=await settleAutonomousNpcTurn(service,advanced,before,randomUUID(),undefined,1);
    const after=validateSave(result.save),record=after.environment_state?.resolutions.find(item=>item.name==='普通木尺');
    expect(assessments).toBe(1);
    expect(record).toMatchObject({status:'present',known_by:[npc.id]});
    expect(after.npc_agent_state?.[npc.id].knowledge.some(entry=>entry.source_ref===record?.id)).toBe(true);
    expect(after.resolution_receipts?.some(receipt=>receipt.actor_id===npc.id&&receipt.environment?.resolution_id===record?.id&&
      receipt.commit_status==='committed')).toBe(true);
    expect(after.runtime.time).toEqual(advanced.runtime.time);
    expect(publicView(after).entities.some(entity=>entity.id===record?.entity_id)).toBe(false);
    const later=executeAction(after,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
    for(const other of later.entities.filter(entity=>entity.id!==npc.id&&entity.id!==later.player_state.entity_id&&entity.components.character))
      later.npc_agent_state![other.id].last_autonomous_at=structuredClone(later.runtime.time);
    nextDecision={...decision,intent:'收好找到的工具',proposed_action:{type:'TAKE',target_id:record!.entity_id,
      reason:'拿起已找到的普通木尺',duration_minutes:null}};
    const acquired=validateSave((await settleAutonomousNpcTurn(service,later,after.runtime.time,randomUUID(),undefined,1)).save);
    expect((acquired.entities.find(entity=>entity.id===npc.id)?.components.inventory?.items as Record<string,number>|undefined)?.[record!.entity_id!]).toBe(1);
    expect(acquired.resolution_receipts?.some(receipt=>receipt.actor_id===npc.id&&receipt.semantic_action==='MOVE_ITEM'&&
      receipt.commit_status==='committed')).toBe(true);
    expect(assessments).toBe(1);
    expect(publicView(acquired).entities.some(entity=>entity.id===record?.entity_id)).toBe(false);
  });
  it('persists an NPC search absence and does not create the wished-for item on repetition',()=>{
    const save=fresh(),npc=save.entities.find(entity=>entity.id!==save.player_state.entity_id&&entity.components.character)!;
    const here=String(npc.components.location!.location_id),input='查找普通木尺';
    save.definition.map!.locations.find(location=>location.id===here)!.description='这里有日常工具存放区。';
    const query={name:'普通木尺',source_quote:input,intent:'observe' as const};
    const first=executeEnvironmentQuery(save,input,query,1,
      {...assessment('日常工具存放区','absent'),classification:'ordinary_item',ownership:'unclaimed'},randomUUID(),npc.id);
    const second=executeEnvironmentQuery(first.save,input,query,1,
      {...assessment('日常工具存放区','present'),classification:'ordinary_item',ownership:'unclaimed'},randomUUID(),npc.id);
    expect(second.save.environment_state?.resolutions).toHaveLength(1);
    expect(second.save.environment_state?.resolutions[0]).toMatchObject({status:'absent',known_by:[npc.id]});
    expect(second.save.entities.some(entity=>entity.components.identity?.name==='普通木尺')).toBe(false);
    expect(second.save.runtime.time).toEqual(save.runtime.time);
  });
  it('lets an NPC replan after a real negative search without minting the requested resource',async()=>{
    const base=fresh(),npc=base.entities.find(entity=>entity.id==='npc_lin')!;
    const here=String(npc.components.location!.location_id),reason='查找普通木尺';
    base.definition.map!.locations.find(location=>location.id===here)!.description='这里有日常工具存放区。';
    const before=structuredClone(base.runtime.time);
    const wait=executeAction(base,{type:'WAIT',parameters:{minutes:360}},randomUUID()).save;
    for(const other of wait.entities.filter(entity=>entity.id!==npc.id&&entity.id!==wait.player_state.entity_id&&entity.components.character)){
      wait.npc_agent_state??={};wait.npc_agent_state[other.id]=emptyNpcAgentState();
      wait.npc_agent_state[other.id].last_autonomous_at=structuredClone(wait.runtime.time);
    }
    const search:NpcDecision={kind:'proposed_action',speech:null,vote_target:null,intent:'寻找工具',
      proposed_action:{type:'INSPECT',target_id:null,reason,duration_minutes:null,
        environment_query:{name:'普通木尺',source_quote:reason,intent:'observe'}},
      evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],
      decision_summary:'实际检查存放区',social_response:null};
    let decided=0;
    const service={ai:{npcDecision:async(_profile:unknown,context:{knowledge:{proposition:string}[]})=>{
      decided++;
      if(decided===1)return search;
      expect(context.knowledge.some(entry=>entry.proposition.includes('未找到'))).toBe(true);
      return {...search,intent:'换个地方继续找',proposed_action:{type:'MOVE',target_id:'market',
        reason:'前往市场寻找其他途径',duration_minutes:null,environment_query:null}};
    },assessEnvironment:async()=>({...assessment('日常工具存放区','absent'),
      classification:'ordinary_item' as const,ownership:'unclaimed' as const})}} as unknown as GameService;
    const first=validateSave((await settleAutonomousNpcTurn(service,wait,before,randomUUID(),undefined,1)).save);
    expect(first.environment_state?.resolutions[0]).toMatchObject({status:'absent',known_by:[npc.id]});
    const later=executeAction(first,{type:'WAIT',parameters:{minutes:180}},randomUUID()).save;
    for(const other of later.entities.filter(entity=>entity.id!==npc.id&&entity.id!==later.player_state.entity_id&&entity.components.character))
      later.npc_agent_state![other.id].last_autonomous_at=structuredClone(later.runtime.time);
    const next=validateSave((await settleAutonomousNpcTurn(service,later,first.runtime.time,randomUUID(),undefined,1)).save);
    expect(next.entities.find(entity=>entity.id===npc.id)?.components.location?.location_id).toBe('market');
    expect(next.entities.some(entity=>entity.components.identity?.name==='普通木尺')).toBe(false);
    expect(next.environment_state?.resolutions).toHaveLength(1);
  });
});
