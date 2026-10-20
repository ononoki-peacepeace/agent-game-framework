import {once} from 'node:events';
import type {Server} from 'node:http';

// Fetch's bad-port table above 1023 (including Node 24's additions).
// Low privileged ports are unnecessary for temporary loopback fixtures.
const blocked=new Set([1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,
  6665,6666,6667,6668,6669,6679,6697,10080]);

/** Choose a usable listener before making any HTTP request. Never retry requests. */
export async function listenFetchable(factory:()=>Server):Promise<Server>{
  for(let attempt=0;attempt<8;attempt++){
    const server=factory(),ready=once(server,'listening');
    server.listen(0,'127.0.0.1');await ready;
    const address=server.address();
    if(address&&typeof address!=='string'&&address.port>1023&&!blocked.has(address.port))return server;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
  throw new Error('No Fetch-compatible loopback port after 8 listener allocations');
}
