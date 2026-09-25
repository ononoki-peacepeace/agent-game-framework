import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/client/api.js';
import { initialSystemInput, submitFailed, submitStarted } from '../src/client/system-input.js';
import { loadDevelopmentWorkspace, saveDevelopmentDraft } from '../src/client/development-workspace.js';

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;vi.restoreAllMocks();});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

describe('request reliability boundary',()=>{
  it('retries a transient read once and returns the successful result',async()=>{
    const fetchMock=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json({ok:true}));
    globalThis.fetch=fetchMock as typeof fetch;
    await expect(request<{ok:boolean}>('state')).resolves.toEqual({ok:true});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds failed reads and never exposes raw fetch errors',async()=>{
    const fetchMock=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    globalThis.fetch=fetchMock as typeof fetch;
    await expect(request('state')).rejects.toThrow('这次请求没有成功完成');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    try{await request('state');}catch(error){expect(String((error as Error).message)).not.toMatch(/Failed to fetch|TypeError/);}
  });

  it('never automatically replays a write whose response may have been lost',async()=>{
    const bodies:string[]=[];
    globalThis.fetch=vi.fn(async(_url,init)=>{bodies.push(String(init?.body));throw new TypeError('socket hang up');}) as typeof fetch;
    const body={request_id:'2539b635-9ee8-4d8d-bb33-fbf46689f590',game_id:'game',expected_revision:1,input:'改名'};
    await expect(request('system',body)).rejects.toThrow('当前状态没有被修改');
    expect(bodies).toEqual([JSON.stringify(body)]);
  });

  it('sanitizes raw server failures while preserving safe product errors',async()=>{
    globalThis.fetch=vi.fn().mockResolvedValueOnce(json({error:'HTTP 500 TypeError: socket hang up'},500)).mockResolvedValueOnce(json({error:'状态已更新，请刷新后重试'},409)) as typeof fetch;
    await expect(request('system',{})).rejects.toThrow('请求没有完成');
    await expect(request('system',{})).rejects.toThrow('状态已更新，请刷新后重试');
  });

  it('keeps typed System input and workspace draft after an execution failure',()=>{
    const typed=submitStarted(initialSystemInput,'尚未提交的详细要求'),failed=submitFailed(typed,'这次请求没有成功完成');
    expect(failed.value).toBe('尚未提交的详细要求');
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    saveDevelopmentDraft('game','task','五百字草稿',storage);
    expect(loadDevelopmentWorkspace('game',storage).drafts.task).toBe('五百字草稿');
  });
});

