export type InputStatus<T>={state:'running'|'completed'|'failed'|'unknown';result?:T;error?:string;reason?:string;payload?:unknown;http_status?:number;
  phase?:'interpreting'|'planning'|'resolving'|'narrating'|'committing'|'finalizing';
  phase_history?:string[];committed_revision?:number|null};
export class InputStillRunning extends Error{
  constructor(){super('请求仍在服务端处理；可查看原请求的结果，请不要重复提交。');this.name='InputStillRunning';}
}
export class InputStatusUnknown extends Error{
  constructor(){super('连接已中断，无法确认请求是否完成。请先刷新世界状态，不要直接重试。');this.name='InputStatusUnknown';}
}
export const pendingInputKey='herne.pending.input';
export type PendingInput={request_id:string;game_id:string;started_at?:number};
export function readPendingInput():PendingInput|null{
  try{const value=JSON.parse(sessionStorage.getItem(pendingInputKey)??'null');
    return value&&typeof value.request_id==='string'&&typeof value.game_id==='string'?value:null;
  }catch{return null;}
}
export function matchesPendingInput(marker:PendingInput){const value=readPendingInput();return value?.request_id===marker.request_id&&value.game_id===marker.game_id;}
export function clearPendingInput(marker?:PendingInput){
  if(marker&&!matchesPendingInput(marker))return;
  sessionStorage.removeItem(pendingInputKey);
  window.dispatchEvent(new Event('herne:pending-input-changed'));
}
function delay(ms:number,signal?:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    signal?.throwIfAborted();
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new DOMException('Cancelled','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

/** A timed-out browser connection is never proof that the world action failed. */
export async function awaitInputResult<T>(send:Promise<T>,status:()=>Promise<InputStatus<T>>,
  options:{requestTimeoutMs?:number;pollMs?:number;polls?:number;maxRecoveryMs?:number;signal?:AbortSignal}={}):Promise<T>{
  options.signal?.throwIfAborted();
  const timeoutMs=options.requestTimeoutMs??90_000,pollMs=options.pollMs??3000,polls=options.polls??Number.POSITIVE_INFINITY;
  // Long model work can outlive the old ten-minute window. Keep the same request ID
  // alive for a bounded period, and reduce the read-only poll rate after two minutes.
  const maxRecoveryMs=options.maxRecoveryMs??1_800_000;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);});
  // A broken browser connection does not cancel the server job. Keep its rejection handled
  // and recover the original request by ID, without issuing another POST.
  const submitted=send.then(value=>({value}),()=>null);
  try{
    const direct=await Promise.race([submitted,expired]);
    if(direct!==null)return direct.value;
  }finally{if(timer)clearTimeout(timer);}
  const recoveryStarted=Date.now();
  for(let attempt=0;attempt<polls&&Date.now()-recoveryStarted<maxRecoveryMs;attempt++){
    options.signal?.throwIfAborted();
    let latest:InputStatus<T>;
    try{latest=await status();}catch{
      options.signal?.throwIfAborted();
      // Read-only status polling may also briefly lose the network. Preserve the request ID.
      await delay(attempt<40?pollMs:Math.min(15_000,pollMs*5),options.signal);
      continue;
    }
    options.signal?.throwIfAborted();
    if(latest.state==='completed'&&latest.result!==undefined)return latest.result;
    if(latest.state==='failed')throw Object.assign(new Error(latest.error??'请求未完成，请刷新世界状态。'),
      {payload:latest.payload,httpStatus:latest.http_status});
    if(latest.state==='unknown')throw new InputStatusUnknown();
    if(attempt+1<polls)await delay(attempt<40?pollMs:Math.min(15_000,pollMs*5),options.signal);
  }
  throw new InputStillRunning();
}
