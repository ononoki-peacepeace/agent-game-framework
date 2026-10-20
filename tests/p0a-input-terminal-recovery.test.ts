import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {JsonStore,type StoredInputRecord} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {MockAIAdapter} from '../src/ai/mock.js';
import {ProviderError} from '../src/ai/failures.js';
import {engineOutcome,WorldBlockedError} from '../src/agent/outcome.js';
import {agentResult} from '../src/agent/contracts.js';
import * as router from '../src/system/context-router.js';
import * as executor from '../src/agent/executor.js';
import {awaitInputResult} from '../src/client/input-recovery.js';
import {generateWithinRequestBudget,withRequestBudget} from '../src/ai/request-budget.js';
import {fresh} from './helpers.js';
import {withInputRecovery,type InputRecovery} from '../src/recovery/request-context.js';
import {ensureNarrativeState} from '../src/narrative/runtime.js';

afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'agf-input-terminal-')),store=new JsonStore(directory),initial=fresh();
  await store.write(initial);
  const ai=new AIRuntime(new MockAIAdapter()),service=new GameService(store,ai,initial.definition);
  const baseline=await service.current();
  let server=createApp(service).listen(0,'127.0.0.1');await once(server,'listening');
  let base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  vi.spyOn(router,'routeContext').mockResolvedValue({destination:'WORLD_INTENT',semantic:{kind:'world_action'},
    resolved_input:'规范化的动作'} as never);
  const body={request_id:randomUUID(),game_id:baseline.game_id,expected_revision:baseline.state_revision,input:'保留这条原始玩家意图'};
  return {store,service,ai,body,baseline,
    async post(value:unknown=body){const {token}=await (await fetch(base+'/api/session')).json();
      const response=await fetch(base+'/api/input',{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(value)});
      return {status:response.status,body:await response.json()};},
    async status(){return (await fetch(`${base}/api/input/status/${body.request_id}?game_id=${body.game_id}`)).json();},
    async settled(){for(let i=0;i<150;i++){const record=await store.readInputRecord(body.game_id,body.request_id);
      if(record?.state!=='running'&&record)return record;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Journal did not settle');},
    async restart(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
      server=createApp(new GameService(new JsonStore(directory),ai,initial.definition)).listen(0,'127.0.0.1');await once(server,'listening');
      base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;},
    async close(){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});},
  };
}

describe('P0-A durable terminal classification and child commit evidence',()=>{
  it.each(['before','after'] as const)('reconciles a real System module %s-write failure without a false unchanged response',async(point)=>{
    const f=await fixture();try{
      f.body.input='我不需要生活模式了。';
      const route=vi.mocked(router.routeContext).mockResolvedValue({destination:'SYSTEM_META_INTENT',
        semantic:{kind:'system_operation',operation_plane:'system_management'}} as never);
      const write=f.store.write.bind(f.store),manage=vi.spyOn(f.service,'manageModule');
      vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{
        if(point==='before')throw Error('system module write failed before commit');
        await write(save,slot);throw Error('system module response lost after commit');
      });
      const first=await f.post(),after=(await f.store.read())!;
      expect(first.status).toBe(503);expect(JSON.stringify(first.body)).not.toContain('世界状态没有改变');
      const receiptIds=after.runtime.receipts.filter(r=>!f.baseline.runtime.receipts.some(old=>old.id===r.id)).map(r=>r.id);
      expect(receiptIds).toHaveLength(point==='after'?1:0);
      expect(first.body.outcome).toMatchObject({type:'engine_failure',state_certain:true,receipt_ids:receiptIds});
      expect(after.runtime.time).toEqual(f.baseline.runtime.time);
      if(point==='before')expect(after).toEqual(f.baseline);
      else{expect(after.state_revision).toBe(f.baseline.state_revision+1);expect(after.definition.enabled_modules).not.toContain('routine');}
      await f.settled();expect(await f.post()).toEqual(first);
      await f.restart();expect(await f.post()).toEqual(first);expect(await f.store.read()).toEqual(after);
      expect(manage).toHaveBeenCalledOnce();expect(route).toHaveBeenCalledOnce();
    }finally{await f.close();}
  });
  it.each(['checkpoint_before','checkpoint_after','current_before','current_after'] as const)(
    'safely terminates module removal at the %s write boundary without replaying either file',async(point)=>{
      const f=await fixture();try{
        const child=randomUUID(),write=f.store.write.bind(f.store),writes:string[]=[];
        vi.spyOn(f.store,'write').mockImplementation(async(save,slot='current')=>{
          writes.push(slot);if(point===`${slot}_before`)throw Error(`${point} failure`);
          await write(save,slot);if(point===`${slot}_after`)throw Error(`${point} failure`);
        });
        const execute=vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
          await f.service.manageModule({game_id:f.body.game_id,expected_revision:f.body.expected_revision,
            request_id:child,module:'routine',confirmed:true},'remove');throw Error('unexpected completed remove');
        });
        const first=await f.post(),after=(await f.store.read())!,checkpoint=await f.store.read('checkpoint');
        const committed=point==='current_after';
        expect(first.body.outcome).toMatchObject({type:'engine_failure',state_certain:true,receipt_ids:committed?[child]:[]});
        if(committed){
          expect(after.state_revision).toBe(f.baseline.state_revision+1);expect(after.modules.routine?.installed).toBe(false);
        }else expect(after).toEqual(f.baseline);
        if(point==='checkpoint_before')expect(checkpoint).toBeNull();
        else expect(checkpoint).toEqual({...f.baseline,runtime:{...f.baseline.runtime,receipts:[]}});
        const attempts=[...writes];await f.settled();expect(await f.post()).toEqual(first);
        await f.restart();expect(await f.post()).toEqual(first);expect(await f.store.read()).toEqual(after);
        expect(await f.store.read('checkpoint')).toEqual(checkpoint);expect(writes).toEqual(attempts);expect(execute).toHaveBeenCalledTimes(1);
      }finally{await f.close();}
    });
  for(const kind of ['narrative','activity','extension','module'] as const){
    const operation=async(f:Awaited<ReturnType<typeof fixture>>,child:string)=>{
      const raw={game_id:f.body.game_id,expected_revision:f.body.expected_revision,request_id:child};
      if(kind==='narrative')return f.service.narrativeCommand(raw,'DORMANT');
      if(kind==='activity')return f.service.performDeclaredActivity({...raw,activity_id:'meal'});
      if(kind==='extension')return f.service.extensionTransaction(raw,{isolated_extension:true},()=>{});
      return f.service.manageModule({...raw,module:'routine',confirmed:true},'disable');
    };
    const setup=async()=>{
      const f=await fixture();
      if(kind==='narrative'){
        ensureNarrativeState(f.baseline).arcs.push({id:'isolated_arc',title:'隔离故事线',status:'ACTIVE',summary:'候选审计',
          canonical_event_refs:[],truth_refs:[],participant_refs:[],closure_priority:0,reveal_step:0,
          accelerated_closure:false,last_meaningful_revision:f.baseline.state_revision});
        await f.store.write(f.baseline);
      }
      return f;
    };
    it(`prepares ${kind} child identity and recovers its committed result without replay`,async()=>{
      const f=await setup();try{
        const child=randomUUID();
        vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
          await operation(f,child);throw new ProviderError('timeout','after child','timeout');
        });
        const first=await f.post(),after=(await f.store.read())!;
        expect(first.body.outcome).toMatchObject({type:'engine_failure',receipt_ids:[child],state_certain:true,revision:f.baseline.state_revision+1});
        expect((await f.settled()).recovery?.transactions[0].request_id).toBe(child);
        await operation(f,child);expect(await f.store.read()).toEqual(after);
        await f.restart();expect(await f.post()).toEqual(first);expect(await f.store.read()).toEqual(after);
      }finally{await f.close();}
    });
    it(`does not write ${kind} state if preparing its journal fails`,async()=>{
      const f=await setup();try{
        const write=f.store.writeInputRecord.bind(f.store),world=vi.spyOn(f.store,'write');
        vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{
          if(record.state==='running'&&record.recovery?.transactions.length)throw Error('child journal unavailable');
          await write(record);
        });
        vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
          await operation(f,randomUUID());throw Error('unreachable');
        });
        const result=await f.post();expect(result.status).toBe(503);expect(world).not.toHaveBeenCalled();
        expect(result.body.outcome.receipt_ids).toEqual([]);expect(await f.store.read()).toEqual(f.baseline);
      }finally{await f.close();}
    });
    it(`verifies ${kind} persistence after a world write succeeds then throws`,async()=>{
      const f=await setup();try{
        const child=randomUUID(),write=f.store.write.bind(f.store);
        vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{await write(save,slot);throw Error('after durable write');});
        vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
          await operation(f,child);throw Error('unreachable');
        });
        const result=await f.post();expect(result.status).toBe(503);
        expect(result.body.outcome).toMatchObject({receipt_ids:[child],state_certain:true});
        const after=await f.store.read();await f.restart();expect(await f.post()).toEqual(result);
        expect(await f.store.read()).toEqual(after);
      }finally{await f.close();}
    });
  }

  it('stops a cancelled turn after preparing the journal and before the world write',async()=>{
    const f=await fixture();try{
      const controller=new AbortController(),write=vi.spyOn(f.store,'write');
      const recovery:InputRecovery={original_player_input:f.body.input,trace_id:'tr_cancel_prepare',transactions:[]};
      await expect(withInputRecovery({game_id:f.body.game_id,recovery,persist:async()=>{
        await Promise.resolve();controller.abort(Error('cancelled during prepare'));
      }},()=>f.service.turn({...f.body,input:undefined,action:{type:'WAIT',parameters:{minutes:5}}},undefined,controller.signal)))
        .rejects.toThrow('cancelled during prepare');
      expect(recovery.transactions).toHaveLength(1);expect(write).not.toHaveBeenCalled();
      expect(await f.store.read()).toEqual(f.baseline);
    }finally{await f.close();}
  });

  it('classifies an actual semantic provider timeout as a technical failure without retrying it',async()=>{
    const f=await fixture();try{
      vi.mocked(router.routeContext).mockRestore();
      (f.ai.adapter as {name:string}).name='offline-semantic-fault';
      const generate=vi.spyOn(f.ai.adapter,'generate').mockRejectedValue(new ProviderError('timeout','offline injected','timeout'));
      const first=await f.post();expect(first.status).toBe(503);
      expect(first.body.outcome).toMatchObject({type:'engine_failure',code:'provider_failure',stage:'semantic_provider',receipt_ids:[],state_certain:true});
      expect(generate).toHaveBeenCalledTimes(1);expect(await f.store.read()).toEqual(f.baseline);
      await f.restart();expect(await f.post()).toEqual(first);expect(generate).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });

  it('keeps a provider failure identical across concurrent duplicate, polling and restart without fabricated receipts',async()=>{
    const f=await fixture();try{
      const execute=vi.spyOn(executor,'handleAgentInput').mockRejectedValue(new ProviderError('timeout','injected','timeout'));
      const [first,duplicate]=await Promise.all([f.post(),f.post()]);
      expect(first.status).toBe(503);expect(duplicate).toEqual(first);expect(execute).toHaveBeenCalledTimes(1);
      expect(first.body.outcome).toMatchObject({type:'engine_failure',code:'provider_failure',receipt_ids:[],state_certain:true});
      expect(first.body.recovery).toMatchObject({original_player_input:f.body.input,request_id:f.body.request_id,receipt_ids:[]});
      expect(first.body.recovery.trace_id).toMatch(/^tr_/);
      const persisted=await f.settled();expect(persisted.response).toEqual(first.body);
      expect(await f.status()).toMatchObject({state:'failed',payload:first.body,http_status:503});
      await f.restart();expect(await f.post()).toEqual(first);
      expect(await f.status()).toMatchObject({state:'failed',payload:first.body,http_status:503});
      expect(execute).toHaveBeenCalledTimes(1);expect(await f.store.read()).toEqual(f.baseline);
    }finally{await f.close();}
  });

  it('journals a world blockage as a completed game result instead of a failed request',async()=>{
    const f=await fixture();try{
      const execute=vi.spyOn(executor,'handleAgentInput').mockRejectedValue(new WorldBlockedError('closed','门仍然锁着。'));
      const first=await f.post();expect(first.status).toBe(200);
      expect(first.body.outcome).toMatchObject({type:'game',kind:'blocked_by_world',receipt_ids:[]});
      expect((await f.settled()).state).toBe('completed');
      expect(await f.status()).toMatchObject({state:'completed',result:first.body});
      await f.restart();expect(await f.post()).toEqual(first);expect(execute).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });

  it.each(['turn','agent'] as const)('retains only the %s child receipt when a later stage fails',async kind=>{
    const f=await fixture();try{
      const unrelated=randomUUID();
      await f.service.agentTransaction({...f.body,request_id:unrelated},{unrelated:true},()=>{});
      f.body.expected_revision=(await f.store.read())!.state_revision;
      const child=randomUUID();
      const execute=vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
        if(kind==='turn')await f.service.turn({...f.body,request_id:child,input:undefined,action:{type:'WAIT',parameters:{minutes:5}}});
        else await f.service.agentTransaction({...f.body,request_id:child},{scene:true},()=>{});
        throw new ProviderError('timeout','after child','timeout');
      });
      const first=await f.post(),after=await f.store.read();
      expect(first.body.outcome).toMatchObject({type:'engine_failure',receipt_ids:[child],revision:after!.state_revision,state_certain:true});
      expect(first.body.retry_policy).toBe('do_not_replay');expect(first.body.recovery.receipt_ids).not.toContain(unrelated);
      const record=await f.settled();expect(record.recovery?.transactions).toHaveLength(1);
      expect(record.recovery?.transactions[0].request_id).toBe(child);
      await f.restart();expect(await f.post()).toEqual(first);expect(await f.store.read()).toEqual(after);
      expect(execute).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });

  it.each([false,true])('verifies actual persistence when the world write throws (persisted=%s)',async persisted=>{
    const f=await fixture();try{
      const child=randomUUID(),write=f.store.write.bind(f.store);
      vi.spyOn(f.store,'write').mockImplementation(async(save,slot)=>{if(persisted)await write(save,slot);throw Error('Injected storage failure');});
      vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
        await f.service.agentTransaction({...f.body,request_id:child},{storage_fault:true},()=>{});throw Error('unreachable');
      });
      const first=await f.post();expect(first.status).toBe(503);
      expect(first.body.outcome).toMatchObject({type:'engine_failure',state_certain:true,receipt_ids:persisted?[child]:[]});
      await f.settled();const after=await f.store.read();await f.restart();
      expect(await f.post()).toEqual(first);expect(await f.store.read()).toEqual(after);
    }finally{await f.close();}
  });

  it('stops before the world write if the child intent journal cannot persist',async()=>{
    const f=await fixture();try{
      const write=f.store.writeInputRecord.bind(f.store),world=vi.spyOn(f.store,'write');
      vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{
        if(record.state==='running'&&record.recovery?.transactions.length)throw Error('Journal disk failure');await write(record);
      });
      vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
        await f.service.agentTransaction({...f.body,request_id:randomUUID()},{prepare_fault:true},()=>{});throw Error('unreachable');
      });
      const first=await f.post();expect(first.status).toBe(503);expect(world).not.toHaveBeenCalled();
      expect(await f.store.read()).toEqual(f.baseline);expect(first.body.outcome.receipt_ids).toEqual([]);
      await f.settled();
    }finally{await f.close();}
  });

  it.each(['matching','missing','wrong_fingerprint'] as const)('recovers a prepared child after restart only with %s receipt evidence',async evidence=>{
    const f=await fixture();try{
      const child=randomUUID();
      if(evidence!=='missing')await f.service.agentTransaction({...f.body,request_id:child},{restart:true},()=>{});
      const after=(await f.store.read())!,receipt=after.runtime.receipts.find(entry=>entry.id===child);
      const record:StoredInputRecord={version:1,...f.body,started_at:Date.now(),state:'running',
        fingerprint:createHash('sha256').update(JSON.stringify(f.body)).digest('hex'),
        recovery:{original_player_input:f.body.input,trace_id:'tr_restart',transactions:[{request_id:child,
          fingerprint:evidence==='matching'?receipt!.fingerprint:'different',expected_revision:f.body.expected_revision}]}};
      // The outer request body fields are not part of the journal schema.
      delete (record as unknown as Record<string,unknown>).input;
      delete (record as unknown as Record<string,unknown>).expected_revision;
      await f.store.writeInputRecord(record);await f.restart();
      const execute=vi.spyOn(executor,'handleAgentInput');
      const status=await f.status(),post=await f.post();
      if(evidence==='matching'){
        expect(status).toMatchObject({state:'completed',result:{outcome:{kind:'partial_progress',receipt_ids:[child]}}});
        expect(post.status).toBe(200);expect(post.body.outcome.receipt_ids).toEqual([child]);
      }else{expect(status).toMatchObject({state:'unknown',reason:'server_interrupted'});expect(post.status).toBe(409);}
      expect(execute).not.toHaveBeenCalled();expect(await f.store.read()).toEqual(after);
    }finally{await f.close();}
  });

  it('preserves structured failure information when the browser recovers through status',async()=>{
    const payload={outcome:{type:'engine_failure',receipt_ids:['committed-child'],state_certain:false}};
    await expect(awaitInputResult(Promise.reject(Error('connection lost')),async()=>
      ({state:'failed',error:'已提交部分行动',http_status:503,payload}),{requestTimeoutMs:0,polls:1}))
      .rejects.toMatchObject({payload,httpStatus:503,message:'已提交部分行动'});
  });

  it('does not reset the request model budget after semantic routing',async()=>{
    const f=await fixture();try{
      let calls=0;
      const adapter={name:'offline-budget',async generate(){calls++;return {data:{}};}};
      const request={role:'gm_reasoning' as const,prompt:'offline',schema:{},maxOutputTokens:1};
      vi.mocked(router.routeContext).mockImplementation(async()=>{
        for(let i=0;i<24;i++)await generateWithinRequestBudget(adapter,request);
        return {destination:'WORLD_INTENT',semantic:{kind:'world_action'}} as never;
      });
      vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>withRequestBudget(async()=>{
        await generateWithinRequestBudget(adapter,request);throw Error('budget reset');
      }));
      const result=await f.post();expect(result.status).toBe(503);expect(calls).toBe(24);
      expect(result.body.outcome).toMatchObject({type:'engine_failure',code:'provider_failure',receipt_ids:[]});
      await f.settled();
    }finally{await f.close();}
  });

  it('recovers the prepared child if persisting the terminal journal fails after commit',async()=>{
    const f=await fixture();try{
      const child=randomUUID(),write=f.store.writeInputRecord.bind(f.store);
      vi.spyOn(f.store,'writeInputRecord').mockImplementation(async record=>{
        if(record.state!=='running')throw Error('Terminal journal failure');await write(record);
      });
      const execute=vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
        await f.service.agentTransaction({...f.body,request_id:child},{terminal_fault:true},()=>{});
        throw new ProviderError('timeout','after commit','timeout');
      });
      expect((await f.post()).body.outcome.receipt_ids).toEqual([child]);
      for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,5));
      expect((await f.store.readInputRecord(f.body.game_id,f.body.request_id))?.state).toBe('running');
      const after=await f.store.read();await f.restart();
      expect(await f.status()).toMatchObject({state:'completed',reason:'committed_progress_recovered',
        result:{outcome:{kind:'partial_progress',receipt_ids:[child]}}});
      expect((await f.post()).body.outcome.receipt_ids).toEqual([child]);
      expect(await f.store.read()).toEqual(after);expect(execute).toHaveBeenCalledTimes(1);
    }finally{await f.close();}
  });

  it('reconciles a returned Agent engine failure against the child journal before sending it',async()=>{
    const f=await fixture();try{
      const child=randomUUID();
      vi.spyOn(executor,'handleAgentInput').mockImplementation(async()=>{
        await f.service.agentTransaction({...f.body,request_id:child},{returned_failure:true},()=>{});
        return agentResult('WORLD_ACTION','未能继续。',{outcome:engineOutcome('provider_failure','later_stage',0,false)});
      });
      const first=await f.post();expect(first.status).toBe(200);
      expect(first.body.outcome).toMatchObject({type:'engine_failure',receipt_ids:[child],revision:1,state_certain:true});
      expect(first.body.recovery).toMatchObject({original_player_input:f.body.input,receipt_ids:[child],latest_revision:1});
      expect(first.body.retry_policy).toBe('do_not_replay');expect(first.body.message).toContain('已经结算');
      await f.restart();expect(await f.post()).toEqual(first);
    }finally{await f.close();}
  });

  it('does not mistake an Undo-retained idempotency receipt for current committed progress',async()=>{
    const f=await fixture();try{
      const child=randomUUID();
      await f.service.turn({...f.body,request_id:child,input:undefined,action:{type:'WAIT',parameters:{minutes:5}}});
      const committed=(await f.store.read())!,receipt=committed.runtime.receipts.find(entry=>entry.id===child)!;
      await f.service.undo({game_id:f.body.game_id,expected_revision:committed.state_revision,request_id:randomUUID()});
      const after=await f.store.read();
      expect(after!.runtime.receipts.some(entry=>entry.id===child)).toBe(true);
      await f.store.writeInputRecord({version:1,game_id:f.body.game_id,request_id:f.body.request_id,state:'running',started_at:Date.now(),
        fingerprint:createHash('sha256').update(JSON.stringify(f.body)).digest('hex'),recovery:{original_player_input:f.body.input,
          trace_id:'tr_undone',transactions:[{request_id:child,fingerprint:receipt.fingerprint,expected_revision:receipt.revision-1}]}});
      await f.restart();expect(await f.status()).toMatchObject({state:'unknown',reason:'server_interrupted'});
      expect((await f.post()).status).toBe(409);expect(await f.store.read()).toEqual(after);
    }finally{await f.close();}
  });
});
