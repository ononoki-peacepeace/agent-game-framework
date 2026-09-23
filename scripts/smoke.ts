import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const dir=await mkdtemp(resolve('.tmp-smoke-'));
const port=3200+Math.floor(Math.random()*500), base='http://127.0.0.1:'+port;
let child:ReturnType<typeof fork>;
async function start(){
 child=fork(resolve('dist/server/server/index.js'),[],{env:{...process.env,AI_ADAPTER:'mock',GAME_DATA_DIR:dir,PORT:String(port),GAME_WORLD_FILE:resolve('content/worlds/town.json'),PROMPT_PROFILE_PATH:resolve('content/profiles/default.json')},stdio:['ignore','pipe','pipe','ipc']});
 let stderr='',started=false;child.stderr!.on('data',b=>{stderr+=b;});child.stdout!.on('data',b=>{if(String(b).includes(base))started=true;});
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(stderr);try{if(started&&(await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('server startup timeout');
}
async function stop(){const exit=once(child,'exit');child.send('shutdown');await exit;}
let token='';
async function api(path:string,body?:unknown){const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Game-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200,await r.clone().text());return r.json();}
try{
 await start();token=(await api('session')).token;assert.equal((await fetch(base)).status,200);
 let v=await api('new',{});
 async function action(type:string,parameters={},target_id?:string){v=await api('action',{request_id:randomUUID(),game_id:v.game_id,expected_revision:v.revision,action:{type,parameters,...(target_id?{target_id}:{})}});}
 await action('TALK',{topic:'hello'},'npc_lin');await action('MOVE',{},'market');await action('BUY',{item_id:'water',quantity:2},'corner_shop');await action('SELL',{item_id:'water',quantity:1},'corner_shop');await action('WAIT',{minutes:10});
 assert.equal(v.entities.find((e:{id:string})=>e.id==='player').components.wallet.balances.credit,91);
 await api('save',{});const exported=await api('export',{});assert(exported.gm_state);
 assert(!JSON.stringify(await api('state')).includes('GM_PRIVATE_CANARY'));
 const revision=v.revision;await stop();await start();token=(await api('session')).token;
 assert.equal((await api('state')).revision,revision);v=await api('import',exported);assert.equal(v.revision,revision);
 await action('CHECK');assert.equal(v.revision,revision+1);v=await api('load',{});assert.equal(v.revision,revision);
 console.log('HTTP SMOKE PASS: built app, TALK/MOVE/BUY/SELL/WAIT/CHECK, export/import/checkpoint, real process restart, hidden-state isolation.');
}finally{if(child! && child.exitCode===null)await stop();await rm(dir,{recursive:true,force:true});}
