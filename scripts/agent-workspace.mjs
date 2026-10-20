import {mkdir,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join,basename} from 'node:path';
import {spawn} from 'node:child_process';

const [role,action,...args]=process.argv.slice(2);
const profiles={codex:{directory:'game',server:3111,client:5181},claude:{directory:'game-claude',server:3112,client:5182}};
const profile=profiles[role];
if(!profile||!['check','test','build','server','client'].includes(action))throw Error('Usage: node scripts/agent-workspace.mjs codex|claude check|test|build|server|client [arguments]');
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
if(basename(root).toLowerCase()!==profile.directory)throw Error(`Profile ${role} requires a checkout named ${profile.directory}; refusing to use another agent workspace.`);
const runtime=join(root,'.agent-runtime',role),data=join(runtime,'data'),logs=join(runtime,'logs'),temporary=join(runtime,'tmp');
await Promise.all([data,logs,temporary].map(path=>mkdir(path,{recursive:true})));
const env={...process.env,GAME_DATA_DIR:data,GAME_LOG_DIR:logs,TMP:temporary,TEMP:temporary,TMPDIR:temporary,
  PORT:String(profile.server),HOST:'127.0.0.1',AI_ADAPTER:'mock',VITE_DEV_PORT:String(profile.client),GAME_BACKEND_PORT:String(profile.server)};
if(action==='check'){
  console.log(JSON.stringify({role,root,data,logs,temporary,server_port:profile.server,client_port:profile.client,adapter:env.AI_ADAPTER},null,2));
}else{
  let file=process.execPath,parameters;
  if(action==='test')parameters=[resolve(root,'node_modules/vitest/vitest.mjs'),'run','--maxWorkers=1','--pool=threads',...args];
  else if(action==='build'){
    if(args.length)throw Error('Build accepts no extra arguments');
    if(process.platform==='win32'){file=process.env.ComSpec??'cmd.exe';parameters=['/d','/s','/c','npm run build'];}
    else{file='npm';parameters=['run','build'];}
  }else if(action==='server'){
    if(args.length)throw Error('Server accepts no extra arguments');
    parameters=[resolve(root,'node_modules/tsx/dist/cli.mjs'),'src/server/index.ts'];
  }else{
    if(args.length)throw Error('Client accepts no extra arguments');
    parameters=[resolve(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(profile.client),'--strictPort'];
  }
  const child=spawn(file,parameters,{cwd:root,env,stdio:'inherit',windowsHide:true});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
