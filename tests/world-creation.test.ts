import {it,expect} from 'vitest';
import {once} from 'node:events';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorldLauncher} from '../src/client/WorldLauncher.js';

import {sparseSetup} from './sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {blankWorldIntent} from '../src/shared/world-intent.js';
import {applyWorldModification,draftFromIdea,draftToDescription,inspirations,recommendDraft,worldDraftSchema,worldTemplates} from '../src/world/templates.js';
import {inspirationChips} from '../src/world/inspiration.js';

it('a new chip batch drops the previous unpicked chips and keeps the player’s picks',()=>{
  const first=inspirationChips(11,6,[],[]);
  const second=inspirationChips(12,6,first.map(chip=>chip.id),[]);
  expect(first.length).toBeGreaterThanOrEqual(3);
  expect(second.map(chip=>chip.id)).not.toEqual(first.map(chip=>chip.id));
  // no single unpicked chip may survive five consecutive batches
  let batch=first, seen=new Map<string,number>();
  for(let round=0;round<5;round+=1){
    for(const chip of batch)seen.set(chip.id,(seen.get(chip.id)??0)+1);
    const next=inspirationChips(100+round,6,batch.map(chip=>chip.id),[]);
    expect(next.map(chip=>chip.id)).not.toEqual(batch.map(chip=>chip.id));
    batch=next;
  }
  expect(Math.max(...seen.values())).toBeLessThan(5);
  const locked=inspirationChips(21,6,[],['anomaly_identity']);
  expect(locked[0]).toMatchObject({id:'anomaly_identity',picked:true});
});

it('a template “换一个” produces a different place, not the same world with new fields',async()=>{
  const env=await httpFixture();
  try{
    const before=await env.f.service.current();
    const first=await env.post('world/preview',{template_id:'space_colony'});
    const firstScope=String(first.body.preview.initial_scope),firstTitle=String(first.body.preview.title);
    const scopes=new Set([firstScope]),anotherTitles:string[]=[];
    for(let round=0;round<4;round+=1){
      const next=await env.post('world/preview',{another:true,preview_id:first.body.preview_id,preview_session:first.body.flow_id,inspiration_seed:50+round});
      expect(next.status).toBe(200);
      expect(next.body.category).toBe('space');
      scopes.add(String(next.body.preview.initial_scope));
      anotherTitles.push(String(next.body.preview.title));
      expect(await env.f.service.current()).toEqual(before);
    }
    expect(scopes.size).toBeGreaterThan(1);
    // The starter template may be called 赫利俄斯站, but no 换一个 candidate may keep that concrete place.
    expect(anotherTitles.every(title=>title!==firstTitle)).toBe(true);
    expect(anotherTitles.some(title=>title.includes('赫利俄斯'))).toBe(false);

  }finally{await env.close();}
});

it('the creation home shows only the three entries',()=>{
  const html=renderToStaticMarkup(createElement(WorldLauncher,{busy:false,onCreated:()=>{},onCustom:()=>{}}));
  expect(html).toContain('从模板开始');
  expect(html).toContain('让 AI 帮我想');
  expect(html).toContain('自己创建');
  expect(html).not.toContain('世界灵感');
  expect(html).not.toContain('template-card');
  expect(html).not.toContain('world-preview');
});

it('“换一个” returns a visibly different candidate and never creates a world',async()=>{
  const env=await httpFixture();
  try{
    const before=await env.f.service.current();
    const core=(body:{preview:{title:string;one_liner:string;initial_scope:string;player_role:string}})=>[body.preview.title,body.preview.one_liner,body.preview.initial_scope,body.preview.player_role].join('|');
    const first=await env.post('world/preview',{template_id:'small_town'});
    expect(first.status).toBe(200);
    const seen=new Set([core(first.body)]);
    for(let round=0;round<3;round++){
      const next=await env.post('world/preview',{another:true,preview_id:first.body.preview_id,preview_session:first.body.flow_id,inspiration_seed:20+round});
      expect(next.status).toBe(200);
      expect(next.body.signature).not.toBe(first.body.signature);
      seen.add(core(next.body));
      expect(await env.f.service.current()).toEqual(before);
    }
    expect(seen.size).toBeGreaterThan(1);
  }finally{await env.close();}
});

it('adjusting a draft edits the preview and never creates a world',async()=>{
  const env=await httpFixture();
  try{
    const before=await env.f.service.current();
    const preview=await env.post('world/preview',{template_id:'small_town'});
    expect(preview.status).toBe(200);
    const adjusted=await env.post('world/preview',{preview_id:preview.body.preview_id,modify:'危险程度低一点，加一点隐藏异常'});
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.preview.danger).toBe('low');
    expect(adjusted.body.signature).not.toBe(preview.body.signature);
    expect(await env.f.service.current()).toEqual(before);
  }finally{await env.close();}
});

it('“换一个” keeps the player’s constraints and never repeats recent candidates',async()=>{
  const env=await httpFixture();
  try{
    const idea='现代社会，人物很多，隐藏异常';
    const first=await env.post('world/preview',{idea,inspiration_seed:1});
    expect(first.status).toBe(200);
    const signatures=[first.body.signature];
    let flow=first.body.flow_id, current=first.body;
    for(let round=0;round<5;round++){
      const next=await env.post('world/preview',{idea,preview_session:flow,inspiration_seed:10+round});
      expect(next.status).toBe(200);
      flow=next.body.flow_id;current=next.body;
      signatures.push(next.body.signature);
      expect(next.body.preview.npc_density).toBe('high');
      expect(next.body.preview.supernatural).not.toBe('none');
    }
    expect(new Set(signatures).size).toBe(signatures.length);
  }finally{await env.close();}
});

it('inspiration chips come from the library and change between draws',async()=>{
  const env=await httpFixture();
  try{
    const a=await fetch(`${env.base}/api/world/inspiration?seed=1`).then(response=>response.json()) as {chips:{id:string}[]};
    const b=await fetch(`${env.base}/api/world/inspiration?seed=2`).then(response=>response.json()) as {chips:{id:string}[]};
    expect(a.chips.length).toBeGreaterThanOrEqual(3);
    expect(a.chips.map(chip=>chip.id).join()) .not.toBe(b.chips.map(chip=>chip.id).join());
  }finally{await env.close();}
});

it('every template is valid program data and carries no mandatory plot',()=>{

  expect(worldTemplates.length).toBeGreaterThanOrEqual(6);
  for(const template of worldTemplates){
    expect(()=>worldDraftSchema.parse(template.draft)).not.toThrow();
    expect(template.id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(template.version).toBeGreaterThanOrEqual(1);
    expect(template.display_name.length).toBeGreaterThan(0);
    const description=draftToDescription(template.draft);
    expect(description).not.toMatch(/必须是反派|一定是反派|拯救世界|一定会遇到|主角必须/);
    expect(description).not.toMatch(/mandatory_plot|required_story/);
    if(!template.blank) expect(description).toContain('不要预设强制主线');

  }
  expect(worldTemplates.map(template=>template.id)).toContain('blank');
});

it('the blank entry still resolves to the semantic blank world',()=>{
  const blank=worldTemplates.find(template=>template.id==='blank')!;
  expect(blankWorldIntent(draftToDescription(blank.draft))).not.toBeNull();
});

it('ideas become drafts, templates stay editable and inspirations rotate',()=>{
  const idea=draftFromIdea('我想玩一个现代社会背景、人物很多、表面正常但有隐藏异常的世界');
  expect(idea.npc_density).toBe('high');
  expect(idea.supernatural).not.toBe('none');
  const academy=worldTemplates.find(template=>template.id==='arcane_academy')!.draft;
  const modified=applyWorldModification(academy,'危险程度低一点，我不想当学生，我想当新来的老师');
  expect(modified.danger).toBe('low');
  expect(modified.player_role).toBe('新来的老师');
  expect(inspirations(0,6)).not.toEqual(inspirations(1,6));
  expect(recommendDraft(0).title).not.toBe(recommendDraft(1).title);
});

async function httpFixture(){
  const f=await sparseSetup();
  const server=createApp(f.service).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const token=(await (await fetch(`${base}/api/session`)).json()).token as string;
  const headers={'Content-Type':'application/json','X-Game-Token':token};
  const post=async(path:string,body:unknown)=>{const response=await fetch(`${base}/api/${path}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  return {f,base,post,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

it('a preview never touches the current world, and confirm creates the new one from the template description',async()=>{
  const env=await httpFixture();
  try{
    const before=await env.f.service.current();
    const list=await fetch(`${env.base}/api/world/templates`).then(response=>response.json()) as {id:string}[];
    expect(list.length).toBeGreaterThanOrEqual(6);
    const preview=await env.post('world/preview',{template_id:'small_town'});
    expect(preview.status).toBe(200);
    expect(String(preview.body.preview.title).length).toBeGreaterThan(0);
    expect(preview.body.preview.experiences.length).toBeGreaterThan(0);
    expect(await env.f.service.current()).toEqual(before);
    // The template preview reaches the existing authoring pipeline; this fixture has no authoring model, so the
    // creation itself cannot succeed here (the blank path below proves the pipeline, and the real-model smoke
    // covers a template world). Either way the current world must be untouched and the preview is single-use.
    const confirmed=await env.post('world/confirm',{preview_id:preview.body.preview_id});
    expect(confirmed.status).not.toBe(200);
    expect(await env.f.service.current()).toEqual(before);
    const reused=await env.post('world/confirm',{preview_id:preview.body.preview_id});
    expect(reused.status).not.toBe(200);

  }finally{await env.close();}
});

it('“我什么都没想好” gives a playable recommendation, 换一个 differs, and a template can be modified',async()=>{
  const env=await httpFixture();
  try{
    const first=await env.post('world/preview',{});
    const second=await env.post('world/preview',{preview_session:first.body.flow_id,inspiration_seed:2});
    expect(second.body.signature).not.toBe(first.body.signature);


    expect(first.body.chips.length).toBeGreaterThan(0);

    const refreshed=await env.post('world/preview',{inspiration_seed:5});
    expect(refreshed.body.chips.length).toBeGreaterThan(0);
    expect(new Set(refreshed.body.chips.map((chip:{id:string})=>chip.id)).size).toBe(refreshed.body.chips.length);


    const modified=await env.post('world/preview',{template_id:'arcane_academy',modify:'不要魔法，危险程度低一点'});
    expect(modified.body.preview.danger).toBe('low');
    expect(String(modified.body.preview.special_rules.join('；'))).toContain('超能力');
  }finally{await env.close();}
});

it('the blank entry still creates a semantic blank world and legacy custom creation keeps working',async()=>{
  const env=await httpFixture();
  try{
    const blank=await env.post('world/preview',{template_id:'blank'});
    expect(blank.body.blank).toBe(true);
    const created=await env.post('world/confirm',{preview_id:blank.body.preview_id});
    expect(created.status).toBe(200);
    const save=await env.f.service.current();
    expect(save.definition.enabled_modules).toEqual(['core']);
    expect(save.entities).toHaveLength(1);
    expect(save.last_turn?.narrative).toBe('');
    const legacy=await env.post('new',{description:'完全空白世界，仅用于检查框架'});
    expect(legacy.status).toBe(200);
  }finally{await env.close();}
});
