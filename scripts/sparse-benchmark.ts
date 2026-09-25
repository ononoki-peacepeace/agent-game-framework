import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {sparseSetup,sparseWorld} from '../tests/sparse-fixture.js';
import {RoutineJobs} from '../src/routine/jobs.js';
import {CodexAdapter} from '../src/ai/codex.js';
import {AIRuntime} from '../src/ai/runtime.js';
import {GameService} from '../src/server/service.js';
import {JsonStore} from '../src/storage/json-store.js';
const real=process.argv.includes('--codex');
const directory='.tmp/sparse-benchmark-'+Date.now();await mkdir(directory,{recursive:true});
const service=real?new GameService(new JsonStore(directory),new AIRuntime(new CodexAdapter(directory+'/ai-work')),sparseWorld()):(await sparseSetup()).service;
if(real)await service.newGame();const jobs=new RoutineJobs(service,directory);
async function run(type:string,days:number){const save=await service.current(),begin=performance.now();const job=await jobs.start({request_id:randomUUID(),game_id:save.game_id,expected_revision:save.state_revision,max_days:days,action:{type,parameters:type==='START_ROUTINE'?{label:'普通日常基准',pattern:'每天00:00开始在广场睡眠8小时；09:00在车站固定课程3小时；13:00在车站固定训练2小时；16:00在车站固定兼职2小时。活动之间按现有路线移动及等待，其余时间等待。每天重复全部四项。仅采用活动目录的四项规则，不另加早餐、社交或其他活动；遇到重要事件暂停。'}:{}}});
for(;;){const current=(await jobs.get(job.job_id))!;if(!['queued','running'].includes(current.status)){const report={status:current.status,message:current.message,steps:current.steps,wall_ms:Math.round(performance.now()-begin),...current.metrics};if(current.status!=='completed')throw Error(JSON.stringify(report));return report;}await new Promise(r=>setTimeout(r,10));}}
console.log('Benchmark started; isolated authored public fixture; real Codex:',real);
const day=await run('START_ROUTINE',1),week=await run('CONTINUE_ROUTINE',7);const result={real_codex:real,fixture:'public authored rules, no random events',day,week,time:(await service.current()).runtime.time};await writeFile(directory+'/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));console.log('REPORT '+directory+'/report.json');
