/** Bounded, local diagnostics for a submitted player action. Never store input or world content. */
export function recordActionDiagnostic(stage:'submit_requested'|'submitted'|'blocked'|'waiting'|'retry'|'response'|'error'|'finished',details:{path:string;request_id?:string;revision?:number;reason?:string}){
  const entry={at:new Date().toISOString(),stage,path:details.path,request_id:details.request_id??null,revision:details.revision??null,reason:details.reason??null};
  console.info('[player-action]',entry);
  try{
    const key='agent-game:action-diagnostics';
    const previous=JSON.parse(sessionStorage.getItem(key)??'[]') as unknown;
    sessionStorage.setItem(key,JSON.stringify([...(Array.isArray(previous)?previous:[]),entry].slice(-30)));
  }catch{/* The browser may disable session storage; console diagnostics still work. */}
}
