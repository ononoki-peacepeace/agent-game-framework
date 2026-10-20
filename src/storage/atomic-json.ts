import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const transientRenameCodes=new Set(['EPERM','EACCES','EBUSY']);
export async function replaceWithBoundedRetry(temp:string,target:string,expected:string){
  for(let attempt=0;attempt<4;attempt++){
    try{await rename(temp,target);return;}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(!transientRenameCodes.has(code??''))throw error;
      const current=await readFile(target,'utf8').catch(readError=>{
        if((readError as NodeJS.ErrnoException).code==='ENOENT')return null;throw readError;
      });
      if(current===expected)return;
      if(attempt===3)throw error;
      await new Promise(resolve=>setTimeout(resolve,40*(attempt+1)));
    }
  }
}

/** One atomic image, flushed before rename; retry the rename, never its world producer. */
export async function writeAtomicJson(path:string,value:unknown){
  const body=JSON.stringify(value,null,2),temporary=path+'.'+randomUUID()+'.tmp';
  await mkdir(dirname(path),{recursive:true});
  try{const file=await open(temporary,'wx');
    try{await file.writeFile(body,'utf8');await file.sync();}finally{await file.close();}
    await replaceWithBoundedRetry(temporary,path,body);
  }finally{await unlink(temporary).catch(()=>undefined);}
}
