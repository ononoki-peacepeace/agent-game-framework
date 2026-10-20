import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sparseSetup} from './sparse-fixture.js';
import {routeContext} from '../src/system/context-router.js';

afterEach(()=>vi.restoreAllMocks());
it('does not lose a canonical receipt when persisting an ambiguous world input races a mutation',async()=>{
  const f=await sparseSetup(),before=await f.service.current(),read=f.store.read.bind(f.store);
  let release!:()=>void,arrive!:()=>void,reads=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  vi.spyOn(f.store,'read').mockImplementation(async slot=>{
    const snapshot=await read(slot);if(++reads===2){arrive();await gate;}return snapshot;
  });
  const routing=routeContext(f.service,'那个','world_input');await entered;
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  let conflict:unknown;
  try{await f.service.agentTransaction(request,{flag:'retained'},save=>{save.gm_state.flags.retained=true;});}
  catch(error){conflict=error;}finally{release();}
  await routing;const after=(await read())!;
  if(conflict)expect(conflict).toMatchObject({status:409});
  else{
    expect(after.gm_state.flags.retained).toBe(true);
    expect(after.runtime.receipts.some(receipt=>receipt.id===request.request_id)).toBe(true);
  }
});
it('does not write clarification metadata while a canonical save owns the mutation lock',async()=>{
  const f=await sparseSetup(),before=await f.service.current(),write=f.store.write.bind(f.store);
  let release!:()=>void,arrive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{arrive=resolve;});
  const writes=vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
    if(save.gm_state.flags.retained){arrive();await gate;}await write(save,slot);
  });
  const request={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID()};
  const mutation=f.service.agentTransaction(request,{flag:'retained'},save=>{save.gm_state.flags.retained=true;});
  let failure:unknown;
  try{await entered;try{await routeContext(f.service,'那个','world_input');}catch(error){failure=error;}}
  finally{release();}
  await mutation;expect(failure).toMatchObject({status:409});expect(writes).toHaveBeenCalledOnce();
  expect((await f.store.read())!.gm_state.flags.retained).toBe(true);
});
