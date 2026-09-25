import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LauncherToolbar} from '../src/client/LauncherToolbar.js';
import {WorldLauncher} from '../src/client/WorldLauncher.js';

it('the launcher gives all four primary entries equal cards',()=>{
  const html=renderToStaticMarkup(createElement(LauncherToolbar,{engineLabel:'DeepSeek',busy:false,current:{title:'银枝学院',location:'正门',revision:12},onContinue:()=>{},onImportSave:()=>{},onOpenProvider:()=>{}},createElement('div',null,'creation layer')));
  for(const label of ['当前世界','创建新世界','读取存档','模型 / API'])expect(html).toContain(label);
  expect(html.match(/<article/g)).toHaveLength(4);
  expect(html).toContain('银枝学院');expect(html).toContain('正门');expect(html).toContain('第 12 回合');expect(html).toContain('DeepSeek');
  expect(html).not.toContain('creation layer');
  const busyHtml=renderToStaticMarkup(createElement(LauncherToolbar,{busy:true,onImportSave:()=>{},onOpenProvider:()=>{}}));
  expect(busyHtml).toContain('读取存档');
});

it('no feature entry is hidden with CSS, and the legacy cards are gone',async()=>{
  const css=await readFile('src/client/world.css','utf8');
  expect(css).not.toMatch(/launch-card:not/);
  const app=await readFile('src/client/App.tsx','utf8');
  expect(app).not.toContain('IMPORT</small>');
  expect(app).not.toContain('provider-card');
  expect(app).toContain('<LauncherToolbar');
  expect(app).toContain('<WorldLauncher');
  expect(app).toContain('onImportSave={()=>jsonRef.current?.click()}');
  expect(app).toContain('onOpenProvider={()=>setProviderOpen(true)}');
});

it('the creation home keeps only the three creation entries',()=>{
  const html=renderToStaticMarkup(createElement(WorldLauncher,{busy:false,onCreated:()=>{},onCustom:()=>{}}));
  expect(html).toContain('从模板开始');
  expect(html).toContain('让 AI 帮我想');
  expect(html).toContain('自己创建');
  expect(html).not.toContain('读取存档');
  expect(html).not.toContain('世界灵感');
  expect(html).not.toContain('template-card');
});
