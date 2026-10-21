import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const specPath='docs/narrator-quality-program.v1.json';
const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
const original=JSON.parse(fs.readFileSync(spec.original_spec,'utf8'));
const cases=[...original.cases,...spec.cases],files=[...new Set(cases.map(c=>c.test_file))];
assert.equal(cases.length,56);assert.equal(new Set(cases.map(c=>c.id)).size,56);
for(const pair of spec.pairs)for(const id of [pair.left,pair.right])assert(cases.some(c=>c.id===id));
const directory=path.resolve('.agent-runtime/codex/narrator-program',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(directory,{recursive:true});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pinned=[...new Set([specPath,spec.original_spec,'scripts/narrator-quality-program.mjs',
 'scripts/narrator-prose-benchmark-capture.ts','scripts/narrator-program-capture.ts','scripts/agent-workspace.mjs','package.json','package-lock.json','tsconfig.json',
 'vitest.config.ts','docs/four-theme-acceptance-criteria.v1.json','docs/four-theme-acceptance-criteria.v1.sha256',
 'docs/four-theme-verification-protocol.v1.md',...cp.execFileSync('rg',['--files','src','tests','content','scripts/lib'],{encoding:'utf8'}).trim().split(/\r?\n/)])].sort();
const source=pinned.map(file=>({path:file,sha256:sha(file)}));
const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const manifest={head,source,cases,pairs:spec.pairs,dimensions:original.dimensions,hard_gates:original.hard_gates,
 scope:spec.scope,quality_ratings_assigned:0,real_provider_calls:0};
const manifestPath=path.join(directory,'manifest.json');
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const config=path.join(directory,'vitest.config.mjs');
fs.writeFileSync(config,`export default ${JSON.stringify({test:{maxWorkers:1,include:files,testTimeout:30000,
 setupFiles:[path.resolve('scripts/narrator-program-capture.ts')]}})};\n`,{flag:'wx'});
const log=fs.openSync(path.join(directory,'run.log'),'wx');let result;
try{result=cp.spawnSync(process.execPath,['scripts/agent-workspace.mjs','codex','test','--config='+config,
 '--reporter=default','--reporter=json','--outputFile='+path.join(directory,'vitest.json')],
 {stdio:['ignore',log,log],env:{...process.env,NARRATOR_BENCHMARK_OUTPUT:directory},windowsHide:true});}
finally{fs.closeSync(log);}
const reportPath=path.join(directory,'vitest.json');
const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):null;
const records=fs.readdirSync(directory).filter(f=>f.endsWith('.json')).flatMap(file=>{
 const value=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
 return typeof value.case_id==='string'?[{...value,file,sha256:sha(path.join(directory,file))}]:[];
});
const packet={manifest_sha256:sha(manifestPath),cases:cases.map(c=>({...c,
 records:records.filter(r=>r.case_id===c.id).map(r=>({file:r.file,sha256:r.sha256,
 provenance:r.provenance??'actual_offline_fallback'})),hard_gates:null,ratings:null,reviewer:null})),
 pairs:spec.pairs.map(p=>({...p,distinction:null,evidence:null})),rubric:original.review,
 external_requirements:spec.external_requirements};
const missing=packet.cases.filter(c=>!c.records.length).map(c=>c.id);
const hashesMatch=source.every(file=>sha(file.path)===file.sha256);
const status={head,exit:result.status,signal:result.signal,error:result.error?.message,
 passed:report?.numPassedTests,failed:report?.numFailedTests,skipped:report?.numPendingTests,
 cases:cases.length,captured:cases.length-missing.length,missing,pinned_hashes:source.length,hashes_match:hashesMatch,
 quality_ratings_assigned:0,real_provider_calls:0,conditions_awarded:[],unreviewed_cases:packet.cases.map(c=>c.id),
 external_requirements:spec.external_requirements};
fs.writeFileSync(path.join(directory,'review.json'),JSON.stringify(packet,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx'});
let md='# Current-source Narrator program capture\n\nControlled candidates are NOT normal-model evidence. Ratings and pair judgments are blank. No conditions awarded.\n\n| Case | Structure | Provenance | Actual text |\n|---|---|---|---|\n';
const text=r=>typeof r.rendered==='string'?r.rendered:[r.rendered?.narrative,r.rendered?.dialogue,
 ...(r.checkpoints??[]).map(c=>`${c.hours}h: ${c.rendered?.narrative??''}`)].filter(Boolean).join('\n');
for(const c of packet.cases){const r=records.find(r=>r.case_id===c.id);md+=`| ${c.id} | ${c.world} | ${r?.provenance??'actual_offline_fallback'} | ${(r?text(r):'MISSING').replaceAll('|','／').replaceAll('\n',' / ')} |\n`;}
fs.writeFileSync(path.join(directory,'review.md'),md,{flag:'wx'});
console.log(JSON.stringify({directory,...status},null,2));
assert.equal(result.status,0,'Fixture failure: retain original run.log and outputs');
assert(report&&report.numFailedTests===0&&report.numPendingTests===0&&report.numPassedTests===report.numTotalTests,'Incomplete test run');
assert.equal(missing.length,0,'A missing capture is not a passing benchmark case');
assert(hashesMatch,'Pinned source changed during capture');
