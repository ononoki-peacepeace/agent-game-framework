import {expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fresh} from './helpers.js';
import {JsonStore} from '../src/storage/json-store.js';
import {withCurrentImageWrite} from '../src/storage/current-write-guard.js';

it('propagates an operation fault once, releases coordination and preserves the old complete image',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-current-guard-fault-'));
 try{
  const store=new JsonStore(directory),initial=fresh();await store.write(initial);const bytes=await readFile(join(directory,'current.json'));
  let calls=0;await expect(withCurrentImageWrite(directory,async()=>{calls++;throw Error('original operation fault');})).rejects.toThrow('original operation fault');
  expect(calls).toBe(1);expect(await readFile(join(directory,'current.json'))).toEqual(bytes);
  const next=structuredClone(initial);next.gm_state.flags.after_guard_fault=true;await store.write(next);expect(await new JsonStore(directory).read()).toEqual(next);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('stops on an invalid coordination database without replacing or silently unlocking either file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'agf-current-guard-corrupt-'));
 try{
  const store=new JsonStore(directory),initial=fresh();await store.write(initial);const bytes=await readFile(join(directory,'current.json'));
  const corrupt=Buffer.from('invalid database bytes retained for inspection');await writeFile(join(directory,'current-write.sqlite'),corrupt);
  const next=structuredClone(initial);next.gm_state.flags.must_not_save=true;
  await expect(store.write(next)).rejects.toMatchObject({code:'ERR_SQLITE_ERROR'});
  expect(await readFile(join(directory,'current.json'))).toEqual(bytes);expect(await readFile(join(directory,'current-write.sqlite'))).toEqual(corrupt);
 }finally{await rm(directory,{recursive:true,force:true});}
});
