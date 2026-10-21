import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [mode,nonce]=process.argv.slice(2);
if(!nonce||!['leaf','nested','inner'].includes(mode))throw Error('Owned tool fixture requires mode and nonce');
// An interrupted assertion/controller must not leave an unbounded test process.
setTimeout(()=>process.exit(91),20000);
if(mode==='inner'){
 process.send?.({kind:'inner_ready',pid:process.pid,nonce});setInterval(()=>{},1000);
}else if(mode==='leaf'){
 console.log(JSON.stringify({kind:'tool_ready',pid:process.pid,nonce}));setInterval(()=>{},1000);
}else{
 const inner=fork(fileURLToPath(import.meta.url),['inner',nonce],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 inner.on('message',message=>{if(message.kind==='inner_ready')console.log(JSON.stringify({kind:'tool_ready',pid:process.pid,inner_pid:inner.pid,nonce}));});
 inner.once('exit',(code,signal)=>{console.error('OWNED_INNER_EXIT '+JSON.stringify({code,signal,nonce}));process.exit(79);});
 process.stdin.on('data',data=>{if(String(data).trim()==='kill-inner:'+nonce)inner.kill('SIGKILL');});
 process.on('SIGTERM',()=>{inner.kill('SIGKILL');});
}
