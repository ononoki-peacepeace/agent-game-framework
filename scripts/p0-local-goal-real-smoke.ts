import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from '../tests/sparse-fixture.js';
import {handleAgentInput} from '../src/agent/executor.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('DeepSeek provider is not configured');
const root=await mkdtemp(join(tmpdir(),'agf-p0-local-goal-'));
try{
  const world=sparseWorld();
  const player=world.entities.find(entity=>entity.id===world.player.entity_id)!;
  player.components.scene_position={label:'厨房'};
  const here=player.components.location!.location_id;
  const location=world.map?.locations.find(place=>place.id===here);
  if(location)location.name='测试公寓';
  world.entities.push(
    {id:'qa_desk',type:'object',components:{identity:{name:'书桌',description:'可供写作业的书桌',avatar_id:null},location:{location_id:here}}},
    {id:'qa_homework',type:'item',components:{identity:{name:'作业本',description:'下一页尚未写完',avatar_id:null},location:{location_id:here},item:{weight:0.3,stackable:false}}},
  );
  const provider=new AIProviderManager(root,config);
  const service=new GameService(new JsonStore(join(root,'save')),new AIRuntime(provider),world);
  await service.newGame();
  const before=await service.current(),input='回到书桌前，把作业本下一页写完',requestId=randomUUID();
  const result=await handleAgentInput(service,{request_id:requestId,game_id:before.game_id,expected_revision:before.state_revision,input});
  const after=await service.current(),receipt=after.resolution_receipts?.at(-1);
  const facts=after.action_facts?.at(-1)?.facts??[];
  const position=after.entities.find(entity=>entity.id===after.player_state.entity_id)?.components.scene_position?.label;
  const checks={committed:after.state_revision===before.state_revision+1,
    local_position:position==='书桌前',position_receipt:receipt?.effects.includes('position')??false,
    activity_receipt:receipt?.effects.includes('progress')??false,
    activity_fact:facts.some(fact=>fact.includes('已完成玩家目标：')),
    narrative_visible:Boolean(/书桌|桌前|桌边/.test(after.last_turn?.narrative??'')&&
      /作业|下一页|那一页|一页/.test(after.last_turn?.narrative??'')),
    no_placeholder:after.last_turn?.narrative!=='这次尝试已完成。',
    no_false_handoff:result.plan?.status==='completed'&&result.presentation==='story'};
  console.log(JSON.stringify({provider:'deepseek',checks,plan_status:result.plan?.status??null,
    receipt_kind:receipt?.kind??null,effects:receipt?.effects??[],revision_before:before.state_revision,revision_after:after.state_revision,
    goal_results:checks.committed?undefined:result.plan?.goals.map(goal=>({type:goal.type,status:goal.status,summary:goal.result?.summary?.slice(0,180)})),
    narrative_excerpt:checks.narrative_visible?undefined:after.last_turn?.narrative.slice(0,400)}));
  if(Object.values(checks).some(value=>!value))process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}
