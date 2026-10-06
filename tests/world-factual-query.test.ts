import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sparseSetup} from './sparse-fixture.js';
import {createApp} from '../src/server/app.js';
import {deriveWorldQuery,worldQueryEvidence} from '../src/agent/truth-query.js';
import {classifyGameIntent,planGameRequest} from '../src/agent/game.js';
import {fastPlan} from '../src/agent/planner.js';

type Evidence={id:string;kind:string;value:unknown};
type Query={question:string;evidence:Evidence[];instruction:string};
const found=(kind:'fact'|'inference'|'rule_judgment',answer:string,ids:string[],rules:string[]=[])=>
  ({status:'FOUND',kind,answer,evidence_ids:ids,rule_evidence_ids:rules,missing_information:[]});
const unknown=(answer:string,ids:string[],missing:string[])=>
  ({status:'UNKNOWN',kind:'rule_judgment',answer,evidence_ids:ids,rule_evidence_ids:[],missing_information:missing});

async function fixture(answer:(query:Query)=>unknown,age=19,rule?:string){
  const queries:Query[]=[];
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(properties.destination)return {data:{destination:'WORLD_INTENT',confidence:1,clarification:null,
      speech_target_id:null,world_input:null,resolved_input:null,end_conversation:false}};
    if(properties.evidence_ids){
      const data=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n')+2)) as Query;
      expect(request.threadId).toBeUndefined();
      expect(request.prompt).not.toContain('PRIVATE_QA37_MARKER');
      queries.push(data);return {data:answer(data)};
    }
    throw Error(`Unexpected provider role ${request.role}`);
  });
  const save=await f.service.current();
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  Object.assign(player.components.identity,{name:'金晨',age,age_as_of_day:1});
  save.gm_state.notes='PRIVATE_QA37_MARKER';
  save.ai.threads.system_agent='private_prior_thread';
  if(rule)save.definition.provenance={version:1,original_premise:null,declared_themes:[],declared_rules:[rule],
    player_role:null,initial_scope:null,template_source:{kind:'template',id:null,version:null},
    inspiration_seed:null,preview_signature:null,explicit_creation_choices:[],explicit_constraints:[],
    requested_traits:[],generated_canonical_fact_refs:[],records:[]};
  await f.store.write(save);
  return {...f,queries};
}

async function throughHTTP(f:Awaited<ReturnType<typeof fixture>>,run:(send:(input:string,surface?:'input'|'system')=>Promise<any>)=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),'agf-qa37-'));
  const server=createApp(f.service,undefined,undefined,join(directory,'assets')).listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const token=(await (await fetch(base+'/api/session')).json()).token;
    await run(async(input,surface='input')=>{
      const before=await f.service.current();
      const response=await fetch(`${base}/api/${surface}`,{method:'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},
        body:JSON.stringify({input,request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision})});
      const body=await response.json();
      expect(response.status,JSON.stringify(body)).toBe(200);
      // Includes revision, time, wallet, inventory, relationships, pending state and AI threads.
      expect(await f.service.current()).toEqual(before);
      expect(body.message).not.toContain('没有你可以确认的更多信息');
      return body;
    });
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
}

describe('QA-37 public fact queries',()=>{
  it('uses the same public field evidence through normal input, System and character lookup',async()=>{
    const f=await fixture(query=>{
      const property=query.question.includes('体力')?'condition.stamina':'identity.age';
      const fact=query.evidence.find(entry=>entry.id===`entity:player.${property}`)!;
      expect(fact).toBeDefined();
      return found('fact',property==='identity.age'?`金晨现在 ${fact.value} 岁。`:`金晨当前体力为 ${fact.value}。`,[fact.id]);
    });
    await throughHTTP(f,async send=>{
      for(const surface of ['input','system'] as const){
        expect((await send('我几岁？',surface)).message).toContain('19 岁');
        expect((await send('我的年龄是多少？',surface)).message).toContain('19 岁');
        expect((await send('金晨的年龄有多少？',surface)).message).toContain('19 岁');
        expect((await send('金晨目前体力有多少？',surface)).message).toContain('50');
        expect((await send('金晨体力资料',surface)).message).toContain('50');
      }
    });
    expect(f.queries).toHaveLength(10);
    expect(f.service.logger.entries({limit:200}).some(entry=>entry.event==='agent.query.evaluated')).toBe(true);
  });

  it.each([{age:19,threshold:18,expected:true},{age:19,threshold:21,expected:false},{age:26,threshold:25,expected:true}])(
    'uses the declared world rule, age $age and threshold $threshold',async({age,threshold,expected})=>{
      const rule=`本世界年满 ${threshold} 岁视为成年。`;
      const f=await fixture(query=>{
        const value=query.evidence.find(entry=>entry.id==='entity:player.identity.age')!;
        const law=query.evidence.find(entry=>entry.kind==='rule')!;
        expect(law.value).toBe(rule);
        expect(value.value).toBe(age);
        return found('rule_judgment',Number(value.value)>=threshold?'按本世界规则，已经成年。':'按本世界规则，尚未成年。',[value.id,law.id],[law.id]);
      },age,rule);
      await throughHTTP(f,async send=>{
        for(const surface of ['input','system'] as const)
          expect((await send('我成年了吗？',surface)).message).toContain(expected?'已经成年':'尚未成年');
      });
    });

  it('answers the known age while identifying the missing applicable rule',async()=>{
    const f=await fixture(query=>{
      expect(query.evidence.some(entry=>entry.kind==='rule')).toBe(false);
      expect(query.instruction).toContain('不能仅凭世界标题');
      return unknown('已登记年龄为 19 岁。',['entity:player.identity.age'],['本世界适用的成年门槛']);
    });
    await throughHTTP(f,async send=>{
      const response=await send('我成年了吗？');
      expect(response.message).toContain('19 岁');
      expect(response.message).toContain('缺少本世界适用的成年门槛');
      expect(response.awareness_status).toBe('UNKNOWN');
    });
  });

  it('rejects a rule judgement that cites age but has no actual rule evidence',async()=>{
    const f=await fixture(()=>found('rule_judgment','已经成年',['entity:player.identity.age']));
    const response=await deriveWorldQuery(f.service,(await f.service.view())!,'我成年了吗？');
    expect(response.status).toBe('UNKNOWN');expect(response.message).not.toContain('已经成年');
  });

  it('supports other character attributes and rules without depending on the age example',async()=>{
    const f=await fixture(query=>{
      const value=query.evidence.find(entry=>entry.id==='entity:npc_qiao.condition.stamina')!;
      expect(value.value).toBe(72);
      return found('rule_judgment','乔宁符合参与条件。',[value.id,'rule:0'],['rule:0']);
    },19,'本世界当前体力至少 60 才能参与耐力训练。');
    const save=await f.service.current();save.entities.find(entity=>entity.id==='npc_qiao')!.components.condition={hp:100,stamina:72,stress:0};
    await f.store.write(save);
    await throughHTTP(f,async send=>expect((await send('乔宁符合耐力训练的参与条件吗？')).message).toContain('符合参与条件'));
  });

  it('does not redirect another character wallet question to the player wallet',async()=>{
    const f=await fixture(query=>{
      const value=query.evidence.find(entry=>entry.id==='entity:npc_qiao.wallet.balances.credit')!;
      // Wallet projection intentionally makes other characters' balances private.
      expect(value).toBeUndefined();
      return unknown('无法确认。',[],['乔宁的公开钱包资料']);
    });
    const save=await f.service.current();save.entities.find(entity=>entity.id==='npc_qiao')!.components.wallet={balances:{credit:77}};
    await f.store.write(save);
    await throughHTTP(f,async send=>{
      const reply=await send('乔宁现在有多少钱？');
      expect(reply.message).toContain('缺少乔宁的公开钱包资料');
      expect(reply.message).not.toContain('77');
    });
  });

  it('rejects fabricated evidence IDs and state fields presented as legal rules',async()=>{
    for(const response of [found('fact','这是一个编造的属性。',['entity:player.identity.invented']),
      found('rule_judgment','已经成年。',['entity:player.identity.age'],['entity:player.identity.age'])]){
      const f=await fixture(()=>response);
      const result=await deriveWorldQuery(f.service,(await f.service.view())!,'我符合条件吗？');
      expect(result.status).toBe('UNKNOWN');expect(result.message).not.toBe(response.answer);
    }
  });

  it('keeps existing time, location, inventory and wallet queries read-only',async()=>{
    const f=await fixture(query=>{
      const calendar=query.evidence.find(entry=>entry.id==='calendar')!;
      expect(calendar.value).toBeTruthy();
      return found('inference','按世界日历，现在是星期一。',['time','calendar']);
    });
    await throughHTTP(f,async send=>{
      for(const surface of ['input','system'] as const){
        for(const text of ['现在几点？','我在哪里？','我还有多少钱？','背包里有什么？'])
          expect((await send(text,surface)).message.length).toBeGreaterThan(0);
        expect((await send('今天星期几？',surface)).message).toContain('星期一');
      }
    });
  });

  it('does not turn active investigation into a read-only fact lookup or expose hidden state',async()=>{
    const f=await fixture(()=>unknown('无法确定。',[],['公开证据']));
    const view=(await f.service.view())!;
    expect(classifyGameIntent('检查房间有没有线索')).toBe('WORLD_ACTION');
    expect(fastPlan(view,'检查房间有没有线索')?.goals[0].type).toBe('WORLD_ACTION');
    expect(planGameRequest(view,'检查房间有没有线索')).toBeNull();
    expect(JSON.stringify(worldQueryEvidence(view,'乔宁隐藏了什么？'))).not.toContain('PRIVATE_QA37_MARKER');
    const before=await f.service.current();
    expect((await deriveWorldQuery(f.service,view,'乔宁隐藏了什么？')).status).toBe('UNKNOWN');
    expect(await f.service.current()).toEqual(before);
  });
});
