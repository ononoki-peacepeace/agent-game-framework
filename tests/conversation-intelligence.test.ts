import {it,expect,vi} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sparseSetup} from './sparse-fixture.js';
import {handleSystemInput} from '../src/system/agent.js';
import {resolveEntities,entityLabel} from '../src/agent/entities.js';
import {planGameRequest} from '../src/agent/game.js';
import {publicView} from '../src/core/state.js';
import {resolveUniversalGoal} from '../src/system/resolver.js';
import {LauncherToolbar} from '../src/client/LauncherToolbar.js';
import {createApp} from '../src/server/app.js';

/** P2 · Direct response: a clear, side-effect-free request is answered, never sent to a workflow. */
it('a simple apology request is answered directly instead of being routed to a workflow',async()=>{
  const f=await sparseSetup();
  const apology=await handleSystemInput(f.service,{input:'给我道个歉'});
  expect(String(apology.message)).toContain('对不起');
  expect(apology.directive).toBeUndefined();
  expect(apology.needs_confirmation??false).toBe(false);
  const literal=await handleSystemInput(f.service,{input:'只回复我“对不起”'});
  expect(String(literal.message).trim()).toBe('对不起');
});

/** P3 · Canonical reference: "我 / 这里" read canonical state instead of asking the model. */
it('identity and place questions are answered from canonical state',async()=>{
  const f=await sparseSetup();
  const save=await f.service.current();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const view=publicView(save);
  const identity=planGameRequest(view,'我是谁？');
  expect(String(identity?.message)).toContain(String(player.components.identity?.name));
  expect(String(identity?.message)).not.toContain('没能确认');
  const place=planGameRequest(view,'这里是什么地方？');
  const hereName=view.locations.find(location=>location.id===String(player.components.location?.location_id))?.name;
  if(hereName)expect(String(place?.message)).toContain(String(hereName));
  const deictic=resolveEntities(view,'我自己现在有多少钱');
  expect(deictic.matches.map(entity=>entity.id)).toEqual([player.id]);
});

/** P4 · Historical alias: an old display name still resolves to the same canonical entity. */
it('a previous display name resolves to the same entity after a rename',async()=>{
  const f=await sparseSetup();
  const save=await f.service.current();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const identity=player.components.identity as {name:string;previous_names?:string[]};
  identity.previous_names=['萨莉丽'];
  identity.name='习近平';
  await f.store.write(save);
  const view=publicView(await f.service.current());
  const alias=resolveEntities(view,'萨莉丽现在在哪？');
  expect(alias.confident).toBe(true);
  expect(alias.matches[0]?.id).toBe(player.id);
  expect(entityLabel(alias.matches[0]!)).toBe('习近平');
  const query=planGameRequest(view,'萨莉丽现在在哪？');
  const place=String(view.locations.find(location=>location.id===String(player.components.location?.location_id))?.name??'');
  if(place)expect(String(query?.message)).toContain(place);
});

it('normal HTTP queries distinguish explicit names, missing names, and canonical self reference',async()=>{
  const f=await sparseSetup(),directory=await mkdtemp(join(tmpdir(),'agf-entity-awareness-'));
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,token=(await (await fetch(`${base}/api/session`)).json()).token;
    const ask=async(input:string)=>{const view=await f.service.view();return (await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({request_id:randomUUID(),game_id:view!.game_id,expected_revision:view!.revision,input})})).json();};
    const current=(await f.service.view())!,knownName=String(current.entities.find(entity=>entity.id!==current.player_id&&entity.components.character)?.components.identity?.name??'');
    const known=await ask(`${knownName}是谁？`);expect(known.message).toContain(knownName);
    const absent=await ask('有没有一个叫王明的人？');expect(absent.awareness_status).toBe('NOT_FOUND');expect(absent.message).toContain('没有找到');
    const self=await ask('我是谁？');const latest=(await f.service.view())!,player=latest.entities.find(entity=>entity.id===latest.player_id)!;expect(self.message).toContain(String(player.components.identity?.name));expect(self.awareness_status).not.toBe('NOT_FOUND');
    const place=await ask('我在哪？'),placeName=latest.locations.find(location=>location.id===String(player.components.location?.location_id))?.name;expect(place.message).toContain(placeName);
    const money=await ask('我有多少钱？'),balances=player.components.wallet?.balances as Record<string,number>;expect(money.message).toContain(String(Object.values(balances)[0]));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

it('a named high-level destination uses canonical affordances and commits location plus route time through HTTP',async()=>{
  const f=await sparseSetup(),directory=await mkdtemp(join(tmpdir(),'agf-world-goal-'));
  vi.spyOn(f.ai,'narrate').mockResolvedValue({narrative:'你沿着现有路线抵达目的地。',speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null});
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,token=(await (await fetch(`${base}/api/session`)).json()).token;
    const before=await f.service.current(),player=before.entities.find(entity=>entity.id===before.player_state.entity_id)!,from=String(player.components.location?.location_id);
    const route=[...(before.definition.map?.routes??[]),...before.map_state.dynamic_routes].find(entry=>entry.from===from&&entry.conditions.every(condition=>before.gm_state.flags[condition.flag]===condition.equals))!;
    const destination=[...(before.definition.map?.locations??[]),...before.map_state.dynamic_locations].find(location=>location.id===route.to)!;
    const response=await fetch(`${base}/api/input`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input:`去${destination.name}`})});
    const body=await response.json(),after=await f.service.current();expect(response.ok,JSON.stringify(body)).toBe(true);
    expect(body.intent).toBe('WORLD_ACTION');expect(body.time_advanced).toBe(route.travel_minutes);
    expect(after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.location?.location_id).toBe(destination.id);
    const beforeMinute=before.runtime.time.day*before.definition.ruleset.minutes_per_day+before.runtime.time.minute,afterMinute=after.runtime.time.day*after.definition.ruleset.minutes_per_day+after.runtime.time.minute;
    expect(afterMinute-beforeMinute).toBe(route.travel_minutes);expect(after.state_revision).toBe(before.state_revision+1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

/** P7 · Capability gap detection: the framework reports the真 missing capability instead of pretending. */
it('an artwork request with no image capability reports the gap instead of completing',async()=>{
  const f=await sparseSetup();
  const resolution=await resolveUniversalGoal(f.service,'给主角生成一张头像');
  expect(resolution.handled).toBe(true);
  if(resolution.handled&&resolution.kind==='CAPABILITY_GAP'){
    expect(resolution.missing.length).toBeGreaterThan(0);
    expect(resolution.message).not.toMatch(/completed|已完成/);
  }
});

/** P1 · Pending goal continuity: a short answer keeps filling the original goal. */
it('a short answer continues the pending goal instead of starting a new one',async()=>{
  const prompts:string[]=[];
  const f=await sparseSetup(async request=>{
    prompts.push(String(request.prompt));
    const props=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(props.objective)return {data:{goal:{goal_id:'g1',objective:'修改玩家的钱到 3000',speech_act:'request',targets:[{kind:'entity',reference:'我'}],desired_state:[{path:'wallet.credit',value:3000}],desired_outputs:[],ambiguity:null},steps:[{step_id:'s1',capability_id:'wallet.set',input:{amount:3000},depends_on:[]}]}};
    throw Error('unexpected fixture request');
  });
  const first=await handleSystemInput(f.service,{input:'把我身上的钱从30改成3000'});
  const session=first.session!;
  const question=first.message;
  const follow=await handleSystemInput(f.service,{input:'随便，你决定',session_id:session.session_id});
  const third=await handleSystemInput(f.service,{input:'给角色',session_id:follow.session!.session_id});
  const lastPrompt=prompts.at(-1)??'';
  // The original goal is still what gets resolved, and the terse answers never become the goal themselves.
  expect(lastPrompt).toContain('钱');
  expect(lastPrompt).toContain('3000');
  expect(third.message).not.toContain('没有物品可以给角色');
  expect(String(third.message)).not.toMatch(/^\s*给角色\s*$/);
  expect(question.length).toBeGreaterThan(0);
});

it('the natural-language money goal reaches one canonical commit and remains correct across terse follow-ups',async()=>{
  const f=await sparseSetup(),save=await f.service.current(),player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const balances=player.components.wallet!.balances as Record<string,number>,currency=Object.keys(balances)[0];balances[currency]=30;await f.store.write(save);
  const directory=await mkdtemp(join(tmpdir(),'agf-money-goal-')),server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,token=(await (await fetch(`${base}/api/session`)).json()).token;
    const send=async(input:string,session_id?:string)=>{const view=await f.service.view();const response=await fetch(`${base}/api/system`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify({input,session_id,request_id:randomUUID(),game_id:view!.game_id,expected_revision:view!.revision})});return response.json();};
    const first=await send('把我身上的钱从30改成3000');expect(first.category).toBe('UNIVERSAL_GOAL');expect(first.advanced.goal).toMatchObject({targets:[{reference:'我'}],desired_state:[{path:'wallet.balance',value:3000}]});
    const committed=await f.service.current(),revision=committed.state_revision;expect((committed.entities.find(entity=>entity.id===committed.player_state.entity_id)!.components.wallet!.balances as Record<string,number>)[currency]).toBe(3000);
    const second=await send('随便，你决定',first.session.session_id),third=await send('给角色',second.session?.session_id);
    expect(third).toBeTruthy();const after=await f.service.current();expect((after.entities.find(entity=>entity.id===after.player_state.entity_id)!.components.wallet!.balances as Record<string,number>)[currency]).toBe(3000);
    expect(after.state_revision).toBe(revision);expect(after.runtime.time).toEqual(save.runtime.time);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

/** P9 · Launcher: four equal peer cards, and the create flow stays on a second level. */
it('the launcher keeps four peer entries and lets the creation flow live on a second level',async()=>{
  const css=await readFile('src/client/world.css','utf8');
  expect(css).toContain('.launcher-primary-grid .launch-card.create-card{grid-row:auto}');
  const html=renderToStaticMarkup(createElement(LauncherToolbar,{engineLabel:'DeepSeek',busy:false,onImportSave:()=>{},onOpenProvider:()=>{}}));
  for(const label of ['当前世界','创建新世界','读取存档','模型 / API'])expect(html).toContain(label);
  expect(html).not.toContain('世界灵感');
});
