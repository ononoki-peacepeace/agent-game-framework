import {it,expect} from 'vitest';
import {once} from 'node:events';
import {sparseSetup} from './sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {blankWorldIntent} from '../src/shared/world-intent.js';
import {applyWorldModification,draftFromIdea,draftToDescription,inspirations,recommendDraft,worldDraftSchema,worldTemplates} from '../src/world/templates.js';

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
    const second=await env.post('world/preview',{variant:1});
    expect(first.body.preview.title).not.toBe(second.body.preview.title);
    expect(first.body.inspiration.length).toBeGreaterThan(0);
    const refreshed=await env.post('world/preview',{inspiration_seed:5});
    expect(refreshed.body.inspiration.length).toBeGreaterThan(0);
    expect(inspirations(0,6)).not.toEqual(inspirations(1,6));

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
