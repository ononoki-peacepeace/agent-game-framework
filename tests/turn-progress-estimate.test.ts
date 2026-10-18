import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {TurnProgress} from '../src/client/TurnProgress.js';
import {AUTO_DISMISS_MS,estimateTurnProgress,isKnownPhase,isTerminalTurnState,observedPhases,phaseBand,progressBands,TERMINAL_TURN_STATES} from '../src/client/turn-progress.js';

const css=readFileSync(new URL('../src/client/styles.css',import.meta.url),'utf8');

const input=(over:Partial<Parameters<typeof estimateTurnProgress>[0]>={})=>({
  phase:'narrating',state:'running' as const,phaseStartedAt:0,now:0,profile:'world' as const,...over});

describe('estimated turn progress',()=>{
  it('grows smoothly and monotonically inside a stage and never reaches its own ceiling',()=>{
    const band=phaseBand('narrating');
    const samples=[0,500,1500,3000,6000,12000,24000,48000,96000,192000]
      .map(ms=>estimateTurnProgress(input({now:ms})));
    for(let index=1;index<samples.length;index++)expect(samples[index]).toBeGreaterThanOrEqual(samples[index-1]);
    // The curve is decelerating: the first half moves more than the second half.
    expect(samples[3]-samples[0]).toBeGreaterThan(samples[8]-samples[7]);
    // Long after the expectation it parks just below the stage ceiling instead of running away.
    expect(samples.at(-1)!).toBeGreaterThan(band.to-1);
    expect(samples.at(-1)!).toBeLessThan(band.to);
  });

  it('keeps a 30-60s single model stage inside its own budget while still visibly moving',()=>{
    const band=phaseBand('narrating');
    const at30=estimateTurnProgress(input({now:30000}));
    const at60=estimateTurnProgress(input({now:60000}));
    expect(at30).toBeGreaterThan(band.from);
    expect(at60).toBeGreaterThan(at30);
    expect(at60).toBeLessThan(band.to);
  });

  it('is contiguous across real stage changes so the estimate never steps backwards',()=>{
    for(const bands of [progressBands('world'),progressBands('action')]){
      for(let index=1;index<bands.length;index++)expect(bands[index].from).toBe(bands[index-1].to);
      expect(bands.at(-1)!.to).toBe(99);
    }
  });

  it('reaches 100 for a finished request, whether fully completed or partial',()=>{
    expect(estimateTurnProgress(input({state:'completed'}))).toBe(100);
    expect(estimateTurnProgress(input({state:'partial'}))).toBe(100);
    expect(estimateTurnProgress(input({state:'running',now:Number.MAX_SAFE_INTEGER}))).toBeLessThan(100);
  });

  it('keeps the reached estimate when a request fails or is unconfirmed, and finishes a partial',()=>{
    const reached=estimateTurnProgress(input({now:22000}));
    for(const state of ['failed','unknown'] as const){
      const value=estimateTurnProgress(input({state,now:22000}));
      expect(value).toBeLessThan(100);
      expect(value).toBeGreaterThan(0);
      expect(value).toBe(reached);
    }
    expect(estimateTurnProgress(input({state:'partial',now:22000}))).toBe(100);
  });

  it('uses a conservative estimate for a stage it cannot identify',()=>{
    const value=estimateTurnProgress(input({phase:'mystery',now:0}));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(30);
    expect(isKnownPhase('mystery')).toBe(false);
  });

  it('names only stages the server actually reported, in order, without duplicates',()=>{
    expect(observedPhases(['interpreting','planning','mystery','interpreting'],'mystery'))
      .toEqual(['interpreting','planning']);
    expect(observedPhases([],'narrating')).toEqual(['narrating']);
  });

  it('weighs a direct registered action differently from a free-text turn',()=>{
    expect(phaseBand('interpreting','action').from).not.toBe(phaseBand('interpreting','world').from);
    expect(phaseBand('submitted','action').expectedMs).toBeLessThan(phaseBand('submitted','world').expectedMs);
  });

  it('keeps failed and unconfirmed requests below 100 and recognises only terminal states',()=>{
    for(const state of ['failed','unknown'] as const)
      expect(estimateTurnProgress(input({state}))).toBeLessThan(100);
    expect(TERMINAL_TURN_STATES).toEqual(['completed','partial','failed','unknown']);
    for(const state of ['completed','partial','failed','unknown'])
      expect(isTerminalTurnState(state)).toBe(true);
    expect(isTerminalTurnState('running')).toBe(false);
    expect(isTerminalTurnState(undefined)).toBe(false);
    expect(AUTO_DISMISS_MS).toBeGreaterThanOrEqual(2000);
    expect(AUTO_DISMISS_MS).toBeLessThanOrEqual(3000);
  });
});

describe('progress layout',()=>{
  it('anchors the detail panel below the card so the header row can never move',()=>{
    expect(css).toMatch(/\.turn-progress\{position:relative\}/);
    expect(css).toMatch(/\.turn-progress-panel\{[^}]*position:absolute/);
    expect(css).toMatch(/\.turn-progress-panel\{[^}]*top:100%/);
    // The old grow-in-place rule for the docked <details> is neutralised.
    expect(css).toMatch(/details\.turn-progress-details\[open\]\{position:static/);
    // A long list scrolls inside the panel instead of stretching the component.
    expect(css).toMatch(/\.turn-progress-panel\{[^}]*overflow-y:auto/);
    expect(css).toMatch(/\.turn-progress-panel\{[^}]*max-height:/);
  });

  it('renders the collapsed summary with title, percentage, bar and the expand toggle',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',
      state:'running',phase:'resolving',history:['interpreting','planning','resolving'],committedRevision:null}}));
    const shown=Number(/aria-valuenow="(\d+)"/.exec(html)![1]);
    expect(Number.isFinite(shown)).toBe(true);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(html).toContain(`>${shown}%<`);
    expect(html).toContain(`style="width:${shown}%"`);
    expect(html).toContain('展开详情');
    expect(html).toContain('估算进度');
  });

  it('puts the detail list below the toggle row, and swaps the label when expanded',()=>{
    const open=renderToStaticMarkup(createElement(TurnProgress,{defaultOpen:true,value:{requestId:'r',gameId:'g',
      path:'input',state:'running',phase:'narrating',history:['narrating'],committedRevision:null}}));
    expect(open).toContain('收起详情');
    expect(open).toContain('open=""');
    expect(open.indexOf('<summary')).toBeLessThan(open.indexOf('turn-progress-panel'));
  });

  it('never renders an invented stage name',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',
      state:'running',phase:'narrating',history:['interpreting','mystery','narrating'],committedRevision:null}}));
    expect(html).not.toContain('mystery');
    expect(html).toContain('理解输入');
    expect(html).toContain('叙事生成');
  });

  it('renders a committed partial result as finished processing, but still "部分完成"',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',
      state:'partial',phase:'finalizing',history:['interpreting','finalizing'],committedRevision:29}}));
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('部分完成');
    expect(html).not.toContain('已完成');
  });

  it('labels a failed request as 失败 and never presents it as finished',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',
      state:'failed',phase:'resolving',history:['interpreting','resolving'],committedRevision:null}}));
    expect(html).toContain('失败');
    expect(html).not.toContain('aria-valuenow="100"');
    expect(html).not.toContain('已完成');
  });

  it('labels an unconfirmed request as 结果待确认 and keeps it below 100',()=>{
    const html=renderToStaticMarkup(createElement(TurnProgress,{value:{requestId:'r',gameId:'g',path:'input',
      state:'unknown',phase:'narrating',history:['interpreting','narrating'],committedRevision:null}}));
    expect(html).toContain('结果待确认');
    expect(html).not.toContain('aria-valuenow="100"');
  });
});
