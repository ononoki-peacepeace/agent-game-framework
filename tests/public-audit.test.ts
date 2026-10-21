import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const script=resolve('scripts/audit-public.mjs');
function fixture(run:(directory:string,git:(...args:string[])=>string)=>void){
 const directory=mkdtempSync(join(tmpdir(),'public-audit-'));
 const git=(...args:string[])=>execFileSync('git',['-c','safe.directory='+directory.replaceAll('\\','/'),...args],{cwd:directory,encoding:'utf8'}).trim();
 try{git('init','--quiet');git('config','user.name','Offline Test');git('config','user.email','offline@example.invalid');run(directory,git);}
 finally{rmSync(directory,{recursive:true,force:true});}
}
function audit(directory:string,...args:string[]){
 const result=spawnSync(process.execPath,['--max-old-space-size=48',script,...args],{cwd:directory,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});
 expect(result.error).toBeUndefined();
 return {...result,report:result.stdout.startsWith('{')?JSON.parse(result.stdout.slice(0,result.stdout.lastIndexOf('}')+1)):undefined};
}
it('streams a binary historical blob larger than the old 32 MiB limit under a bounded JS heap',()=>fixture((directory,git)=>{
 const name=join(directory,'large.bin');writeFileSync(name,Buffer.alloc(0));
 for(let i=0;i<35;i++)appendFileSync(name,Buffer.alloc(1024*1024));
 appendFileSync(name,'-----BEGIN '+'PRIVATE KEY-----');
 git('add','large.bin');git('commit','--quiet','-m','large binary boundary');
 const result=audit(directory,'--revision','HEAD');
 expect(result.status,result.stderr).toBe(1);
 expect(result.report.largestBlob).toBeGreaterThan(32*1024*1024);
 expect(result.report.findings.map((entry:any)=>entry.kind)).toEqual(['private-key']);
}),40000);
it('detects chunk-boundary credentials without printing their values',()=>fixture((directory,git)=>{
 const token='sk-'+('A'.repeat(24));
 writeFileSync(join(directory,'boundary.txt'),' '.repeat(65530)+token+' ');
 git('add','.');git('commit','--quiet','-m','boundary');
 const result=audit(directory,'--revision','HEAD');
 expect(result.status).toBe(1);expect(result.report.findings[0].kind).toBe('credential-format');
 expect(result.stdout).not.toContain(token);
}));
it('separates reachable publication history from dirty files and unrelated local objects',()=>fixture((directory,git)=>{
 writeFileSync(join(directory,'safe.txt'),'public example');git('add','.');git('commit','--quiet','-m','safe');
 const token='ghp_'+('B'.repeat(24));writeFileSync(join(directory,'local.txt'),token);
 git('hash-object','-w','local.txt');
 const scoped=audit(directory,'--revision','HEAD');expect(scoped.status,scoped.stderr).toBe(0);
 const all=audit(directory);expect(all.status).toBe(1);
 expect(all.report.scope).toBe('working-files-and-all-local-objects');
 expect(all.report.findings.some((entry:any)=>entry.file==='local.txt')).toBe(true);
 expect(all.report.findings.some((entry:any)=>entry.file.startsWith('git-object:'))).toBe(true);
 expect(all.stdout).not.toContain(token);
}));
it('fails closed for an invalid revision rather than reporting a clean audit',()=>fixture((directory)=>{
 const result=audit(directory,'--revision','missing-reference');expect(result.status).toBe(2);expect(result.report).toBeUndefined();
}));
it('still rejects a private path deleted from the candidate tree but retained in history',()=>fixture((directory,git)=>{
 const name=join(directory,'.env.local');writeFileSync(name,'non-secret fixture');
 git('add','.');git('commit','--quiet','-m','private path fixture');
 unlinkSync(name);git('add','-u');git('commit','--quiet','-m','remove path');
 const result=audit(directory,'--revision','HEAD');expect(result.status).toBe(1);
 expect(result.report.candidateFiles).toBe(0);
 expect(result.report.findings).toContainEqual({file:'.env.local',kind:'private-or-runtime-path'});
}));
it('reports an approved exact home-path object while still blocking an unapproved credential object',()=>fixture((directory,git)=>{
 const home='C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'demo'+String.fromCharCode(92)+'notes';
 writeFileSync(join(directory,'path.txt'),home);git('add','.');git('commit','--quiet','-m','ordinary path');
 const object=git('rev-parse','HEAD:path.txt'),file=join(directory,'exceptions.json');
 const approved={file:'git-object:'+object,kind:'home-path',reason:'Reviewed synthetic ordinary path',approved_by:'Offline test'};
 writeFileSync(file,JSON.stringify({exceptions:[approved]}));
 const clean=audit(directory,'--revision','HEAD','--exceptions',file);
 expect(clean.status,clean.stderr).toBe(0);expect(clean.report.knownExceptions).toHaveLength(1);expect(clean.report.findings).toEqual([]);
 writeFileSync(join(directory,'credential.txt'),'sk-'+('C'.repeat(24)));git('add','credential.txt');git('commit','--quiet','-m','credential control');
 const blocked=audit(directory,'--revision','HEAD','--exceptions',file);
 expect(blocked.status).toBe(1);expect(blocked.report.findings[0].kind).toBe('credential-format');
 writeFileSync(file,JSON.stringify({exceptions:[{...approved,kind:'credential-format'}]}));
 expect(audit(directory,'--revision','HEAD','--exceptions',file).status).not.toBe(0);
}));
