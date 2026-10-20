import {readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const raw=await readFile('docs/four-theme-acceptance-criteria.v1.json','utf8');
const hash=createHash('sha256').update(raw).digest('hex');
assert.equal(hash,(await readFile('docs/four-theme-acceptance-criteria.v1.sha256','utf8')).trim(),'Frozen criteria changed');
const criteria=JSON.parse(raw),progress=JSON.parse(await readFile('docs/four-theme-progress.json','utf8'));
assert.equal(createHash('sha256').update(await readFile('docs/four-theme-verification-protocol.v1.md')).digest('hex'),criteria.verification_protocol_sha256,'Frozen verification protocol changed');
assert.equal(progress.criteria_sha256,hash);
assert.equal(criteria.packages.length,40);
assert.equal(new Set(criteria.packages.map(p=>p.id)).size,40);
assert.equal(criteria.packages.reduce((n,p)=>n+p.weight,0),100);
const ids=criteria.packages.flatMap(p=>p.conditions.map(c=>c.id));
assert.equal(ids.length,160);assert.equal(new Set(ids).size,160);
assert.deepEqual(Object.keys(progress.conditions).sort(),[...ids].sort());
const themes=['R','A','W','N'],names=['① 可靠性','② 自然语言行动','③ 自主持续世界','④ Narrator 与体验'];
const count=packages=>{
 const result={met:0,unmet:0,unverified:0,score:0,complete:0,partial:0,unfinished:0};
 for(const p of packages){
  assert.equal(p.weight,2.5);assert.equal(p.conditions.length,4);
  assert.equal(p.conditions.reduce((n,c)=>n+c.weight,0),p.weight);
  let met=0;
  for(const c of p.conditions){
   assert.equal(c.weight,.625);const state=progress.conditions[c.id];
   assert(['met','unmet','unverified'].includes(state.status));
   assert(state.basis&&state.evidence.length,`Missing assessment for ${c.id}`);
   result[state.status]++;
   if(state.status==='met'){result.score+=c.weight;met++;}
  }
  result[met===4?'complete':met?'partial':'unfinished']++;
 }
 return result;
};
for(const state of Object.values(progress.conditions))for(const file of state.evidence)await access(file);
// Every repair transition must form one continuous chain from the frozen baseline state.
assert.deepEqual(Object.keys(progress.baseline_statuses).sort(),[...ids].sort());
const seen=new Map(Object.entries(progress.baseline_statuses));
const batches=new Set();
for(const batch of progress.changes){
 assert(!batches.has(batch.batch));batches.add(batch.batch);
 assert(batch.type==='accounting_baseline'||batch.type==='repair'||batch.type==='evidence_correction');
 const unique=new Set();
 for(const check of batch.condition_checks??[])assert(ids.includes(check.id)&&check.evidence?.length&&check.result);
 for(const change of batch.transitions){
  assert(ids.includes(change.id)&&!unique.has(change.id));unique.add(change.id);
  assert(['met','unmet','unverified'].includes(change.before)&&['met','unmet','unverified'].includes(change.after));
  if(seen.has(change.id))assert.equal(seen.get(change.id),change.before);
  assert(change.evidence?.length&&change.reason);
  seen.set(change.id,change.after);
 }
}
for(const finding of progress.findings??[]){assert(finding.scope==='original'&&ids.includes(finding.condition)&&finding.evidence?.length);for(const file of finding.evidence)await access(file);}
for(const risk of progress.new_risks){assert(risk.scope==='new'&&risk.evidence?.length);for(const file of risk.evidence)await access(file);}
for(const [id,status]of seen)assert.equal(progress.conditions[id].status,status);
const total=count(criteria.packages);
let md='# 四大主题可复核进度\n\n';
md+=`计分版本 v1；评估源代码：${progress.assessed_source}。整体 **${total.score.toFixed(2)}%**（${total.met}/160 个固定条件满足）。未满足 ${total.unmet}，待验证 ${total.unverified}。\n\n`;
md+='四主题各25%，原40项各2.5%，每项预先固定4个条件、各0.625个百分点。未满足与待验证均不计分；不代表它们没有任何代码。该数值表示已获证据的验收条件权重，不是工时、风险或上线成功概率。\n\n';
md+='| 主题 | 满足 | 未满足 | 待验证 | 完成/部分/未完成项 | 主题进度 |\n|---|---:|---:|---:|---|---:|\n';
themes.forEach((theme,i)=>{const c=count(criteria.packages.filter(p=>p.id.startsWith(theme)));md+=`| ${names[i]} | ${c.met} | ${c.unmet} | ${c.unverified} | ${c.complete}/${c.partial}/${c.unfinished} | ${(c.score*4).toFixed(1)}% |\n`;});
md+=`| 合计 | ${total.met} | ${total.unmet} | ${total.unverified} | ${total.complete}/${total.partial}/${total.unfinished} | ${total.score.toFixed(2)}% |\n\n`;
md+='旧台账的12/21/7是工作包人工分类，保留作历史。这里的完成/部分/未完成由4个条件满足数推导，不能与旧分类混用。旧46%为退役估计；首次建立口径不是产品进展，不计算相对46%的提升。\n\n';
md+='条件冻结于 [criteria v1](four-theme-acceptance-criteria.v1.json)，21个部分完成包的具体场景和关闭标准见 [验收细则](four-theme-verification-protocol.v1.md)；逐条状态、依据及批次变化见 [progress JSON](four-theme-progress.json)。运行 `node scripts/four-theme-progress.mjs` 验证并重建本文。历史局部回归不等于最新全套通过；各 met 的依据注明证据时点。真实 Provider、正式数据、部署及人工验收没有证据时均不计分，也不因此阻塞其他离线开发。\n\n';
md+='规则：不得通过拆条件、改变分母、降低通过条件抬高分数；若发现原范围缺陷，撤回对应 met 并记录负向变化；新增范围风险单列，不能增加原范围得分。确需变更范围时另建版本，保留旧口径和桥接对照，不能覆盖 v1。各包等权是固定、可复算的管理约定，并不声称复杂度相同。\n\n';
const findings=progress.findings??[];
md+=`本口径建立后登记的原范围缺陷：${findings.filter(f=>f.status==='resolved').length} 已修复，${findings.filter(f=>f.status!=='resolved').length} 开放；新增范围风险 ${progress.new_risks.length}。这些记录不增加分母，也不自动获得完整条件分数。\n\n`;
md+='| 批次 | 类型 | 实际条件变化 | 加权变化 |\n|---|---|---|---:|\n';
for(const batch of progress.changes){const delta=batch.transitions.reduce((n,c)=>n+(Number(c.after==='met')-Number(c.before==='met'))*.625,0);const detail=batch.transitions.map(c=>`${c.id}: ${c.before} → ${c.after}`).join('; ')||
 (batch.type==='accounting_baseline'?'0（只建立基线）':(batch.condition_checks??[]).map(c=>`${c.id}: ${c.result}；完整条件保持开放`).join('; ')||'无条件状态变化');
 md+=`| ${batch.batch} | ${batch.type} | ${detail} | ${delta>=0?'+':''}${delta.toFixed(3)} pp |\n`;}
md+='\n';
for(const p of criteria.packages){
 md+=`## ${p.id} ${p.title}\n\n| 条件 | 具体通过条件 | 状态 | 依据 |\n|---|---|---|---|\n`;
 for(const c of p.conditions){const state=progress.conditions[c.id];md+=`| ${c.id} | ${c.pass} | ${{met:'满足',unmet:'未满足',unverified:'待验证'}[state.status]} | ${state.evidence.map(f=>`[${f.split('/').at(-1)}](../${f})`).join(', ')} |\n`;}
 md+='\n';
}
md=md.trimEnd()+'\n';
if(process.argv.includes('--check'))assert.equal(await readFile('docs/four-theme-progress.md','utf8'),md,'Generated progress is stale');
else await writeFile('docs/four-theme-progress.md',md);
console.log(JSON.stringify(total));
