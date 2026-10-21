import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const specPath='docs/narrator-prose-benchmark.v1.json';
const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
assert.equal(spec.cases.length,18);assert.equal(new Set(spec.cases.map(c=>c.id)).size,18);
const files=[...new Set(spec.cases.map(c=>c.test_file))];
for(const item of spec.cases){assert(files.includes(item.test_file));assert(item.dimensions.every(id=>spec.dimensions.some(d=>d.id===id)));}
const directory=path.resolve('.agent-runtime/codex/prose-benchmark',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(directory,{recursive:true});
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const paths=[...new Set([specPath,'scripts/narrator-prose-benchmark.mjs','scripts/narrator-prose-benchmark-capture.ts',
  'scripts/agent-workspace.mjs','package.json','package-lock.json','tsconfig.json','vitest.config.ts',
  ...cp.execFileSync('rg',['--files','src','tests','content'],{encoding:'utf8'}).trim().split(/\r?\n/)])].sort();
const source=paths.map(file=>({path:file,sha256:sha(file)}));
const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({head,source,cases:spec.cases,quality_ratings_assigned:0,scope:spec.scope},null,2)+'\n',{flag:'wx'});
const config=path.join(directory,'vitest.config.mjs');
fs.writeFileSync(config,`export default ${JSON.stringify({test:{maxWorkers:1,include:files,setupFiles:[path.resolve('scripts/narrator-prose-benchmark-capture.ts')]}})};\n`,{flag:'wx'});
const log=fs.openSync(path.join(directory,'run.log'),'wx');let result;
try{result=cp.spawnSync(process.execPath,['scripts/agent-workspace.mjs','codex','test','--config='+config,
  '--reporter=default','--reporter=json','--outputFile='+path.join(directory,'vitest.json')],
  {stdio:['ignore',log,log],windowsHide:true,env:{...process.env,NARRATOR_BENCHMARK_OUTPUT:directory}});}
finally{fs.closeSync(log);}
const reportPath=path.join(directory,'vitest.json');
const report=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath,'utf8')):null;
const records=fs.readdirSync(directory).filter(file=>/^[TRC]\d+-\d+\.json$/.test(file)).map(file=>({file,...JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'))}));
const reviews=spec.cases.map(c=>({id:c.id,title:c.title,world:c.world,dimensions:c.dimensions,
  records:records.filter(r=>r.case_id===c.id).map(r=>r.file),hard_gates:null,ratings:null,reviewer:null,
  missing_contrasts:spec.open}));
const hashesMatch=source.every(file=>sha(file.path)===file.sha256);
const missing=reviews.filter(c=>!c.records.length).map(c=>c.id);
const status={head,exit:result.status,signal:result.signal,error:result.error?.message,
  passed:report?.numPassedTests,failed:report?.numFailedTests,skipped:report?.numPendingTests,
  cases:18,captured_cases:reviews.length-missing.length,missing,pinned_hashes:source.length,
  hashes_match:hashesMatch,quality_ratings_assigned:0,score_delta:0,
  acceptance:'Capture completeness and fixture regressions only. No quality, real-provider or human acceptance.'};
fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify(status,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(directory,'review.json'),JSON.stringify(reviews,null,2)+'\n',{flag:'wx'});
let md='# Actual offline prose review samples\n\nQuality ratings are blank. Authored fixture NPC decisions establish source/retention only; they do not establish model voice quality. No normal provider calls or human acceptance.\n\n| Case | Structure | Actual primary prose | Records |\n|---|---|---|---|\n';
for(const c of reviews){const record=records.find(r=>r.case_id===c.id&&r.new_receipts.length)||records.find(r=>r.case_id===c.id);md+=`| ${c.id} | ${c.world} | ${(record?.rendered?.narrative??'MISSING').replaceAll('\n',' / ').replaceAll('|','／')} | ${c.records.join(', ')} |\n`;}
fs.writeFileSync(path.join(directory,'review.md'),md,{flag:'wx'});
console.log(JSON.stringify({directory,...status},null,2));
assert.equal(result.status,0,'Underlying fixture tests failed; retain run.log and raw results');
assert(report&&report.numFailedTests===0&&report.numPendingTests===0&&report.numPassedTests===report.numTotalTests,
  'Incomplete fixture report; capture is not verified');
assert.equal(missing.length,0,'Missing actual capture; not a complete benchmark run');
assert(hashesMatch,'Pinned benchmark inputs changed');
