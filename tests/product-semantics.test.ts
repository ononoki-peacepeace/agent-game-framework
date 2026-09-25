import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RoutinePlanPanel} from '../src/client/RoutinePlanPanel.js';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {cropGeometry} from '../src/client/AvatarCropEditor.js';
const envelope=async(service:any,action:unknown)=>{const s=await service.current();return {game_id:s.game_id,expected_revision:s.state_revision,request_id:randomUUID(),action};};
it('saving and clearing a plan preserve time, foreground choices and event RNG; no AI calls',async()=>{
 const {service,store,calls}=await sparseSetup();const before=await service.current();before.last_turn={narrative:'请选路线',speaker:null,dialogue:null,choices:['左','右'],context_actions:[]};await store.write(before);
 await service.turn(await envelope(service,{type:'SAVE_ROUTINE',parameters:{label:'日常',pattern:'每天正常上课'}}));let after=await service.current();
 expect(after.runtime.time).toEqual(before.runtime.time);expect(after.last_turn).toEqual(before.last_turn);expect(after.event_state).toEqual(before.event_state);expect(calls).toHaveLength(0);
 expect((await service.handoffBlocker())?.reason).toContain('选择');await service.turn(await envelope(service,{type:'CLEAR_ROUTINE',parameters:{}}));expect((await service.current()).runtime.time).toEqual(before.runtime.time);
});
it('empty plan hides stale failure; task cards preserve morning/half-day semantics without completion controls',async()=>{
 const {service}=await sparseSetup(),s=await service.current();s.routine_meta!.scheduled_tasks=[{id:'visit',label:'志愿安排',at:1920,window:'morning',duration_label:'约半天',status:'accepted',resolved:false,source:'test'}];
 const html=renderToStaticMarkup(createElement(RoutinePlanPanel,{view:publicView(s),act:()=>{},busy:false,routineJob:{status:'failed',last_revision:0,message:'请先设置生活模式'} as any}));
 expect(html).toContain('生活计划：未设置');expect(html).not.toContain('处理失败');expect(html).toContain('上午');expect(html).toContain('约半天');expect(html).not.toContain('07:59');expect(html).not.toContain('这件事已经做完了');expect(html).not.toContain('取消这项安排');
 await expect(service.acknowledgeTask('visit',s.game_id,s.state_revision)).rejects.toThrow('不能手工');
});
it('task completion requires authored action, time and location evidence',async()=>{
 const {service}=await sparseSetup();const s=await service.current();s.definition.enabled_modules.push('quests');s.module_versions.quests='0.1.0';const p=s.entities.find(e=>e.id===s.player_state.entity_id)!;p.components.quests={entries:{visit:{title:'接待',status:'accepted',summary:'接待学生',objectives:[],deadline:null,tags:[],metadata:{}}}};
 s.definition.task_rules=[{task_id:'visit',book:'quests',location_id:'square',start_at:1440,end_at:1500,steps:[{action:'WAIT',target_id:null,minimum_minutes:5}]}];p.components.location.location_id='station';
 let out=executeAction(s,{type:'WAIT',parameters:{minutes:5}},randomUUID()).save;expect((out.entities.find(e=>e.id===p.id)!.components.quests.entries as any).visit.status).toBe('accepted');
 out.entities.find(e=>e.id===p.id)!.components.location.location_id='square';out=executeAction(out,{type:'WAIT',parameters:{minutes:5}},randomUUID()).save;expect((out.entities.find(e=>e.id===p.id)!.components.quests.entries as any).visit.status).toBe('completed');
});
it('foreground blockers and NPC reply prevent handoff even without routine interrupt',async()=>{
 const {service,store}=await sparseSetup(),s=await service.current();s.foreground={blocker:'travel',reason:'行程尚未结束'};await store.write(s);expect((await service.handoffBlocker())?.reason).toContain('行程');
 delete s.foreground;s.last_turn={narrative:'有人提问',speaker:'npc_lin',dialogue:'你愿意帮忙吗？',choices:[],context_actions:[]};await store.write(s);expect((await service.handoffBlocker())?.reason).toContain('答复');
});
it('crop parameters persist without replacing source fullbody; geometry allows near-face crop',async()=>{
 const {service}=await sparseSetup();const s=await service.current();await service.setVisualAsset('npc_lin','fullbody','visual_source',s.game_id);const crop={crop_version:1 as const,source_asset_id:'visual_source',scale:12,offset_x:0,offset_y:4};
 await service.setAvatar('npc_lin','avatar_derived',s.game_id,0,crop);const after=await service.current(),v=after.entities.find(e=>e.id==='npc_lin')!.components.visual_assets;expect((v.images as any).fullbody).toBe('visual_source');expect(v.avatar_crop).toEqual(crop);expect(cropGeometry(1024,1536,crop).side).toBeLessThan(100);
});
