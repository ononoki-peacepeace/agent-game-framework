import {randomUUID} from 'node:crypto';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {RoutineJobs} from '../src/routine/jobs.js';

const {service,calls}=await sparseSetup();
const jobs=new RoutineJobs(service);
async function finish(id:string){
  for(let i=0;i<2000;i++){
    const job=await jobs.get(id);
    if(job&&!['queued','running'].includes(job.status))return job;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw Error('routine job did not finish');
}
async function run(type:'START_ROUTINE'|'CONTINUE_ROUTINE',max_days?:number){
  const save=await service.current(),started=performance.now();
  const request={request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,
    action:{type,parameters:type==='START_ROUTINE'?{label:'正常生活',pattern:'每天睡眠、上课、训练和固定兼职'}:{}},
    ...(max_days?{max_days}:{})};
  const job=await finish((await jobs.start(request)).job_id);
  return {status:job.status,elapsed_ms:Math.round(performance.now()-started),metrics:job.metrics};
}
const day=await run('START_ROUTINE');
const week=await run('CONTINUE_ROUTINE',7);
console.log(JSON.stringify({day,week,total_ms:day.elapsed_ms+week.elapsed_ms,
  compiler_calls:calls.filter(call=>call.role==='routine_compiler').length,
  npc_decision_calls:calls.filter(call=>call.role==='npc_decision').length}));
