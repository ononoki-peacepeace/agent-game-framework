// Uses a fictional fixture; no formal save contents are read or sent to the provider.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readPersistedProviderConfig,AIProviderManager} from '../src/ai/providers.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from '../tests/sparse-fixture.js';
import {newSave} from '../src/core/state.js';
import {handleAgentInput} from '../src/agent/executor.js';
import {StructuredLogger} from '../src/observability/logger.js';
import type {Inventory} from '../src/modules/inventory.js';

const config=await readPersistedProviderConfig(resolve('data'));
if(config?.provider!=='deepseek')throw Error('DeepSeek provider unavailable');
const root=await mkdtemp(join(tmpdir(),'agf-p0-choice-'));
try{
  const store=new JsonStore(join(root,'save'));
  const world=sparseWorld(),fixturePlayer=world.entities.find(entity=>entity.id===world.player.entity_id)!;
  // The stock demo's unrelated shop notebook would otherwise be a misleading near-name match
  // for this fictional unregistered 作业本. Keep the fixture focused on the reported state shape.
  world.entities=world.entities.filter(entity=>entity.id!=='notebook');
  for(const entity of world.entities){
    const shop=entity.components.shop as {stock?:Record<string,number>;prices?:Record<string,{buy:number;sell:number}>}|undefined;
    if(shop?.stock)delete shop.stock.notebook;
    if(shop?.prices)delete shop.prices.notebook;
  }
  fixturePlayer.components.scene_position={label:'书桌前'};
  const here=fixturePlayer.components.location!.location_id;
  const location=world.map?.locations.find(place=>place.id===here);
  if(location)location.name='测试公寓';
  const save=newSave(world);
  save.last_turn={narrative:'你在书桌前写完作业本的一页，笔还放在桌上。',speaker:null,dialogue:null,
    choices:['合上作业本收进书包，准备出门'],context_actions:[]};
  await store.write(save);
  const ai=new AIRuntime(new AIProviderManager(root,config));
  const originalFreeform=ai.freeform.bind(ai);
  ai.freeform=async(save,input)=>{const proposal=await originalFreeform(save,input);
    console.log(JSON.stringify({stage:'proposal',storage_move:proposal.storage_move??null,item_move:proposal.item_move??null,
      required_conditions:proposal.required_conditions??[],completion_quote:proposal.completion_quote??null,
      resolution:proposal.resolution?.type??null}));return proposal;};
  const logger=new StructuredLogger({directory:null});
  const service=new GameService(store,ai,world,[],logger);
  const before=await service.current(),input='合上作业本收进书包，准备出门';
  const result=await handleAgentInput(service,{request_id:randomUUID(),game_id:before.game_id,expected_revision:before.state_revision,input});
  const after=await service.current(),receipt=after.resolution_receipts?.at(-1);
  const player=after.entities.find(entity=>entity.id===after.player_state.entity_id)!;
  const item=after.entities.find(entity=>entity.components.item&&entity.components.identity?.name==='作业本');
  const bag=after.entities.find(entity=>entity.components.item&&entity.components.identity?.name==='书包');
  const inventory=player.components.inventory as Inventory|undefined;
  const checks={committed:after.state_revision===before.state_revision+1,
    full_goal:receipt?.semantic_action===input,
    item_nested:Boolean(item&&bag&&inventory?.items[item.id]===1&&inventory?.items[bag.id]===1&&inventory?.placements?.[item.id]===bag.id),
    inventory_receipt:receipt?.effects.includes('inventory')??false,
    preparation_receipt:receipt?.effects.includes('progress')??false,
    preparation_fact:after.action_facts?.at(-1)?.facts.some(fact=>fact.includes('准备出门'))??false,
    still_inside:player.components.scene_position?.label==='书桌前',
    narrative_visible:Boolean(after.last_turn?.narrative&&/作业本|本子/.test(after.last_turn.narrative)&&/书包|包里/.test(after.last_turn.narrative)),
    no_placeholder:after.last_turn?.narrative!=='这次尝试已完成。',
    no_false_handoff:result.plan?.status==='completed'&&result.presentation==='story'};
  console.log(JSON.stringify({provider:'deepseek',revision_before:before.state_revision,revision_after:after.state_revision,
    checks,effects:receipt?.effects??[],plan_status:result.plan?.status??null,
    failed_goals:result.plan?.goals.filter(goal=>goal.status==='failed').map(goal=>({type:goal.type,normalized_goal:goal.normalized_goal,summary:goal.result?.summary.slice(0,160)}))??[]}));
  if(Object.values(checks).some(value=>!value))console.log(JSON.stringify({stage:'failure_events',entries:logger.entries({level:'warn'}).slice(-5).map(entry=>({event:entry.event,metadata:entry.metadata}))}));
  if(Object.values(checks).some(value=>!value))process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}
