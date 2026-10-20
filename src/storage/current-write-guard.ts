import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

function contended(error:unknown){
 const code=(error as {errcode?:unknown})?.errcode;
 // Extended SQLite result codes retain the primary code in the low byte.
 return typeof code==='number'&&[5,6].includes(code&255);
}
async function acquire(path:string,timeoutMs:number){
 const deadline=performance.now()+timeoutMs;
 for(;;){
  let db:DatabaseSync|undefined;
  try{
   db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout = 0');db.exec('BEGIN IMMEDIATE');return db;
  }catch(error){
   db?.close();
   if(!contended(error))throw error;
   const remaining=deadline-performance.now();
   if(remaining<=0)throw Object.assign(new Error('Current save write coordination timed out',{cause:error}),{code:'CURRENT_WRITE_BUSY'});
   await new Promise(resolve=>setTimeout(resolve,Math.min(25,remaining)));
  }
 }
}

/** Cooperating processes lock an empty database, never the game image itself.
 * The OS releases SQLite's transaction lock after process death. Do not remove
 * the coordination file: replacing it could split writers across two locks.
 */
export async function withCurrentImageWrite<T>(directory:string,operation:()=>Promise<T>):Promise<T>{
 await mkdir(directory,{recursive:true});
 const db=await acquire(join(directory,'current-write.sqlite'),5000);
 try{return await operation();}
 finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}
