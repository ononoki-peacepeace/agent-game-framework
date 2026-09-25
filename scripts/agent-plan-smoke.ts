import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {createApp} from '../src/server/app.js';
const directory=resolve('.tmp/agent-plan-acceptance-'+Date.now());await mkdir(directory,{recursive:true});
const {service,store,calls}=await sparseSetup(),save=await service.current();
const player=save.entities.find(e=>e.id===save.player_state.entity_id)!,npc=save.entities.find(e=>e.id!==player.id&&e.components.character)!;
npc.components.identity.name='伊芙琳';npc.components.character.role='熟悉的学习伙伴和朋友';npc.components.location=structuredClone(player.components.location);npc.components.visual_assets={images:{fullbody:'evelyn_body'}};
player.components.wallet={balances:{credit:356}};player.components.relationships={entries:{[npc.id]:{familiarity:50,trust:25}}};save.last_turn={narrative:'验收场景',speaker:null,dialogue:null,choices:[],context_actions:[]};await store.write(save);
const server=createApp(service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
try{
 const token=(await(await fetch(base+'/api/session')).json()).token;
 async function post(path:string,body:unknown){const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}
 async function input(text:string){const current=await service.current();return post('input',{input:text,game_id:current.game_id,expected_revision:current.state_revision,request_id:randomUUID()});}
 const A=await input('我忘了我现在有多少钱了，而且我想知道我跟伊芙琳是什么关系。如果我们已经是比较熟的朋友，那我明天打算约她出去逛逛。');
 const B=await input('如果我和伊芙琳已经比较熟，明天放学后约她出去；如果还不够熟，就找她一起训练。');
 const C1=await post('system',{input:'我想改一个人物头像。'}),C2=await post('system',{input:'伊芙琳。',session_id:C1.session.session_id});
 const after=await service.current();assert.equal(A.time_advanced,0);assert.equal(B.time_advanced,0);assert.match(A.message,/356/);assert.equal(A.future_intents.length,1);assert.equal(B.future_intents[0].time_window,'after_school');assert.equal(C1.session.status,'waiting_for_clarification');assert.equal(C1.session.session_id,C2.session.session_id);assert.equal(C2.directive.kind,'open_crop_editor');
 assert.deepEqual(after.runtime.time,save.runtime.time);assert.deepEqual(after.last_turn,save.last_turn);assert.deepEqual(after.entities,save.entities);assert.deepEqual(after.event_state,save.event_state);assert.equal(calls.length,0);
 await writeFile(join(directory,'results.json'),JSON.stringify({passed:true,mode:'isolated HTTP + deterministic planner',A,B,C:[C1,C2],checks:{time_advanced:0,npc_interaction:false,world_scene_unchanged:true,event_rng_unchanged:true,maximum_navigation:Math.max(...[A,B].map(r=>r.ui_actions.filter((x:any)=>['open_panel','open_character_detail'].includes(x.kind)).length)),ai_calls:0}},null,2));
 console.log(JSON.stringify({passed:true,directory,A:A.message,B:B.message,C:[C1.message,C2.message]},null,2));
}finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
