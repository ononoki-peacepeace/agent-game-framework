import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Standalone Node ESM CLI; its runtime interface is exercised here.
import {initialize,render,seal,check,localFile} from '../scripts/narrator-live-qa.mjs';
const roots:string[]=[];
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p:string,v:unknown)=>fs.writeFileSync(p,JSON.stringify(v));
function packet(){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'qa-record-'));roots.push(parent);const root=path.join(parent,'packet');initialize(root);return root;}
afterEach(()=>{for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});
it('keeps incomplete records pending, refuses overwrites and exposes all thirteen frozen conditions',()=>{
 const root=packet(),catalog=read(path.join(root,'catalog.json'));
 expect(catalog.conditions).toEqual(['N3.4','N5.3','N5.4','N6.3','N6.4','N7.3','N7.4','N8.2','N8.4','N9.1','N9.2','N9.3','N9.4']);
 expect(new Set([...catalog.cases.flatMap((c:{conditions:string[]})=>c.conditions),...catalog.program_requirements.map((r:{condition:string})=>r.condition)])).toEqual(new Set(catalog.conditions));
 expect(()=>initialize(root)).toThrow();seal(root);expect(()=>seal(root)).toThrow();
 const result=check(root);expect(result.ready_for_independent_review).toBe(false);expect(result.pending.length).toBeGreaterThanOrEqual(42);expect(result.conditions_awarded).toEqual([]);expect(result.real_model_quality_verified).toBe(false);
});
it('renders all fixed inputs only after referenced bindings exist; never executes a game request',()=>{
 const root=packet();expect(()=>render(root,'relationships','P01')).toThrow('Unverified binding');
 const run=read(path.join(root,'run.json'));fs.writeFileSync(path.join(root,'artifacts','bindings.txt'),'Synthetic test evidence, not a game run');
 for(const b of Object.values(run.bindings as Record<string,Record<string,object>>))for(const [key,value] of Object.entries(b))Object.assign(value,{name:'测试'+key,canonical_ref:key,evidence_file:'artifacts/bindings.txt'});
 write(path.join(root,'run.json'),run);
 const catalog=read(path.join(root,'catalog.json'));
 for(const c of catalog.cases)for(const world of c.worlds){const result=render(root,world,c.id);expect(result.executed).toBe(false);expect(result.steps.every((s:{input:string})=>!/[{}]/.test(s.input))).toBe(true);}
});
it('rejects path and symlink escapes from an evidence packet',()=>{
 const root=packet(),outside=path.join(path.dirname(root),'outside.txt');fs.writeFileSync(outside,'outside');
 expect(()=>localFile(root,'../outside.txt')).toThrow();expect(()=>localFile(root,outside)).toThrow();
 fs.symlinkSync(outside,path.join(root,'artifacts','link.txt'));expect(()=>localFile(root,'artifacts/link.txt')).toThrow('escapes');
});
it('keeps blocked partial-turn evidence, rejects invented real-call provenance, and detects later tampering',()=>{
 const root=packet(),records=read(path.join(root,'records.json')),run=read(path.join(root,'run.json'));
 fs.writeFileSync(path.join(root,'artifacts','raw.json'),JSON.stringify({synthetic_fixture:true,not_real_model_evidence:true}));
 run.qa_game_ids.commerce='fixture-game';write(path.join(root,'run.json'),run);
 const turn={input:'测试输入',request_id:'fixture-request',game_id:'fixture-game',revision_before:1,revision_after:1,origin:'technical_failure',
  artifacts:Object.fromEntries(['request','before','after','receipts','npc_decisions','visible_output','ui_response'].map(k=>[k,'artifacts/raw.json'])),calls:[]};
 records[0].status='blocked';records[0].blocker='Synthetic interruption';records[0].turns=[turn];
 turn.origin='authorized_real_provider';write(path.join(root,'records.json'),records);expect(()=>seal(root)).toThrow('authorization');
 turn.origin='technical_failure';write(path.join(root,'records.json'),records);seal(root);
 expect(read(path.join(root,'sealed.json')).files.some((f:{file:string})=>f.file==='artifacts/raw.json')).toBe(true);
 expect(check(root).ready_for_independent_review).toBe(false);
 fs.appendFileSync(path.join(root,'artifacts','raw.json'),'changed');expect(()=>check(root)).toThrow('Artifact changed');
});
it('does not let missing coverage rows or a captured empty result become complete evidence',()=>{
 const root=packet(),file=path.join(root,'records.json'),records=read(file);
 records.pop();write(file,records);expect(()=>seal(root)).toThrow('case ID');
 const root2=packet(),file2=path.join(root2,'records.json'),rows=read(file2);rows[0].status='captured';write(file2,rows);expect(()=>seal(root2)).toThrow('without turns');
});
