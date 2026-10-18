import {it,expect,afterEach} from 'vitest';
import {z} from 'zod';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {npcDecisionSchema} from '../src/agent/npc-agent.js';
import {structuredInputSchema,compileStructuredSchema,normalizeProviderOptionals,parseProviderOutput} from '../src/ai/provider-schema.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {DeepSeekAdapter} from '../src/ai/deepseek.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {newSave,publicView} from '../src/core/state.js';
import {executeAction} from '../src/core/runtime.js';
import {demo} from './helpers.js';
import {randomUUID} from 'node:crypto';
const record=JSON.parse(await readFile(new URL('./fixtures/npc-decision-deepseek-recorded.json',import.meta.url),'utf8'));
const input=structuredInputSchema(npcDecisionSchema),wire=compileStructuredSchema(input) as any;
const empty=()=>({kind:'no_action',speech:null,vote_target:null,intent:'保持自己的安排',proposed_action:null,
 evidence_refs:[],belief_updates:[],goal_updates:[],plan_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'当前不行动',social_response:null});
const fields=Object.keys(input.properties!);
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
const directories:string[]=[];

it('reproduces the saved plan_proposals failure with output-mode schema and repairs it with the shared input contract',()=>{
 const old=npcDecisionSchema.safeParse(normalizeProviderOptionals(record.raw_model_output,z.toJSONSchema(npcDecisionSchema)));
 expect(old.success).toBe(false);
 if(!old.success)expect(old.error.issues.some(issue=>issue.path.join('.')==='plan_proposals')).toBe(true);
 expect(parseProviderOutput(npcDecisionSchema,record.raw_model_output).plan_proposals).toEqual([]);
});

it.each(fields)('audits null semantics of the full NPC field %s',field=>{
 const member=npcDecisionSchema.shape[field as keyof typeof npcDecisionSchema.shape];
 const expected=member.safeParse(null).success||member.safeParse(undefined).success;
 const raw={...empty(),[field]:null},normalized=normalizeProviderOptionals(raw,input);
 expect(npcDecisionSchema.safeParse(normalized).success).toBe(expected);
 expect(wire.required).toContain(field);
 // The outgoing null acceptance must match the domain's null-or-absence contract.
 const node=wire.properties[field];
 const acceptsNull=node.type==='null'||(node.anyOf??[]).some((branch:any)=>branch.type==='null');
 expect(acceptsNull).toBe(expected);
 if(field==='goal_proposals'||field==='plan_proposals')expect((npcDecisionSchema.parse(normalized) as any)[field]).toEqual([]);
});
it.each(fields)('preserves domain omission semantics of %s',field=>{
 const value:any=empty();delete value[field];
 const member=npcDecisionSchema.shape[field as keyof typeof npcDecisionSchema.shape];
 expect(npcDecisionSchema.safeParse(normalizeProviderOptionals(value,input)).success).toBe(member.safeParse(undefined).success);
});
it.each(['plan_updates','plan_proposals','goal_proposals'])('restores only the recorded absence representation for %s',field=>{
 const parsed=parseProviderOutput(npcDecisionSchema,{...empty(),[field]:null});
 expect((parsed as any)[field]).toEqual(field==='plan_updates'?undefined:[]);
});
it('restores multiple optional/defaulted nulls at once and retains meaningful nullable nulls',()=>{
 const parsed=parseProviderOutput(npcDecisionSchema,{...empty(),plan_updates:null,plan_proposals:null,goal_proposals:null,social_response:null});
 expect(parsed).toMatchObject({plan_proposals:[],goal_proposals:[],proposed_action:null,speech:null,vote_target:null,social_response:null});
 expect(parsed.plan_updates).toBeUndefined();
});
it.each(['evidence_refs','belief_updates','goal_updates'])('never fabricates a missing required collection %s',field=>{
 for(const value of [null,{},'not an array',7])expect(()=>parseProviderOutput(npcDecisionSchema,{...empty(),[field]:value})).toThrow();
 expect(parseProviderOutput(npcDecisionSchema,empty())[field as 'evidence_refs']).toEqual([]);
});
it('does not conflate an empty object, null and an absent action',()=>{
 expect(()=>parseProviderOutput(npcDecisionSchema,{...empty(),proposed_action:{}})).toThrow();
 const missing:any=empty();delete missing.proposed_action;expect(()=>parseProviderOutput(npcDecisionSchema,missing)).toThrow();
 expect(parseProviderOutput(npcDecisionSchema,empty()).proposed_action).toBeNull();
 expect(()=>parseProviderOutput(npcDecisionSchema,{...empty(),plan_proposals:{}})).toThrow();
});
it('shares default handling across nested objects, arrays, tuples, nullable defaults and other roles',async()=>{
 const schema=z.strictObject({defaultArray:z.array(z.string()).default([]),defaultObject:z.strictObject({count:z.number().default(2)}).default({count:2}),
  nullableDefault:z.string().nullable().default('fallback'),requiredArray:z.array(z.string()),
  nested:z.array(z.strictObject({enabled:z.boolean().default(false),note:z.string().optional()})),
  tuple:z.tuple([z.strictObject({items:z.array(z.string()).default([])})])});
 const raw={defaultArray:null,defaultObject:null,nullableDefault:null,requiredArray:[],nested:[{enabled:null,note:null}],tuple:[{items:null}]};
 const expected={defaultArray:[],defaultObject:{count:2},nullableDefault:null,requiredArray:[],nested:[{enabled:false}],tuple:[{items:[]}]};
 expect(parseProviderOutput(schema,raw)).toEqual(expected);
 const ai=new AIRuntime({name:'offline-contract',generate:async()=>({data:structuredClone(raw)})});
 // Both the main structured call and the direct-planner path use the same input semantics.
 expect(await ai.systemAgent(schema,demo.prompt_profile,{},newSave(demo))).toEqual(expected);
 expect(await ai.planGoals(publicView(newSave(demo)),'隔离结构契约检查',schema)).toEqual(expected);
 expect(()=>parseProviderOutput(schema,{...raw,requiredArray:null})).toThrow();
});
it('compiles referenced object and tuple definitions with the same optional wire semantics',()=>{
 const schema={type:'object',properties:{entry:{$ref:'#/$defs/entry'},tuple:{type:'array',prefixItems:[{$ref:'#/$defs/entry'}]}},required:['entry','tuple'],
  $defs:{entry:{type:'object',properties:{items:{type:'array',items:{type:'string'}}},required:[]}}};
 const compiled=compileStructuredSchema(schema) as any;
 expect(compiled.$defs.entry.required).toEqual(['items']);
 expect(compiled.$defs.entry.properties.items.anyOf.at(-1)).toEqual({type:'null'});
 expect(normalizeProviderOptionals({entry:{items:null},tuple:[{items:null}]},schema)).toEqual({entry:{},tuple:[{}]});
});
it('preserves nested NPC optionals but never fills missing required steps or action arguments',()=>{
 const raw={...empty(),goal_proposals:[{id:'g',description:'自己的安排',horizon:'short',priority:1}],
  plan_proposals:[{id:'p',goal_id:'g',intention:'只形成意图',steps:null,not_before:null,condition:null}]};
 expect(parseProviderOutput(npcDecisionSchema,raw).plan_proposals[0]).toEqual({id:'p',goal_id:'g',intention:'只形成意图',not_before:null,condition:null});
 expect(()=>parseProviderOutput(npcDecisionSchema,{...raw,plan_proposals:[{...raw.plan_proposals[0],steps:[]}]})).toThrow();
 expect(()=>parseProviderOutput(npcDecisionSchema,{...empty(),proposed_action:{type:'HOLD',target_id:null,duration_minutes:null}})).toThrow();
});
it('keeps unknown fields out of the decision and authoritative state',async()=>{
 expect(()=>parseProviderOutput(npcDecisionSchema,{...empty(),forged_position:'market'})).toThrow();
 const ai=new AIRuntime({name:'offline-unknown',generate:async()=>({data:{...empty(),forged_position:'market'}})});
 expect(await ai.npcDecision(demo.prompt_profile,{})).not.toHaveProperty('forged_position');
});
it('emits a complete machine-readable top-level and nested contract audit',async()=>{
 const audit:any[]=[];
 const walk=(domain:any,output:any,provider:any,path='')=>{for(const [key,child] of Object.entries(domain.properties??{}) as [string,any][]){
  const out=output.properties?.[key],w=provider.properties?.[key];
  audit.push({path:path?path+'.'+key:key,input_required:(domain.required??[]).includes(key),output_required:(output.required??[]).includes(key),input_schema:child,provider_schema:w,
   conversion:'Only input-optional, non-nullable property null is restored to absence; original Zod parse applies declared defaults.'});
  const domainChild=child.anyOf?.find((n:any)=>n.type!=='null')??child;
  const outputChild=out?.anyOf?.find((n:any)=>n.type!=='null')??out;
  const wireChild=w?.anyOf?.find((n:any)=>n.type!=='null')??w;
  walk(domainChild.items??domainChild,outputChild?.items??outputChild??{},wireChild?.items??wireChild??{},path?path+'.'+key:key);
 }};
 walk(input,z.toJSONSchema(npcDecisionSchema),wire);expect(audit.length).toBeGreaterThan(fields.length);
 await writeFile('docs/qa-npc-schema-contract-audit.json',JSON.stringify(audit,null,2));
});

it('replays the saved real DeepSeek body through transport, domain, NPC, Core, receipt and isolated Save/Reload/Undo',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'npc-recorded-contract-'));directories.push(dir);
 let calls=0,sentSchema:any;
 const adapter=new DeepSeekAdapter({apiKey:'offline-test-key',fetchImpl:async(_url,init)=>{
  calls++;sentSchema=JSON.parse(String(init?.body)).text.format.schema;
  return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(record.raw_model_output)}]}]}),{status:200});
 }});
 const world=structuredClone(demo);world.meta.title='单次NPC首步关联真实验收';world.events=[];world.gm_state={notes:'隔离测试，无隐藏事实。',flags:world.gm_state.flags};
 const before=newSave(world),store=new JsonStore(dir),ai=new AIRuntime(adapter),service=new GameService(store,ai,world);
 await store.write(before);
 const body={game_id:before.game_id,expected_revision:before.state_revision,request_id:record.source_request_id};
 await service.agentTransaction(body,{kind:'isolated_elapsed_world_window',minutes:180},save=>Object.assign(save,executeAction(save,{type:'WAIT',parameters:{minutes:180}},body.request_id).save));
 const after=await new JsonStore(dir).read();
 expect(calls).toBe(1);expect(JSON.stringify(sentSchema.properties.plan_proposals)).toContain('"null"');
 expect(after!.npc_agent_state!.npc_lin.last_decisions.at(-1)?.kind).toBe(record.raw_model_output.kind);
 expect(after!.npc_agent_state!.npc_lin.autonomy_retry).toBeUndefined();
 const receipt=after!.resolution_receipts!.find(r=>r.actor_id==='npc_lin'&&r.semantic_action==='HOLD');
 expect(receipt).toMatchObject({commit_status:'committed',time_cost:45});
 expect(after!.npc_agent_state!.npc_lin.plans).toEqual([]);
 expect(after!.entities.map(e=>[e.id,e.components.inventory])).toEqual(before.entities.map(e=>[e.id,e.components.inventory]));
 const reloaded=new GameService(new JsonStore(dir),ai,world);
 await reloaded.agentTransaction(body,{kind:'isolated_elapsed_world_window',minutes:180},()=>{throw Error('must not execute duplicate');});
 expect(calls).toBe(1);
 await reloaded.undo({game_id:after!.game_id,expected_revision:after!.state_revision,request_id:randomUUID()});
 const undone=await reloaded.current();expect(undone.runtime.time).toEqual(before.runtime.time);expect(undone.npc_agent_state).toEqual(before.npc_agent_state);
});
