import {afterEach,describe,expect,it} from 'vitest';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {createApp} from '../src/server/app.js';
import {JsonStore} from '../src/storage/json-store.js';
import {sparseWorld} from './sparse-fixture.js';

const input='我从座椅上起身，走到配给柜前，查看里面有哪些商品、各自的价格，以及有没有人在值班。';
const steps=['我从座椅上起身','走到配给柜前','查看里面有哪些商品、各自的价格，以及有没有人在值班。'];
const resources:{directory:string;server:Server}[]=[];
afterEach(async()=>{
  for(const {directory,server} of resources.splice(0)){
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});

describe('QA-03 compound local movement and shop observation over HTTP',()=>{
  it('preserves all clauses despite a mistaken single-perception Semantic tag and replays once',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agf-qa03-http-'));
    const calls:string[]=[];
    const ai=new AIRuntime({name:'qa03-isolated',generate:async request=>{
      const properties=(request.schema as {properties?:Record<string,unknown>}).properties??{};
      if(properties.interaction_lane){
        calls.push('semantic');
        return {data:{domain:'world',kind:'world_action',operation_plane:'play',confidence:.99,
          answer:null,answer_basis:null,evidence_ids:[],clarification:null,speech_target_id:null,
          interaction_lane:'world_transaction',player_speech_mode:'none',
          goal_spec:{objective:input,play_action:'perceive',targets:[],
            desired_state:[],desired_outputs:[],constraints:[],persistence:'none',
            temporal:{at:null,recurrence:null},dependencies:[],world_mutation:true,
            external_artifact:false,multi_step:false,ambiguity:null}}} as never;
      }
      if(properties.goals){
        calls.push('plan');
        return {data:{goals:steps.map((step,index)=>({goal_id:'g'+index,
          type:'WORLD_ACTION',normalized_goal:step,target_entities:[],
          depends_on:index?['g'+(index-1)]:[],condition:null,branch:null,
          temporal_scope:{scope:'now',day_offset:0,window:'any'}}))}} as never;
      }
      if(properties.verdict)return {data:{verdict:'aligned',explanation:'三个原始动作均已保留'}} as never;
      if(properties.parameters_json)return {data:{type:'FREEFORM_ACTION',target_id:null,
        parameters_json:'{}',clarification:null}} as never;
      if(properties.resolution)return {data:{narrative:'程序候选',minutes:2,target_id:null,
        facts:[],relationship:null,item_move:null,storage_move:null,completion_quote:null,
        required_conditions:[],resolution:{type:'DETERMINISTIC',domain:'general',band:'normal',
          visibility:'public',stakes:'普通局部行动',stages:[],evidence_ids:[]}}} as never;
      if(request.role==='narrator'){
        calls.push('narrator');
        expect(request.prompt).toContain('"buy":37');
        return {data:{narrative:'你起身走到配给柜前。柜内有面包，标价 37。值班情况尚未确认。',
          speaker:null,dialogue:null,choices:[],context_actions:[],patches:[],
          interaction:null,item_claims:[],stable_locations:[],mechanical_claims:[]}} as never;
      }
      throw Error('Unexpected isolated stage '+Object.keys(properties).join(','));
    }});
    const store=new JsonStore(directory),service=new GameService(store,ai,sparseWorld());
    await service.newGame();
    const before=await service.current();
    const actor=before.entities.find(entity=>entity.id===before.player_state.entity_id)!;
    const here=String(actor.components.location!.location_id);
    actor.components.scene_position={label:'座椅'};
    const shop=before.entities.find(entity=>entity.components.shop)!;
    shop.components.identity!.name='配给柜';
    shop.components.location={location_id:here};
    (shop.components.shop as {prices:Record<string,{buy:number;sell:number}>}).prices.bread.buy=37;
    before.definition.map!.locations.find(location=>location.id===here)!.description+=' 房间一侧有配给柜。';
    await store.write(before);
    const server=createApp(service).listen(0,'127.0.0.1');resources.push({directory,server});
    await once(server,'listening');
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const {token}=await (await fetch(base+'/api/session')).json() as {token:string};
    const body={input,request_id:randomUUID(),game_id:before.game_id,
      expected_revision:before.state_revision};
    const post=()=>fetch(base+'/api/input',{method:'POST',headers:{
      'Content-Type':'application/json','X-Game-Token':token},body:JSON.stringify(body)});
    const response=await post(),result=await response.json() as {
      outcome:{type:string;kind:string};message:string};
    const after=await service.current();
    expect(response.status,JSON.stringify(result)).toBe(200);
    expect(result.outcome).toMatchObject({type:'game',kind:'completed'});
    expect(result.message).toContain('37');
    expect(after.state_revision).toBe(before.state_revision+1);
    expect(after.entities.find(entity=>entity.id===actor.id)?.components.scene_position?.label)
      .toBe('配给柜前');
    expect(after.resolution_receipts?.slice(-4).map(receipt=>receipt.commit_status))
      .toEqual(['committed','committed','committed','committed']);
    expect(after.resolution_receipts?.at(-1)?.effects).toEqual(expect.arrayContaining(['position','activity']));
    expect(calls.filter(stage=>stage==='plan')).toHaveLength(1);
    expect(calls.filter(stage=>stage==='narrator')).toHaveLength(1);
    const replay=await post();
    expect(replay.status).toBe(200);
    expect((await service.current()).state_revision).toBe(after.state_revision);
    expect(calls.filter(stage=>stage==='narrator')).toHaveLength(1);
  });
});
