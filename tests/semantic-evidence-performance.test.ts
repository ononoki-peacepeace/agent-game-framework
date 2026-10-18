import {describe,expect,it} from 'vitest';
import {sparseSetup} from './sparse-fixture.js';
import {publicView} from '../src/core/state.js';
import {worldQueryEvidence} from '../src/agent/truth-query.js';
import {semanticEvidence} from '../src/agent/semantic-entry.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import {z} from 'zod';

describe('bounded semantic evidence projection',()=>{
  it('retains named canonical injury and control state before a large map or profile consumes the budget',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const npc=save.entities.find(entity=>entity.id==='npc_lin')!;
    npc.components.condition={hp:80,stamina:100,stress:0};
    npc.components.physical_state={awareness:'alert',alert_to_ids:[save.player_state.entity_id],restrained_by:null};
    const view=publicView(save);
    const subject=view.entities.find(entity=>entity.id==='npc_lin')!;
    // Presentation can carry a large public profile; it must not displace Core facts.
    subject.components.character={...subject.components.character,notes:Array.from({length:410},(_,i)=>`公开资料${i}`)};
    view.routes=Array.from({length:260},()=>({...view.routes[0]}));
    const input=`${String(subject.components.identity?.name)}现在受伤了吗？`;
    const evidence=semanticEvidence(view,input,save,undefined,true);
    expect(evidence.length).toBeLessThanOrEqual(240);
    expect(evidence.find(item=>item.id==='entity:npc_lin.condition.hp')?.value).toBe(80);
    expect(evidence.find(item=>item.id==='entity:npc_lin.physical_state.awareness')?.value).toBe('alert');
    expect(new Set(evidence.map(item=>item.id)).size).toBe(evidence.length);
    expect(evidence.some(item=>/beliefs|private_facts|hidden_truth/.test(item.id))).toBe(false);
  });
  it('retries a malformed low-effort goal audit at the original quality budget',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const efforts:(string|null)[]=[];
    const ai=new AIRuntime({name:'deepseek',generate:async request=>{
      efforts.push(request.reasoningEffort??null);
      if(request.reasoningEffort==='low')throw new ProviderError('schema','invalid candidate','invalid candidate');
      return {data:{preserved:true}};
    }});
    const output=await ai.systemAgent(z.strictObject({preserved:z.boolean()}),save.definition.prompt_profile,
      {input:'观察房间'},save,undefined,{reasoningEffort:'low'});
    expect(output).toEqual({preserved:true});
    expect(efforts).toEqual(['low',null]);
  });
  it('keeps target, player and scene citations while dropping unrelated NPC detail',async()=>{
    const f=await sparseSetup(),save=await f.service.current();
    const player=save.entities.find(item=>item.id===save.player_state.entity_id)!;
    const exemplar=save.entities.find(item=>item.id==='npc_lin')!;
    exemplar.components.location=structuredClone(player.components.location);
    for(let index=0;index<12;index++){
      const other=structuredClone(exemplar);other.id=`npc_remote_${index}`;
      other.components.identity.name=`远处人物${index}`;
      other.components.identity.description='无关的公开资料'.repeat(25);
      other.components.location={location_id:'market'};save.entities.push(other);
    }
    const view=publicView(save),input='向林望舒询问刚才的事';
    const old=worldQueryEvidence(view,input).slice(0,240),next=semanticEvidence(view,input,save);
    expect(next.some(item=>item.id===`entity:${view.player_id}.inventory.items`)).toBe(true);
    expect(next.some(item=>item.id==='entity:npc_lin.location.location_id')).toBe(true);
    expect(next.some(item=>item.id.startsWith('entity:npc_remote_0.identity.description'))).toBe(false);
    expect(next.some(item=>item.id==='location:square')).toBe(true);
    expect(JSON.stringify(next).length).toBeLessThan(JSON.stringify(old).length);
  });
});
