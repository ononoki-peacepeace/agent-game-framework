// Local record preparation/integrity checks only. No HTTP, Provider or game writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
const catalogPath=fileURLToPath(new URL('../docs/narrator-final-qa/cases.json',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const requireValue=(condition,message)=>{if(!condition)throw Error(message);};
export function localFile(root,name){
 requireValue(typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!name.includes('\\')&&!name.split('/').includes('..')&&!/^[A-Za-z]:/.test(name),'Expected contained relative artifact path');
 const realRoot=fs.realpathSync(root),real=fs.realpathSync(path.resolve(realRoot,name));
 requireValue(real.startsWith(realRoot+path.sep)&&fs.statSync(real).isFile(),'Artifact escapes packet or is not a file');return real;
}
export function initialize(root){
 const catalog=read(catalogPath),head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const paths=cp.execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(p=>/^(src\/|tests\/|scripts\/|content\/|package(?:-lock)?\.json$|tsconfig.*\.json$|vite.*\.ts$|docs\/four-theme-)/.test(p));
 const source={head,description:'Checkout snapshot, NOT proof of deployed UI version',files:paths.map(p=>({path:p,sha256:hash(p)}))};
 fs.mkdirSync(root); // Deliberately refuses an existing destination.
 fs.mkdirSync(path.join(root,'artifacts'));write(path.join(root,'source.json'),source);write(path.join(root,'catalog.json'),catalog);
 write(path.join(root,'run.json'),{version:1,source_head:head,deployed_head:null,deployed_source_verified:false,integration_verified:false,
  authorization_ref:null,budget_plan_ref:null,deployed_build_evidence:null,integration_evidence:null,operator:null,qa_game_ids:{},windows_formal_ledger_ref:null,
  world_witnesses:{},bindings:Object.fromEntries(catalog.worlds.map(w=>[w.id,Object.fromEntries(catalog.binding_keys.map(k=>[k,{name:null,canonical_ref:null,evidence_file:null}]))]))});
 write(path.join(root,'records.json'),catalog.cases.flatMap(c=>c.worlds.map(world=>({id:`${world}/${c.id}`,world,case_id:c.id,status:'not_run',blocker:null,
  observations:Object.fromEntries(c.required_observations.map(o=>[o,{status:'not_observed',evidence:[]}])) ,turns:[],
  review:{reviewer:{id:null,role:null,attestation_ref:null},hard_gates:[null,null,null,null],
   ratings:Object.fromEntries(['voice','rhythm','perception','naturalness','continuity'].map(d=>[d,{score:null,evidence:null,na_reason:null}])),
   diagnostics:{specificity:{score:null,evidence:null},coherence:{score:null,evidence:null}},pair_comparison:null,conditions_awarded:[]}}))));
 return {directory:root,cases:catalog.cases.length*catalog.worlds.length,model_calls:0,server_actions:0};
}
function load(root){
 requireValue(hash(localFile(root,'catalog.json'))===hash(catalogPath),'Catalog differs from this QA kit');
 const catalog=read(localFile(root,'catalog.json')),run=read(localFile(root,'run.json')),records=read(localFile(root,'records.json'));
 const expected=catalog.cases.flatMap(c=>c.worlds.map(w=>`${w}/${c.id}`)).sort();
 requireValue(Array.isArray(records)&&JSON.stringify(records.map(r=>r.id).sort())===JSON.stringify(expected),'Missing, extra or duplicate case ID');
 return {catalog,run,records};
}
export function render(root,world,id){
 const {catalog,run}=load(root),c=catalog.cases.find(c=>c.id===id&&c.worlds.includes(world));requireValue(c,'Unknown case/world');
 const steps=c.steps.map(step=>({...step,input:step.input.replace(/\{([a-z_]+)\}/g,(_,key)=>{
  const b=run.bindings?.[world]?.[key];requireValue(b?.name&&b?.canonical_ref&&b?.evidence_file,`Unverified binding: ${world}/${key}`);localFile(root,b.evidence_file);return b.name;
 })}));return {world,case_id:id,setup:c.setup,steps,required_observations:c.required_observations,review_checks:c.review_checks,executed:false};
}
function evidence(root){
 const {catalog,run,records}=load(root),files=new Set(['catalog.json','run.json','source.json','records.json']);
 const ref=p=>{localFile(root,p);files.add(p);};
 for(const b of Object.values(run.bindings??{}))for(const v of Object.values(b))if(v.evidence_file)ref(v.evidence_file);
 for(const witness of Object.values(run.world_witnesses??{}))ref(witness);
 for(const p of [run.deployed_build_evidence,run.integration_evidence])if(p)ref(p);
 requireValue(run.source_head===read(localFile(root,'source.json')).head,'Source HEAD differs from initial snapshot');
 for(const r of records){
  const c=catalog.cases.find(c=>c.id===r.case_id);requireValue(r.id===`${r.world}/${r.case_id}`&&c?.worlds.includes(r.world),'Case identity mismatch');
  requireValue(['not_run','blocked','captured'].includes(r.status),'Unknown case status');
  requireValue(JSON.stringify(Object.keys(r.observations??{}).sort())===JSON.stringify([...c.required_observations].sort()),`Observation inventory changed: ${r.id}`);
  for(const o of Object.values(r.observations)){requireValue(['not_observed','observed','blocked'].includes(o.status),'Invalid observation state');requireValue(Array.isArray(o.evidence),'Observation evidence must be an array');if(o.status==='observed')requireValue(o.evidence.length>0,'Observed requires evidence');for(const p of o.evidence)ref(p);}
  requireValue(Array.isArray(r.turns),'Turns must be an array, including blocked cases');
  if(r.status==='captured')requireValue(r.turns.length>0,`Captured without turns: ${r.id}`);
  requireValue(Array.isArray(r.review?.conditions_awarded)&&r.review.conditions_awarded.length===0,'This packet cannot award conditions');
  for(const t of r.turns){
   requireValue(typeof t.input==='string'&&t.input.trim()&&t.request_id&&t.game_id,'Missing raw input/request/game identity');
   requireValue(t.game_id===run.qa_game_ids?.[r.world],'QA game ID mismatch');
   requireValue(Number.isInteger(t.revision_before)&&Number.isInteger(t.revision_after),'Missing revisions');
   requireValue(['authorized_real_provider','actual_offline_fallback','authored_control','replay','technical_failure'].includes(t.origin),'Unknown output provenance');
   for(const key of ['request','before','after','receipts','npc_decisions','visible_output','ui_response'])ref(t.artifacts?.[key]);
   requireValue(Array.isArray(t.calls),'Missing complete call list');
   if(t.origin==='authorized_real_provider'){
    requireValue(run.authorization_ref&&run.budget_plan_ref&&t.calls.some(c=>c.role==='narrator'&&c.origin==='authorized_real_provider'),'Real output lacks authorization/budget/Narrator call metadata');
   }
   if(t.origin==='replay')requireValue(t.replay_of===t.request_id&&t.calls.length===0,'Exact replay must reference same request and have no new calls');
   for(const call of t.calls){
    requireValue(call.id&&call.role&&call.provider&&call.model&&['authorized_real_provider','offline_control'].includes(call.origin),'Missing call identity/provenance');
    if(call.origin==='authorized_real_provider')requireValue(run.authorization_ref&&run.budget_plan_ref,'Real call lacks authorization/budget metadata');
    requireValue(call.raw_response||call.raw_error,'Missing original response/error');
    ref(call.raw_request);if(call.raw_response)ref(call.raw_response);if(call.raw_error)ref(call.raw_error);
    requireValue(call.usage!==undefined&&call.cost!==undefined,'Keep usage/cost, or explicit null with unavailable_reason');
    if(call.usage===null||call.cost===null)requireValue(call.unavailable_reason,'Unknown usage/cost needs a reason');
   }
  }
 }
 return {run,records,files:[...files].sort()};
}
export function seal(root){
 const {files}=evidence(root);write(path.join(root,'sealed.json'),{files:files.map(file=>({file,sha256:hash(localFile(root,file))})),conditions_awarded:[]});
 return {sealed:true,files:files.length,conditions_awarded:[]};
}
export function check(root){
 const {run,records,files}=evidence(root),sealed=read(localFile(root,'sealed.json'));
 requireValue(JSON.stringify(sealed.files.map(f=>f.file).sort())===JSON.stringify(files),'Sealed inventory mismatch');
 for(const f of sealed.files)requireValue(hash(localFile(root,f.file))===f.sha256,`Artifact changed: ${f.file}`);
 const pending=records.flatMap(r=>r.status!=='captured'?[`${r.id}: ${r.status}`]:Object.entries(r.observations).filter(([,o])=>o.status!=='observed').map(([k])=>`${r.id}: ${k}`));
 if(!run.deployed_source_verified||!run.integration_verified||run.deployed_head!==run.source_head||!run.deployed_build_evidence||!run.integration_evidence)pending.push('Windows integrated/deployed source not verified');
 for(const world of read(localFile(root,'catalog.json')).worlds)if(!run.world_witnesses?.[world.id])pending.push(`${world.id}: missing structural witness`);
 return {integrity_valid:true,ready_for_independent_review:pending.length===0,pending,
  cases_without_real_model_output:records.filter(r=>!r.turns.some(t=>t.origin==='authorized_real_provider')).map(r=>r.id),
  real_model_quality_verified:false,requires_external_identity_authorization_and_fact_review:true,conditions_awarded:[]};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,root,world,id]=process.argv.slice(2);requireValue(root,'Usage: node scripts/narrator-live-qa.mjs init|render|seal|check <packet-directory> [world case]');
  const result=mode==='init'?initialize(root):mode==='render'?render(root,world,id):mode==='seal'?seal(root):mode==='check'?check(root):(()=>{throw Error('Unknown command');})();
  console.log(JSON.stringify(result,null,2));if(mode==='check'&&!result.ready_for_independent_review)process.exitCode=1;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
