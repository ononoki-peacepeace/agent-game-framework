import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {historyRestoreConfirmation,WorldHistory} from '../src/client/WorldHistory.js';
import type {PublicView} from '../src/shared/contracts.js';

const view={world_history:[
  {turn_id:'11111111-1111-4111-8111-111111111111',label:'抵达正门',time:{day:1,minute:540},current:false},
  {turn_id:'22222222-2222-4222-8222-222222222222',label:'进入学院',time:{day:1,minute:545},current:true},
]} as PublicView;

describe('world history UI',()=>{
  it('offers the bounded history control and keeps destructive restore copy explicit',()=>{
    const html=renderToStaticMarkup(createElement(WorldHistory,{view,busy:false,onRestore:()=>{}}));
    expect(html).toContain('历史 / 回溯');
    expect(html).toContain('aria-expanded="false"');
    expect(historyRestoreConfirmation).toContain('之后发生的世界状态将不再作为当前历史');
  });
  it('does not render a history control before the first world turn',()=>{
    expect(renderToStaticMarkup(createElement(WorldHistory,{view:{...view,world_history:[]},busy:false,onRestore:()=>{}}))).toBe('');
  });
});
