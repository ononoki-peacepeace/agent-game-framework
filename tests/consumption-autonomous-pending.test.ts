import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {consumptionWorld,quantity} from './fixtures/consumption-worlds.js';
import {narrativeWorldKinds} from './fixtures/narrative-worlds.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {ProviderError} from '../src/ai/failures.js';
import * as core from '../src/core/runtime.js';
afterEach(()=>vi.restoreAllMocks());const run=randomUUID();
it.each(narrativeWorldKinds.flatMap(kind=>[false,true].map(fallback=>({kind,fallback}))))('retains compound identity and player/NPC consumption across post-autonomy pending restaging in $kind / fallback=$fallback',async({kind,fallback})=>{
 const {save}=await consumptionWorld(kind),directory=await mkdtemp(join(tmpdir(),'agf-consume-npc-pending-'));try{
  // Authored 90-minute operations make the existing autonomous cadence genuinely due.
  for(const collection of [save.entities,save.definition.entities]) (collection.find(e=>e.id==='qa_bread')!.components.item!.consumable as {minutes:number}).minutes=90;
  const store=new JsonStore(directory);await store.write(save);const prompts:Record<string,unknown>[]=[];
  const text='你吃掉了两份面包。林舟吃掉了一份面包。';
  const ai=new AIRuntime({name:'offline-autonomous-pending',generate:async request=>{
   if(request.role==='narrator'){prompts.push(JSON.parse(request.prompt.slice(request.prompt.indexOf('{'))));if(fallback)throw new ProviderError('refusal','offline-only','fixed refusal');return {data:{narrative:text,speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}};}
   throw new ProviderError('refusal','offline-only','No real provider');
  }});
  const decide=vi.spyOn(ai,'npcDecision').mockImplementation(async(_profile,raw)=>{const context=raw as {npc_id:string};return {kind:context.npc_id==='npc_lin'?'proposed_action':'no_action',speech:null,vote_target:null,intent:'只消耗本人持有的一份世界食物',proposed_action:context.npc_id==='npc_lin'?{type:'CONSUME_ITEM',target_id:'qa_other_bread',reason:'按世界规则消耗本人持有物',quantity:1}:null,evidence_refs:[],belief_updates:[],goal_updates:[],goal_proposals:[],plan_proposals:[],decision_summary:'固定离线本人决定',social_response:null};});
  const originalNarrate=ai.narrate.bind(ai);vi.spyOn(ai,'narrate').mockRejectedValueOnce(Error('interrupt after autonomous pending image')).mockImplementation(originalNarrate);
  const service=new GameService(store,ai,save.definition),before=await service.current(),body={game_id:before.game_id,expected_revision:before.state_revision,request_id:randomUUID(),input:'吃掉一份面包，再吃掉一份面包'},steps=['吃掉一份面包','吃掉一份面包'];
  const bytes=await readFile(join(directory,'current.json'));await expect(service.turn(body,undefined,undefined,undefined,false,undefined,steps)).rejects.toThrow();
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const pending=await store.readPending(body.request_id);expect(quantity(pending!.candidate)).toBe(1);expect(quantity(pending!.candidate,'qa_other_bread','npc_lin')).toBe(1);
  const decisions=decide.mock.calls.length,execute=vi.spyOn(core,'executeAction'),fresh=new GameService(new JsonStore(directory),ai,save.definition);
  let response:unknown;try{response=await fresh.turn(body);}catch(error){response={error:String(error)};}
  const after=await fresh.current();await writeFile(`.agent-runtime/codex/consumption-autonomous-pending-${run}-${kind}-${fallback}.json`,JSON.stringify({body,before,pending,response,after,prompts},null,2));
  expect(response).not.toHaveProperty('error');expect(quantity(after)).toBe(1);expect(quantity(after,'qa_other_bread','npc_lin')).toBe(1);
  if(fallback){expect(after.last_turn!.narrative).toContain('林舟吃掉了1份面包。');expect(after.last_turn!.presentation!.status).toBe('degraded');}else{expect(after.last_turn!.narrative).toBe(text);expect(after.last_turn!.presentation!.status).toBe('normal');}expect(decide).toHaveBeenCalledTimes(decisions);expect(execute).not.toHaveBeenCalled();
  expect(after.runtime.time.minute).toBe(before.runtime.time.minute+180);expect(after.state_revision).toBe(before.state_revision+1);
  const committed=await readFile(join(directory,'current.json')),calls=ai.metrics.requests;await new GameService(new JsonStore(directory),ai,save.definition).turn(body);
  expect(await readFile(join(directory,'current.json'))).toEqual(committed);expect(ai.metrics.requests).toBe(calls);
 }finally{await rm(directory,{recursive:true,force:true});}
},90000);
