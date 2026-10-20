import {afterEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {listenFetchable} from './fixtures/listen-fetchable.js';

const servers:Server[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const server of servers.splice(0))if(server.listening)
    await new Promise<void>(resolve=>server.close(()=>resolve()));
});

it('discards a Fetch-blocked allocation before requests and serves exactly once on a fresh listener',async()=>{
  let allocations=0,requests=0;
  const server=await listenFetchable(()=>{
    const candidate=createServer((_req,res)=>{requests++;res.end('ok');});servers.push(candidate);
    if(allocations++===0)vi.spyOn(candidate,'address').mockReturnValue({address:'127.0.0.1',family:'IPv4',port:10080});
    return candidate;
  });
  expect(allocations).toBeGreaterThanOrEqual(2);expect(allocations).toBeLessThanOrEqual(8);
  expect(servers.slice(0,-1).every(candidate=>!candidate.listening)).toBe(true);expect(requests).toBe(0);
  const address=server.address();if(!address||typeof address==='string')throw Error('Missing loopback address');
  expect(await (await fetch(`http://127.0.0.1:${address.port}/`)).text()).toBe('ok');expect(requests).toBe(1);
});

it('bounds repeated unsuitable allocations and closes every discarded listener',async()=>{
  await expect(listenFetchable(()=>{
    const candidate=createServer();servers.push(candidate);
    vi.spyOn(candidate,'address').mockReturnValue({address:'127.0.0.1',family:'IPv4',port:10080});return candidate;
  })).rejects.toThrow('after 8 listener allocations');
  expect(servers).toHaveLength(8);expect(servers.every(server=>!server.listening)).toBe(true);
});

it('propagates a bind failure without retrying it or sending requests',async()=>{
  let allocations=0;
  await expect(listenFetchable(()=>{
    allocations++;const candidate=createServer();servers.push(candidate);
    vi.spyOn(candidate,'listen').mockImplementation((..._args:unknown[])=>{
      queueMicrotask(()=>candidate.emit('error',new Error('fixture bind denied')));return candidate;
    });return candidate;
  })).rejects.toThrow('fixture bind denied');
  expect(allocations).toBe(1);expect(servers[0].listening).toBe(false);
});
