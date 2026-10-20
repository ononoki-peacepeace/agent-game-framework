import {AsyncLocalStorage} from 'node:async_hooks';
import {z} from 'zod';
import type {SavePackage} from '../core/schema.js';

/** Durable links to child transactions; model output cannot supply these links. */
export const inputRecoverySchema=z.strictObject({
  original_player_input:z.string().max(12000),trace_id:z.string().max(80),
  transactions:z.array(z.strictObject({request_id:z.string().uuid(),fingerprint:z.string(),
    expected_revision:z.number().int().min(0)})).max(256),
});
export type InputRecovery=z.infer<typeof inputRecoverySchema>;
type Scope={game_id:string;recovery:InputRecovery;persist:()=>Promise<void>};
const scope=new AsyncLocalStorage<Scope>();

export function withInputRecovery<T>(context:Scope,work:()=>Promise<T>):Promise<T>{
  return scope.run(context,work);
}

/** Detached jobs have their own lifecycle and cannot mutate a finished HTTP journal. */
export function withoutInputRecovery<T>(work:()=>T):T{return scope.exit(work);}
export function originalRecoveryInput(){return scope.getStore()?.recovery.original_player_input;}

/** Await the intent journal before the atomic world write, including on child steps. */
export async function prepareRequestCommit(gameId:string,requestId:string,fingerprint:string,revision:number){
  const context=scope.getStore();
  if(!context||context.game_id!==gameId)return;
  const previous=context.recovery.transactions.find(entry=>entry.request_id===requestId);
  if(previous){
    if(previous.fingerprint!==fingerprint||previous.expected_revision!==revision)
      throw new Error('Recovery transaction identity mismatch');
    return;
  }
  // Stop before a world write instead of silently discarding idempotency evidence.
  if(context.recovery.transactions.length>=256)throw new Error('Recovery transaction journal capacity reached');
  context.recovery.transactions.push({request_id:requestId,fingerprint,expected_revision:revision});
  try{await context.persist();}
  catch(error){context.recovery.transactions.pop();throw error;}
}

/** A prepared intent is not a receipt. Match all identity fields in current truth. */
export function committedInputReceipts(save:SavePackage,recovery?:InputRecovery){
  return recovery?.transactions.flatMap(transaction=>{
    const receipt=save.runtime.receipts.find(entry=>entry.id===transaction.request_id&&
      entry.fingerprint===transaction.fingerprint&&entry.revision===transaction.expected_revision+1);
    // Undo preserves idempotency receipts so old requests can never re-execute.
    // Legacy audits do not prove ancestry for every Agent-only transaction;
    // conservatively withhold progress after a later Undo/history restore.
    return receipt&&!save.turn_audit?.some(audit=>audit.reverted_at>receipt.revision)?[receipt.id]:[];
  })??[];
}
