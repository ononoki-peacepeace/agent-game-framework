import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {sparseSetup} from '../tests/sparse-fixture.js';
import {ExtensionHost} from '../src/extensions/host.js';
import {ExtensionDevelopment} from '../src/extensions/development.js';
const directory=resolve('.tmp/extension-codex-'+Date.now());await mkdir(directory,{recursive:true});
async function hashTree(dir:string):Promise<string>{const hash=createHash('sha256');for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){hash.update(entry.name);hash.update(entry.isDirectory()?await hashTree(join(dir,entry.name)):await readFile(join(dir,entry.name)));}return hash.digest('hex');}
const before=await hashTree('src'),fixture=await sparseSetup(),state=await fixture.service.current();
const dev=new ExtensionDevelopment(new ExtensionHost(fixture.service,directory));
await dev.start({request_id:randomUUID(),request:'生成桌面和手机可用的简化21点配置。不允许下注。名称使用中文。',extension_id:'blackjack',template:'blackjack',allow_betting:false,use_codex:true});
let job=await dev.get();
for(let i=0;i<110&&job&&['queued','running'].includes(job.status);i++){await new Promise(r=>setTimeout(r,2000));job=await dev.get();}
assert.equal(await hashTree('src'),before,'core source changed');assert.deepEqual(await fixture.service.current(),state,'canonical state changed before install');
await writeFile(join(directory,'result.json'),JSON.stringify({status:job?.status,message:job?.message,core_unchanged:true,state_unchanged:true,installed:false,workspace:job?.workspace},null,2));
console.log(JSON.stringify({status:job?.status,message:job?.message,directory}));if(job?.status!=='ready')process.exitCode=1;
