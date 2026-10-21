import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CoreDevelopmentReport } from './coding-agent.js';
import {developmentFailure} from './diagnostics.js';

const exec = promisify(execFile);
export type CoreInstallStage =
  | 'candidate_ready' | 'installing' | 'installed_pending_reload' | 'reloading'
  | 'validating_runtime' | 'registered' | 'resuming' | 'completed'
  | 'install_failed' | 'rollback_in_progress' | 'rolled_back';

export interface CoreInstallRecord {
  stage: CoreInstallStage;
  candidate_id: string;
  task_id: string;
  base_revision: string;
  installed_revision: string | null;
  rollback_revision: string | null;
  patch_path: string;
  patch_sha256: string;
  changed_files: string[];
  installed_by_boot_id: string;
  installed_at: string | null;
  validated_at: string | null;
  error: string | null;
}

type Run = (file: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
const processRun: Run = async (file, args, cwd, signal) => exec(file, args, { cwd, signal, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });

function inside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}
function allowed(path: string) {
  const normalized = path.replaceAll('\\', '/');
  return normalized.length > 0 && !normalized.startsWith('data/') && !normalized.startsWith('.git/')
    && normalized !== '.env' && !normalized.includes('/.env') && !normalized.startsWith('node_modules/')
    && !normalized.startsWith('dist/') && !normalized.startsWith('.tmp/');
}
function statusPaths(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const path = line.slice(3).trim();
    return (path.includes(' -> ') ? path.split(' -> ').at(-1)! : path).replaceAll('\\', '/');
  }).sort();
}
function samePaths(left: string[], right: string[]) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right.map(path => path.replaceAll('\\', '/')))].sort());
}

/** Installs a fully validated core patch as an auditable commit. It never targets a dirty repository. */
export class CoreCandidateInstaller {
  readonly repository: string;
  readonly bootId: string;
  constructor(repository: string, private readonly run: Run = processRun, bootId: string = randomUUID()) {
    this.repository = resolve(repository);
    this.bootId = bootId;
  }

  async install(taskId: string, report: CoreDevelopmentReport, signal?: AbortSignal): Promise<CoreInstallRecord> {
    const record = await this.prepare(taskId, report);
    record.stage = 'installing';
    let operation='install_worktree';
    try {
      const status = await this.run('git', ['status', '--porcelain'], this.repository, signal);
      if (status.stdout.trim()) throw new Error('UNOWNED_DIRTY_WORKTREE: live repository contains changes not owned by this candidate.');
      operation='install_base';const head = (await this.run('git', ['rev-parse', 'HEAD'], this.repository, signal)).stdout.trim();
      if (head !== record.base_revision) throw new Error('CANDIDATE_BASE_MISMATCH: live HEAD no longer matches the validated candidate base.');
      operation='patch_identity';const expectedPatch=await readFile(record.patch_path);
      if(createHash('sha256').update(expectedPatch).digest('hex')!==record.patch_sha256)
        throw new Error('CANDIDATE_PATCH_CHANGED: candidate patch changed after preparation.');
      operation='patch_check';await this.run('git', ['apply', '--check', '--index', record.patch_path], this.repository, signal);
      operation='patch_apply';await this.run('git', ['apply', '--index', record.patch_path], this.repository, signal);
      operation='patch_paths';const applied = statusPaths((await this.run('git', ['status', '--porcelain'], this.repository, signal)).stdout);
      if (!samePaths(applied, record.changed_files)) throw new Error('CANDIDATE_FILE_MISMATCH: applied paths differ from validated candidate metadata.');
      operation='patch_tree';const candidateTree=(await this.run('git',['write-tree'],this.repository,signal)).stdout.trim();
      const treePatch=(await this.run('git',['diff','--binary',record.base_revision,candidateTree],this.repository,signal)).stdout;
      if(treePatch.trimEnd()!==expectedPatch.toString('utf8').trimEnd())
        throw new Error('CANDIDATE_TREE_MISMATCH: staged candidate tree differs from the validated patch; all current edits are preserved.');
      operation='install_build';await this.build(signal);
      operation='install_ownership';
      const currentHead=(await this.run('git',['rev-parse','HEAD'],this.repository,signal)).stdout.trim();
      const currentTree=(await this.run('git',['write-tree'],this.repository,signal)).stdout.trim();
      const unstaged=(await this.run('git',['diff','--name-only'],this.repository,signal)).stdout.trim();
      const currentPaths=statusPaths((await this.run('git',['status','--porcelain'],this.repository,signal)).stdout);
      if(currentHead!==record.base_revision||currentTree!==candidateTree||unstaged||!samePaths(currentPaths,record.changed_files))
        throw new Error('CANDIDATE_OWNERSHIP_CHANGED: repository changed during candidate validation; all current edits are preserved.');
      operation='install_commit';
      // Commit the validated tree, never a later writer's mutable index. The
      // compare-and-swap updates HEAD only if the original base is still live;
      // neither command checks out files or rewrites the index.
      const revision=(await this.run('git', ['-c', 'user.name=Agent Game Framework', '-c', 'user.email=framework@local.invalid',
        'commit-tree',candidateTree,'-p',record.base_revision,'-m',`core: install managed candidate ${record.candidate_id}`], this.repository, signal)).stdout.trim();
      operation='install_head';await this.run('git',['update-ref','-m',`install managed candidate ${record.candidate_id}`,'HEAD',revision,record.base_revision],this.repository,signal);
      record.installed_revision=revision;
      record.installed_at = new Date().toISOString();
      record.stage = 'installed_pending_reload';
      return record;
    } catch (error) {
      record.error = developmentFailure(operation,error);
      record.stage = 'install_failed';
      // A failed admission did not acquire ownership of existing work. Even
      // after apply, a build or another writer may have changed tracked bytes
      // or the index. Preserve that state for inspection instead of resetting
      // the repository or reverse-applying a patch over unowned changes.
      throw Object.assign(new Error(record.error), { install_record: record });
    }
  }

  async validateReload(record: CoreInstallRecord, signal?: AbortSignal) {
    if (record.stage !== 'installed_pending_reload' && record.stage !== 'reloading' && record.stage !== 'validating_runtime') throw new Error('Core candidate is not awaiting runtime validation.');
    if (record.installed_by_boot_id === this.bootId) return { ready: false, reason: 'Runtime restart is still required.' };
    record.stage = 'validating_runtime';
    let operation='runtime_head';
    try{
    const head = (await this.run('git', ['rev-parse', 'HEAD'], this.repository, signal)).stdout.trim();
    if (head !== record.installed_revision) return { ready: false, reason: 'Installed revision is not the runtime repository HEAD.' };
    operation='runtime_worktree';const status = await this.run('git', ['status', '--porcelain'], this.repository, signal);
    if (status.stdout.trim()) return { ready: false, reason: 'Runtime repository is dirty after managed candidate installation.' };
    operation='runtime_build';await this.build(signal);
    record.validated_at = new Date().toISOString();
    record.stage = 'registered';
    record.error = null;
    return { ready: true, reason: null };
    }catch(error){record.error=developmentFailure(operation,error);throw new Error(record.error,{cause:error});}
  }

  async rollback(record: CoreInstallRecord, signal?: AbortSignal) {
    record.stage = 'rollback_in_progress';
    const status = await this.run('git', ['status', '--porcelain'], this.repository, signal);
    if (status.stdout.trim()) throw new Error('ROLLBACK_REFUSED: repository contains unowned changes.');
    const head = (await this.run('git', ['rev-parse', 'HEAD'], this.repository, signal)).stdout.trim();
    if (!record.installed_revision || head !== record.installed_revision) throw new Error('ROLLBACK_REFUSED: installed candidate is not the current HEAD.');
    await this.run('git', ['-c', 'user.name=Agent Game Framework', '-c', 'user.email=framework@local.invalid', 'revert', '--no-edit', record.installed_revision], this.repository, signal);
    await this.build(signal);
    record.rollback_revision = (await this.run('git', ['rev-parse', 'HEAD'], this.repository, signal)).stdout.trim();
    record.stage = 'rolled_back';
    return record;
  }

  private async prepare(taskId: string, report: CoreDevelopmentReport): Promise<CoreInstallRecord> {
    if (report.status !== 'candidate_ready' || !report.tests_passed || !report.build_passed || !report.acceptance_passed) throw new Error('Core candidate has not passed every required gate.');
    if (!report.base_revision || !report.patch_path || !report.changed_files.length) throw new Error('Core candidate metadata is incomplete.');
    if (report.changed_files.some(path => !allowed(path))) throw new Error('Core candidate contains a forbidden path.');
    const workspace = resolve(report.workspace), patchPath = resolve(report.patch_path);
    if (!inside(workspace, patchPath)) throw new Error('Core candidate patch is outside its managed workspace.');
    const patch = await readFile(patchPath);
    const patchSha = createHash('sha256').update(patch).digest('hex');
    return {
      stage: 'candidate_ready', candidate_id: patchSha.slice(0, 16), task_id: taskId,
      base_revision: report.base_revision, installed_revision: null, rollback_revision: null,
      patch_path: patchPath, patch_sha256: patchSha, changed_files: [...new Set(report.changed_files.map(path => path.replaceAll('\\', '/')))].sort(),
      installed_by_boot_id: this.bootId, installed_at: null, validated_at: null, error: null,
    };
  }

  private async build(signal?: AbortSignal) {
    if (process.platform === 'win32') await this.run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], this.repository, signal);
    else await this.run('npm', ['run', 'build'], this.repository, signal);
  }
}
