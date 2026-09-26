import { Codex, type ThreadItem } from '@openai/codex-sdk';
import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface CoreDevelopmentRequest {
  task_id: string;
  repository: string;
  workspace: string;
  requirement: string;
  proposal: { problem: string; proposed_api: string[]; impact: string[]; migration: string; tests: string[]; rollback: string; risk: string };
  targeted_tests: string[];
  required_acceptance: string[];
}

export interface CoreDevelopmentReport {
  status: 'candidate_ready' | 'blocked' | 'failed';
  provider: string;
  workspace: string;
  base_revision: string | null;
  changed_files: string[];
  commands: { command: string; exit_code: number | null }[];
  patch_path: string | null;
  tests_passed: boolean;
  build_passed: boolean;
  acceptance_passed: boolean;
  installed: boolean;
  registered: boolean;
  restart_required: boolean;
  message: string;
}

/** Coding belongs to the development layer. Game/runtime code depends only on this contract. */
export interface CodingAgentExecutor {
  availability(): Promise<{ available: boolean; provider: string; reason: string | null }>;
  execute(request: CoreDevelopmentRequest, signal?: AbortSignal): Promise<CoreDevelopmentReport>;
}

type Run = (file: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
const processRun: Run = async (file, args, cwd, signal) => exec(file, args, { cwd, signal, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });

function inside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

function allowedChangedFile(path: string) {
  const normalized = path.replaceAll('\\', '/');
  return !normalized.startsWith('data/') && !normalized.startsWith('.git/') && !normalized.includes('/.env') && normalized !== '.env'
    && !normalized.startsWith('node_modules/') && !normalized.startsWith('dist/');
}

/**
 * Real Codex backend for core candidates. It edits an isolated git clone, never the live repository.
 * The candidate remains uninstalled until a separate installer can apply it and register its capability.
 */
export class CodexCodingAgentExecutor implements CodingAgentExecutor {
  constructor(private readonly codex = new Codex({
    config: { forced_login_method: 'chatgpt', features: { multi_agent: false, apps: false, remote_plugin: false }, tools: { view_image: false } },
    configOverrides: ['mcp_servers={}', 'hooks={}'],
  }), private readonly run: Run = processRun) {}

  async availability() {
    try { await this.run(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], process.cwd()); return { available: true, provider: 'codex', reason: null }; }
    catch { return { available: false, provider: 'codex', reason: 'Codex CLI is not available on PATH.' }; }
  }

  async execute(request: CoreDevelopmentRequest, signal?: AbortSignal): Promise<CoreDevelopmentReport> {
    const repository = resolve(request.repository), workspace = resolve(request.workspace), candidate = join(workspace, 'repository');
    if (inside(repository, workspace) && relative(repository, workspace).split(sep)[0] === 'data') throw new Error('核心开发工作区不能位于真实 data 目录');
    await mkdir(workspace, { recursive: true });
    const available = await this.availability();
    if (!available.available) return this.report(request, null, [], [], null, false, false, false, available.reason!);
    const status = await this.run('git', ['status', '--porcelain'], repository, signal);
    if (status.stdout.trim()) return this.report(request, null, [], [], null, false, false, false, 'Live repository has uncommitted changes; refusing to build a core patch against a moving checkout.');
    const base = (await this.run('git', ['rev-parse', 'HEAD'], repository, signal)).stdout.trim();
    await this.run('git', ['clone', '--no-local', '--no-hardlinks', '--quiet', repository, candidate], workspace, signal);
    const prompt = [
      'You are the bounded core development worker for Agent Game Framework.',
      'Work only in this isolated repository. Never read or write data/, .env files, credentials, user saves, or paths outside the repository.',
      'Network access is disabled. Do not change tests to weaken behavior, skip tests, or hardcode the example request.',
      'Implement the smallest reusable change described by the approved proposal. Add focused tests. Do not install or publish anything.',
      `Requirement: ${request.requirement}`,
      `Approved proposal: ${JSON.stringify(request.proposal)}`,
      `Targeted validation run later by the framework: ${JSON.stringify(request.targeted_tests)}`,
      'Finish with a concise report. The framework will independently inspect the diff and run every gate.',
    ].join('\n');
    const thread = this.codex.startThread({ workingDirectory: candidate, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', skipGitRepoCheck: false });
    let turn;
    try { turn = await thread.run(prompt, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000) }); }
    catch (error) { return this.report(request, base, [], [], null, false, false, false, `Coding backend failed: ${(error as Error).message}`); }
    const commands = turn.items.filter((item): item is Extract<ThreadItem, { type: 'command_execution' }> => item.type === 'command_execution').map(item => ({ command: item.command, exit_code: item.exit_code ?? null }));
    const changed = (await this.run('git', ['diff', '--name-only', 'HEAD'], candidate, signal)).stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const untracked = (await this.run('git', ['ls-files', '--others', '--exclude-standard'], candidate, signal)).stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const changedFiles = [...new Set([...changed, ...untracked])];
    if (!changedFiles.length) return this.report(request, base, [], commands, null, false, false, false, 'Coding backend produced no implementation.');
    if (changedFiles.some(path => !allowedChangedFile(path))) return this.report(request, base, changedFiles, commands, null, false, false, false, 'Candidate touched a forbidden path.');
    await this.run('git', ['add', '--all'], candidate, signal);
    const diffCheck = await this.run('git', ['diff', '--cached', '--check'], candidate, signal).catch(error => ({ stdout: '', stderr: String(error) }));
    if (diffCheck.stderr.trim()) return this.report(request, base, changedFiles, commands, null, false, false, false, 'Candidate failed git diff --check.');
    const patch = (await this.run('git', ['diff', '--cached', '--binary', 'HEAD'], candidate, signal)).stdout;
    const patchPath = join(workspace, 'candidate.patch'); await writeFile(patchPath, patch, 'utf8');
    // Add dependencies only after the coding turn, so the agent cannot mutate the live installation through the junction.
    await symlink(join(repository, 'node_modules'), join(candidate, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const packageJson = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    let testsPassed = true;
    for (const command of request.targeted_tests) {
      const parts = command.trim().split(/\s+/); if (parts[0] !== 'npm' && parts[0] !== 'npx') throw new Error('Only npm/npx targeted tests are allowed');
      try { await this.run(process.platform === 'win32' ? `${parts[0]}.cmd` : parts[0], parts.slice(1), candidate, signal); }
      catch { testsPassed = false; break; }
    }
    let buildPassed = false;
    if (testsPassed && packageJson.scripts?.build) {
      try { await this.run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], candidate, signal); buildPassed = true; } catch { buildPassed = false; }
    }
    const acceptancePassed = buildPassed && request.required_acceptance.length === 0;
    return {
      status: testsPassed && buildPassed && acceptancePassed ? 'candidate_ready' : 'failed', provider: 'codex', workspace, base_revision: base,
      changed_files: changedFiles, commands, patch_path: patchPath, tests_passed: testsPassed, build_passed: buildPassed,
      acceptance_passed: acceptancePassed, installed: false, registered: false, restart_required: true,
      message: acceptancePassed ? 'Core candidate passed isolated tests and build; it is not installed or registered.' : 'Core candidate did not pass every required gate.',
    };
  }

  private report(request: CoreDevelopmentRequest, base: string | null, changed: string[], commands: { command: string; exit_code: number | null }[], patch: string | null, tests: boolean, build: boolean, acceptance: boolean, message: string): CoreDevelopmentReport {
    return { status: message.includes('not available') ? 'blocked' : 'failed', provider: 'codex', workspace: request.workspace, base_revision: base, changed_files: changed, commands, patch_path: patch, tests_passed: tests, build_passed: build, acceptance_passed: acceptance, installed: false, registered: false, restart_required: false, message };
  }
}
