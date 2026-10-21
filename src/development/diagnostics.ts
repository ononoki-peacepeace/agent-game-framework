import {redactTextTail,redactValue} from '../observability/logger.js';

/** Small enough for existing durable task error fields, with original exit and
 * final output evidence. Redact complete text before taking either tail. */
export function developmentFailure(stage:string,error:unknown){
  const child=error as {code?:unknown;signal?:unknown;stdout?:unknown;stderr?:unknown};
  const stdout=redactTextTail(child?.stdout).slice(-400),stderr=redactTextTail(child?.stderr).slice(-400);
  return [`[${stage}] ${String(redactValue(error instanceof Error?error.message:String(error))).slice(0,300)}`,
    typeof child?.code==='number'?`exit=${child.code}`:typeof child?.code==='string'?`code=${String(redactValue(child.code))}`:'',
    typeof child?.signal==='string'?`signal=${String(redactValue(child.signal))}`:'',
    stdout?`stdout:\n${stdout}`:'',stderr?`stderr:\n${stderr}`:''].filter(Boolean).join('\n').slice(0,1500);
}
