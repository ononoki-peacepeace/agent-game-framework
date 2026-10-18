import {expect,it} from 'vitest';
import {agentSkills} from '../src/agent/skills/index.js';
import {sparseSetup} from './sparse-fixture.js';

it('enumerates reusable skill adapters and metadata over existing core tools',async()=>{
  const f=await sparseSetup();
  const save=await f.service.current(),skills=agentSkills(save);
  expect(skills.list().map(skill=>skill.id)).toEqual([
    'temporal_wait','location_exploration','natural_scene','public_world_query','npc_expansion']);
  expect(skills.get('temporal_wait')?.allowedTools).toContain('wait');
  expect(skills.get('location_exploration')?.allowedTools).toContain('search_world');
  expect(skills.get('natural_scene')?.allowedTools).toContain('propose_natural_scene');
  expect(skills.get('public_world_query')?.allowedTools).toEqual(['read_world_state','inspect_scene']);
  expect(skills.list().find(skill=>skill.id==='public_world_query')?.executable).toBe(true);
  expect(skills.list().find(skill=>skill.id==='npc_expansion')?.executable).toBe(false);
  const wait=skills.tools.get('wait')!;
  expect(wait).toMatchObject({sideEffect:'world_mutation',authority:'transaction',persistentEffect:true});
  expect(wait.inputSchema.safeParse({minutes:30}).success).toBe(true);
  expect(wait.inputSchema.safeParse({minutes:0}).success).toBe(false);
  expect(skills.tools.get('inspect_scene')).toMatchObject({sideEffect:'read_only',persistentEffect:false});
  expect(skills.tools.get('missing')).toBeNull();
  await expect(skills.invoke('missing',{}, {service:f.service,save,request_id:'test'})).rejects.toThrow('Unknown skill');
  await expect(skills.invoke('npc_expansion',{}, {service:f.service,save,request_id:'test'}))
    .rejects.toThrow('metadata-only');
  expect((await f.service.current()).state_revision).toBe(save.state_revision);
});

it('answers varied public questions through one read-only skill and rejects invented evidence',async()=>{
  const f=await sparseSetup(async request=>{
    const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
    if(!properties.evidence_ids)throw Error(`Unexpected model call: ${request.role}`);
    const query=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n')+2)) as {
      question:string;evidence:{id:string;value:unknown}[]};
    if(query.question.includes('凶手'))return {data:{status:'UNKNOWN',kind:'inference',
      answer:'公开资料未证实这个前提。',evidence_ids:[],rule_evidence_ids:[],
      missing_information:['能证明身份的公开证据']}};
    const field=query.question.includes('体力')?'entity:player.condition.stamina':'time';
    const evidence=query.evidence.find(entry=>entry.id===field);
    if(query.question.includes('无效证据'))return {data:{status:'FOUND',kind:'fact',
      answer:'这是编造的事实。',evidence_ids:['missing:evidence'],rule_evidence_ids:[],missing_information:[]}};
    return {data:{status:'FOUND',kind:'fact',answer:`公开记录：${JSON.stringify(evidence?.value)}。`,
      evidence_ids:[field],rule_evidence_ids:[],missing_information:[]}};
  });
  const before=await f.service.current(),skills=agentSkills(before),view=f.service.project(before);
  for(const [question,status] of [
    ['现在是什么时间？','FOUND'],['我目前体力是多少？','FOUND'],
    ['既然乔宁是凶手，他为什么这么做？','UNKNOWN'],['无效证据能证明事实吗？','UNKNOWN'],
  ] as const){
    const answer=await skills.invoke<{view:typeof view;question:string},{status:string;message:string}>(
      'public_world_query',{view,question},{service:f.service,save:before,request_id:question});
    expect(answer.status).toBe(status);
    if(status==='UNKNOWN')expect(answer.message).not.toContain('乔宁是凶手');
    expect(answer.message).not.toContain('这是编造的事实');
  }
  expect(await f.service.current()).toEqual(before);
  expect(before.resolution_receipts?.length??0).toBe((await f.service.current()).resolution_receipts?.length??0);
});
