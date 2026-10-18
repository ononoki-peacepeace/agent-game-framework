import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {AIRuntime} from '../src/ai/runtime.js';
import {AIProviderManager,readPersistedProviderConfig} from '../src/ai/providers.js';
import {readProfile} from '../src/ai/profiles.js';
import {JsonStore} from '../src/storage/json-store.js';
import {GameService} from '../src/server/service.js';
import {StructuredLogger,configureDefaultLogger} from '../src/observability/index.js';
import {demo} from '../tests/helpers.js';
import {initialNpcRequirement} from '../src/ai/world-initializer-repair.js';
import {publicView,validateSave} from '../src/core/state.js';

const directory=resolve(`.tmp/world-thirteen-${Date.now()}`);
await mkdir(directory,{recursive:true});
const source=process.env.WORLD_PROMPT_FILE;
const description=source?new TextDecoder('utf-8',{fatal:true}).decode(await readFile(source)):
  '请创建雾钟馆中的可持续悬疑生存世界。开局总共13名参与者：玩家1名、拥有独立身份、人格、社会动机和不同背景的NPC12名。预先确定其中两名NPC为秘密协力者，在隐藏事实中固定两人的身份和合作关系，但开场不得向玩家公开。玩家可通过场景证据逐步发现。雾钟馆有馆外、馆内区域与房间的合法分层地图及通行路线。每名NPC有独立目标，后台事件基于动机、资源和时间独立发展；不保证玩家成功，也不设定固定胜利路线。初始全部12名NPC必须真实创建，不得只生成开场可见人物。';
const prompt_sha256=createHash('sha256').update(description,'utf8').digest('hex');
const expected_npc_count=initialNpcRequirement(description);
if(source&&expected_npc_count===null)throw new Error('原始提示词人数约束未被初始化器识别');
const config=await readPersistedProviderConfig('data');
if(!config||config.provider==='mock')throw new Error('未找到真实 Provider 配置');
const logger=configureDefaultLogger(new StructuredLogger({directory:resolve(directory,'logs'),level:'debug',history:3000}));
const ai=new AIRuntime(new AIProviderManager(directory,config));
const store=new JsonStore(directory),service=new GameService(store,ai,demo);
const started=performance.now();
try{
  const view=await service.newGame(description,undefined,await readProfile('content/profiles/default.json'));
  const save=await store.read();
  if(!save)throw new Error('创建请求成功但隔离存储中没有世界');
  validateSave(save);
  const npc=save.entities.filter(entity=>entity.id!==save.player_state.entity_id&&!!entity.components.character);
  if(npc.length!==(expected_npc_count??12))throw new Error(`实际 NPC 数量 ${npc.length}，要求${expected_npc_count??12}`);
  const reopened=new JsonStore(directory);
  const reloaded=await reopened.read();
  if(reloaded?.game_id!==save.game_id)throw new Error('重新加载失败');
  const publicText=JSON.stringify(publicView(reloaded));
  const hiddenStatements=save.gm_state.hidden_truth?.commitments.map(truth=>truth.statement)??[];
  const hiddenStatementLeaked=hiddenStatements.some(statement=>statement.length>25&&publicText.includes(statement));
  if(hiddenStatementLeaked)throw new Error('GM 隐藏事实全文泄漏到玩家视图');
  const profileFields=['personality','speech_style','motivations','fears','values','behavior_tendencies','emotional_patterns','example_dialogues'] as const;
  const profileCoverage=Object.fromEntries(profileFields.map(field=>[field,npc.filter(entity=>{
    const value=(entity.components.character as Record<string,unknown>)[field];
    return typeof value==='string'?value.trim().length>0:Array.isArray(value)&&value.length>0;
  }).length]));
  const report={status:'passed',source:source??'representative',directory,provider:config.provider,model:'model' in config?config.model:null,
    prompt_chars:description.length,prompt_sha256,expected_npc_count,duration_ms:Math.round(performance.now()-started),game_id:view.game_id,revision:view.revision,npc_count:npc.length,
    schema_valid:true,reload_valid:true,hidden_statement_leaked:hiddenStatementLeaked,profile_coverage:profileCoverage,
    personae:npc.filter(entity=>{const character=entity.components.character as {personality?:string;behavior_tendencies?:string[]}|undefined;return Boolean(character?.personality||character?.behavior_tendencies?.length);}).length,
    relationship_edges:save.entities.reduce((sum,entity)=>sum+Object.keys((entity.components.relationships as {entries?:Record<string,unknown>}|undefined)?.entries??{}).length,0),
    locations:save.definition.map?.locations.length??0,routes:save.definition.map?.routes.length??0,
    hidden_truths:save.gm_state.hidden_truth?.commitments.length??0,background_incidents:save.definition.background_incidents?.length??0,
    stages:logger.entries({eventPrefix:'world_init.'}).map(entry=>({event:entry.event,duration_ms:entry.duration_ms,metadata:entry.metadata})),
    usage:{input_tokens:ai.metrics.input_tokens,output_tokens:ai.metrics.output_tokens,requests:ai.metrics.requests}};
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}catch(error){
  const report={status:'failed',source:source??'representative',directory,prompt_chars:description.length,prompt_sha256,expected_npc_count,
    duration_ms:Math.round(performance.now()-started),reason:error instanceof Error?error.message:String(error),
    stages:logger.entries({eventPrefix:'world_init.'}).map(entry=>({event:entry.event,duration_ms:entry.duration_ms,metadata:entry.metadata})),
    usage:{input_tokens:ai.metrics.input_tokens,output_tokens:ai.metrics.output_tokens,requests:ai.metrics.requests}};
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));
  console.error(JSON.stringify(report));process.exitCode=1;
}
