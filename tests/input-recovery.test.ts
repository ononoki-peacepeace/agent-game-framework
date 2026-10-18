import {describe,it,expect} from 'vitest';
import {awaitInputResult,InputStatusUnknown,InputStillRunning} from '../src/client/input-recovery.js';
import {playerFacingError} from '../src/server/app.js';
import {ProviderError} from '../src/ai/failures.js';

describe('input result recovery',()=>{
  it('delivers a recovered terminal result once even if the original HTTP response arrives later',async()=>{
    let deliver!:(value:{revision:number})=>void;
    const original=new Promise<{revision:number}>(resolve=>{deliver=resolve;});
    const result=await awaitInputResult(original,async()=>({state:'completed',result:{revision:272}}),
      {requestTimeoutMs:0,polls:1});
    deliver({revision:269});await Promise.resolve();
    expect(result.revision).toBe(272);
  });
  it('returns a completed authoritative response after the browser request exceeds its wait budget',async()=>{
    const never=new Promise<{revision:number}>(()=>{});
    const result=await awaitInputResult(never,async()=>({state:'completed',result:{revision:19}}),
      {requestTimeoutMs:0,polls:1});
    expect(result.revision).toBe(19);
  });
  it('surfaces a terminal provider failure without replaying the action',async()=>{
    let statusCalls=0;
    await expect(awaitInputResult(new Promise<never>(()=>{}),async()=>{statusCalls++;
      return {state:'failed' as const,error:'模型服务超时，请确认当前世界状态。'};
    },{requestTimeoutMs:0,polls:1})).rejects.toThrow('模型服务超时');
    expect(statusCalls).toBe(1);
  });
  it('distinguishes an unknown restarted server from a still-running request',async()=>{
    const never=new Promise<never>(()=>{});
    await expect(awaitInputResult(never,async()=>({state:'unknown'}),{requestTimeoutMs:0,polls:1}))
      .rejects.toBeInstanceOf(InputStatusUnknown);
    await expect(awaitInputResult(never,async()=>({state:'running'}),{requestTimeoutMs:0,polls:1}))
      .rejects.toBeInstanceOf(InputStillRunning);
  });
  it('keeps following one request beyond the former polling budget without resending',async()=>{
    let polls=0;
    const result=await awaitInputResult(new Promise<{revision:number}>(()=>{}),async()=>
      ++polls===4?{state:'completed',result:{revision:21}}:{state:'running'},
      {requestTimeoutMs:0,pollMs:0});
    expect(result.revision).toBe(21);
    expect(polls).toBe(4);
  });
  it('continues the same request after the high-frequency polling phase',async()=>{
    let polls=0;
    const result=await awaitInputResult(new Promise<{revision:number}>(()=>{}),async()=>
      ++polls===43?{state:'completed',result:{revision:31}}:{state:'running'},
      {requestTimeoutMs:0,pollMs:0});
    expect(result.revision).toBe(31);
    expect(polls).toBe(43);
  });
  it('recovers after the original connection breaks and status reads briefly fail',async()=>{
    let polls=0;
    const result=await awaitInputResult(Promise.reject(new Error('network disconnected')),
      async()=>{if(++polls===1)throw new Error('temporary offline');
        return {state:'completed',result:{revision:22}};},
      {requestTimeoutMs:0,pollMs:0});
    expect(result.revision).toBe(22);
    expect(polls).toBe(2);
  });
  it('returns control after a bounded recovery window without replaying the request',async()=>{
    let polls=0;
    await expect(awaitInputResult(new Promise<never>(()=>{}),async()=>{polls++;
      return {state:'running' as const};},{requestTimeoutMs:0,pollMs:0,maxRecoveryMs:0}))
      .rejects.toBeInstanceOf(InputStillRunning);
    expect(polls).toBe(0);
  });
  it('gives specific safe feedback for provider limit and timeout failures',()=>{
    expect(playerFacingError(new ProviderError('rate_limit','429','failed'))).toContain('额度');
    expect(playerFacingError(new ProviderError('timeout','AbortError','failed'))).toContain('超时');
    expect(playerFacingError(new Error('Codex quota exceeded'))).toContain('额度');
  });
});
