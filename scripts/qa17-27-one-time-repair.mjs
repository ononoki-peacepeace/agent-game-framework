// Explicitly authorized one-time maintenance. No server startup, model calls,
// direct JSON state edits, stale-lock deletion, or automatic rollback.
import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import assert from 'node:assert/strict';
import net from 'node:net';
import {GameService} from '../dist/server/server/service.js';
import {JsonStore} from '../dist/server/storage/json-store.js';
import {AIRuntime} from '../dist/server/ai/runtime.js';
import {validateSave} from '../dist/server/core/state.js';
import {canUndo,worldImage} from '../dist/server/core/turn-history.js';
import {StructuredLogger,configureDefaultLogger} from '../dist/server/observability/logger.js';

const root=resolve(import.meta.dirname,'..'),directory=join(root,'data');
const lockPath=join(directory,'runtime.lock'),currentPath=join(directory,'current.json');
const candidatePath=join(root,'docs','qa17-27-region-repair-candidate.json');
const apply=process.argv.slice(2).length===1&&process.argv[2]==='--apply';
assert(apply||process.argv.length===2,'Only --apply or read-only rehearsal is supported');
const digest=b=>createHash('sha256').update(b).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value));
async function requireStopped(){
  try{process.kill(19380,0);throw Error('Original service PID is still alive');}
  catch(error){if(error.code!=='ESRCH')throw error;}
  await new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port:3100});
    socket.setTimeout(1500);
    socket.once('connect',()=>{socket.destroy();reject(Error('3100 is listening; maintenance refused'));});
    socket.once('timeout',()=>{socket.destroy();reject(Error('Cannot conclusively verify port is closed'));});
    socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?resolve():reject(error);});
  });
}
await requireStopped();
const lock=await open(lockPath,'wx'); // Same startup exclusion as server/index.
await lock.writeFile(String(process.pid));await lock.sync();
let auditDirectory=null,logger=null,committed=false;
try{
  await requireStopped();
  const rawBytes=await readFile(currentPath),before=JSON.parse(rawBytes.toString('utf8'));
  const candidate=JSON.parse(await readFile(candidatePath,'utf8'));
  const pre=candidate.preconditions,change=candidate.changes[0];
  assert.equal(candidate.status,'proposal_only_not_applied');assert.equal(candidate.changes.length,1);
  assert.equal(change.operation,'remove_component');assert.equal(change.entity_id,'pc_asano');assert.equal(change.component,'scene_position');
  assert.equal(digest(rawBytes),pre.sha256,'Candidate SHA256 mismatch');
  assert.equal(before.state_revision,349);assert.equal(before.state_revision,pre.revision);
  assert(equal(before.runtime.time,{day:1,minute:936}));assert(equal(before.runtime.time,pre.time));
  assert.equal(before.player_state.entity_id,pre.entity_id);
  const players=before.entities.filter(e=>e.id==='pc_asano');assert.equal(players.length,1);
  assert(equal(players[0].components.location,pre.location));assert.equal(pre.location.location_id,'hall_great');
  assert(equal(Object.keys(players[0].components.scene_position),['label']),'Unexpected scene_position fields');
  assert(equal(players[0].components.scene_position,change.expected_value),'Component differs from candidate');
  assert.equal(change.expected_value.label,'中央大厅一侧的长椅坐下');
  assert.equal(before.turn_checkpoint.turn_id,change.evidence.prior_turn);
  assert.equal(before.turn_checkpoint.before.entities.find(e=>e.id==='pc_asano').components.scene_position,undefined);
  validateSave(structuredClone(before)); // Full existing schema, before backup/write.
  const installed=await readFile(join(directory,'world-packages.json'),'utf8')
    .then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const requestId=randomUUID();
  const request={game_id:before.game_id,expected_revision:349,request_id:requestId};
  const operation={kind:'qa17_27_one_time_scene_position_repair',candidate_sha256:pre.sha256,entity_id:'pc_asano',component:'scene_position'};
  const fingerprint=digest(JSON.stringify({agent_operation:operation}));
  const mutation=save=>{
    const actor=save.entities.find(e=>e.id==='pc_asano');
    assert(equal(actor.components.scene_position,change.expected_value));
    assert(equal(Object.keys(actor.components.scene_position),['label']));
    delete actor.components.scene_position;
  };
  function verifyOnlyAuthorizedChanges(value){
    const after=plain(value),expected=structuredClone(before);
    delete expected.entities.find(e=>e.id==='pc_asano').components.scene_position;
    assert.equal(after.state_revision,350);
    const receipt={id:requestId,fingerprint,revision:350};
    assert(equal(after.runtime.receipts,[...before.runtime.receipts,receipt].slice(-100)),'Unexpected receipts');
    assert.equal(after.active_turn_id,requestId);
    assert.equal(after.turn_checkpoint.turn_id,requestId);
    assert(equal(after.turn_checkpoint.before,worldImage(before)),'Checkpoint did not preserve pre-repair world');
    assert.equal(after.turn_checkpoint.parent_turn_id,before.active_turn_id??null);
    assert(canUndo(after),'Checkpoint/hash inconsistent');
    assert(equal(after.turn_history.slice(0,-1),(before.turn_history??[]).slice(-19)),'Historical entries changed');
    const newHistory=after.turn_history.at(-1),{label,time,...historyCheckpoint}=newHistory;
    assert(equal(historyCheckpoint,after.turn_checkpoint));assert(equal(time,before.runtime.time));
    for(const key of ['state_revision','active_turn_id','turn_checkpoint','turn_history'])expected[key]=after[key];
    expected.runtime.receipts=after.runtime.receipts;
    assert(equal(after,expected),'Unauthorized semantic or metadata difference');
    return receipt;
  }
  const offlineAI=new AIRuntime({name:'maintenance-no-network',generate:async()=>{throw Error('Model calls forbidden during repair');}});
  // Rehearse the actual existing transaction against memory. Any automatic
  // migration or any extra mutation fails the strict write guard before disk.
  let memory=structuredClone(before),rehearsalWrites=0;
  const memoryStore={read:async()=>structuredClone(memory),write:async save=>{
    verifyOnlyAuthorizedChanges(save);memory=plain(save);rehearsalWrites++;
  }};
  const rehearsal=new GameService(memoryStore,offlineAI,before.definition,installed);
  await rehearsal.agentTransaction(request,operation,mutation);
  assert.equal(rehearsalWrites,1);verifyOnlyAuthorizedChanges(memory);assert.equal(offlineAI.metrics.requests,0);
  if(!apply){console.log(JSON.stringify({status:'rehearsal_passed',revision_before:349,revision_after:350,formal_save_modified:false}));}
  else{
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    auditDirectory=join(directory,'maintenance',`qa17-27-${stamp}-${requestId}`);
    await mkdir(auditDirectory,{recursive:true});
    const backupPath=join(auditDirectory,'before.current.json');
    const backupFile=await open(backupPath,'wx');
    try{await backupFile.writeFile(rawBytes);await backupFile.sync();}finally{await backupFile.close();}
    const backupBytes=await readFile(backupPath);
    assert.equal(digest(backupBytes),pre.sha256);assert(equal(JSON.parse(backupBytes.toString('utf8')),before));
    validateSave(JSON.parse(backupBytes.toString('utf8')));
    const manifest={status:'backup_verified_before_commit',request_id:requestId,operation,backup_path:backupPath,
      sha256_before:pre.sha256,revision_before:349,revision_after:350,authorized_change:change};
    const manifestPath=join(auditDirectory,'manifest.json');
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    logger=configureDefaultLogger(new StructuredLogger({directory:join(auditDirectory,'logs'),level:'info'}));
    const disk=new JsonStore(directory);let writes=0;
    const guardedStore={read:(...args)=>disk.read(...args),readGlobalGuidance:()=>disk.readGlobalGuidance(),
      write:async save=>{
        assert.equal(writes,0,'Only one authorized write is permitted');
        verifyOnlyAuthorizedChanges(save);await requireStopped();
        assert.equal(await readFile(lockPath,'utf8'),String(process.pid),'Lost maintenance ownership');
        assert.equal(digest(await readFile(currentPath)),pre.sha256,'Save changed concurrently');
        writes++;await disk.write(save);committed=true;
      }};
    const service=new GameService(guardedStore,offlineAI,before.definition,installed,logger);
    await service.agentTransaction(request,operation,mutation);
    assert.equal(writes,1);
    const afterBytes=await readFile(currentPath),after=JSON.parse(afterBytes.toString('utf8'));
    const receipt=verifyOnlyAuthorizedChanges(after);validateSave(structuredClone(after));
    const reloadStore=new JsonStore(directory),reload=new GameService({read:(...args)=>reloadStore.read(...args),
      readGlobalGuidance:()=>reloadStore.readGlobalGuidance(),write:async()=>{throw Error('Reload must not migrate or write');}},offlineAI,before.definition,installed,logger);
    const reloaded=await reload.current();assert(equal(plain(reloaded),after),'Reload changed state');
    const view=reload.project(reloaded),player=view.entities.find(e=>e.id==='pc_asano');
    assert.equal(player.components.scene_position,undefined);assert.equal(player.components.location.location_id,'hall_great');
    assert.equal(view.locations.find(p=>p.id==='hall_great').name,'中央大厅');
    assert.equal(offlineAI.metrics.requests,0);await requireStopped();
    const result={status:'committed_and_verified',backup_path:backupPath,manifest_path:manifestPath,
      revision_before:349,revision_after:350,receipt,sha256_before:pre.sha256,sha256_after:digest(afterBytes),
      semantic_changes:['entities[id=pc_asano].components.scene_position: removed'],
      transaction_metadata:['state_revision','runtime.receipts','active_turn_id','turn_checkpoint','turn_history'],
      time:after.runtime.time,location_id:player.components.location.location_id,location_name:'中央大厅',
      scene_position_present:false,undo_checkpoint_valid:canUndo(after),backup_read_verified:true,reload_verified:true,
      other_semantic_changes:false,model_calls:0,server_started:false};
    await writeFile(manifestPath,JSON.stringify({...manifest,...result},null,2)+'\n');
    console.log(JSON.stringify(result));
  }
}catch(error){
  console.error(JSON.stringify({status:'stopped',committed,backup_directory:auditDirectory,error:error.message,
    note:'No automatic retry or rollback. Inspect authoritative state before any next step.'}));process.exitCode=1;
}finally{
  await logger?.flush();await lock.close();
  if(await readFile(lockPath,'utf8')===String(process.pid))await unlink(lockPath);
  else{console.error('Lock ownership changed; lock was not removed');process.exitCode=1;}
}
