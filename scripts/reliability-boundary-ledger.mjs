import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve('.codex-checkpoints/framework-reliability-handoff/continuation-2026-10-20');
const inventory=JSON.parse(await readFile(resolve(directory,'path-inventory.json'),'utf8'));
const evidence={
 'src/server/service.ts':{
  turn:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts','tests/p0a-background-journal.test.ts'],limit:'Other nested side effects still require their own audit.'},
  agentTransaction:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts'],limit:'An arbitrary mutate callback is not proved safe by the commit boundary alone.'},
  narrativeCommand:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts'],limit:'Narrative quality and all command variants are separate acceptance.'},
  performDeclaredActivity:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts'],limit:'All activity/NPC/time semantics are not proved by the commit boundary.'},
  manageModule:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts','tests/modules-capability.test.ts'],limit:'Removal writes checkpoint and current separately; inter-file failure injection remains.'},
  extensionTransaction:{status:'prepared_transaction_fault_tested',evidence:['tests/p0a-input-terminal-recovery.test.ts','tests/extensions.test.ts'],limit:'Host approval, external workspaces, installation callbacks and all extension actions have separate effects.'},
  setAvatar:{status:'asset_retention_fault_tested',evidence:['tests/p0a-media-commit-recovery.test.ts'],limit:'Media binding has no durable request identity yet; retention is not automatic provider replay or garbage collection.'},
  setVisualAsset:{status:'asset_retention_fault_tested',evidence:['tests/p0a-media-commit-recovery.test.ts'],limit:'Media binding has no durable request identity yet; retention is not automatic provider replay or garbage collection.'},
 },
 'src/extensions/development.ts':{
  persist:{status:'atomic_journal_fault_tested',evidence:['tests/p0a-extension-lifecycle.test.ts'],limit:'No process-kill or persistent disk failure acceptance.'},
  startJob:{status:'detached_creation_identity_tested',evidence:['tests/p0a-extension-lifecycle.test.ts'],limit:'All cancel races and legacy job journal structure/path validation remain.'},
  build:{status:'candidate_phase_failure_tested',evidence:['tests/p0a-extension-lifecycle.test.ts','tests/extensions.test.ts'],limit:'External candidate file writes remain separate; no real paid provider used.'},
 },
 'src/extensions/tasks.ts':{
  persist:{status:'atomic_journal_fault_tested',evidence:['tests/p0a-development-task-lifecycle.test.ts'],limit:'No power-failure or persistent disk failure acceptance.'},
  runCapability:{status:'registration_effect_fault_tested',evidence:['tests/p0a-capability-registration-recovery.test.ts'],limit:'Only runtime registerMany boundary; commands substituted. Persistent registration intent/restart recovery remains.'},
 },
 'src/extensions/host.ts':{
  approve:{status:'durable_approval_fault_tested',evidence:['tests/p0a-extension-lifecycle.test.ts'],limit:'No cross-process serialization lock.'},
 },
 'src/routine/jobs.ts':{
  persist:{status:'atomic_journal_fault_tested',evidence:['tests/p0a-background-journal.test.ts'],limit:'No power-failure guarantee.'},
  start:{status:'detached_lifecycle_fault_tested',evidence:['tests/p0a-background-journal.test.ts'],limit:'Multi-process leases remain unverified.'},
  run:{status:'detached_lifecycle_fault_tested',evidence:['tests/p0a-background-journal.test.ts'],limit:'Long job receipt eviction and every NPC nested exit remain unverified.'},
 },
};
const files=new Set([...Object.keys(evidence),'src/extensions/tasks.ts']);
const sourceLines=new Map(await Promise.all([...files].map(async file=>[file,(await readFile(resolve(file),'utf8')).split(/\r?\n/)])));
const boundaries=inventory.edges.filter(hook=>files.has(hook.file)&&
 /(?:storage\.(?:write(?:Pending|GlobalGuidance)?|clearPending)$|writeAtomicJson$|^(?:writeFile|rename|copyFile|mkdir)$|\.(?:build|runCore|runCapability|registerMany)$)/.test(hook.callee))
 .map(hook=>{
  const method=inventory.functions.filter(fn=>fn.file===hook.file&&fn.line<=hook.line&&fn.end_line>=hook.line&&
    !fn.name.includes(':callback')).sort((a,b)=>(a.end_line-a.line)-(b.end_line-b.line))[0];
  let review=method&&evidence[hook.file]?.[method.name];
  if(review?.status==='prepared_transaction_fault_tested'&&hook.callee!=='this.storage.write')review=undefined;
  if(review?.status==='registration_effect_fault_tested'&&!hook.callee.endsWith('.registerMany'))review=undefined;
  if(hook.file==='src/server/service.ts'&&method?.name==='manageModule'&&
    /storage\.write\(checkpoint\s*,\s*['"]checkpoint['"]/.test(sourceLines.get(hook.file)?.[hook.line-1]??''))review=undefined;
  if(review?.status==='candidate_phase_failure_tested')review={...review,status:'unreviewed',
    limit:'The containing candidate phase is tested, but failure at this exact workspace file boundary has not been injected.'};
  return {...hook,method:method?.name??null,method_start:method?.line??null,
    review:review??{status:'unreviewed',evidence:[],limit:'Needs branch, side-effect and failure-exit tracing. Existing tests are not a unified recovery proof.'}};
 });
const statuses={};for(const boundary of boundaries)statuses[boundary.review.status]=(statuses[boundary.review.status]??0)+1;
const output={generated_at:new Date().toISOString(),inventory_source_sha256:inventory.source_sha256,
 limitations:['Selected critical service and detached-task boundaries only; not all Framework paths.',
  'A reviewed containing method does not certify every nested branch or callback.',
  'Prepared transaction hooks protect only when an enclosing durable recovery scope exists.',
  'Counts are inventory counts, not product completion or acceptance percentages.'],
 totals:{selected_boundaries:boundaries.length,statuses},boundaries};
await writeFile(resolve(directory,'boundary-ledger.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify(output.totals));
