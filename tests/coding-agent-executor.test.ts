import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CodexCodingAgentExecutor } from '../src/development/coding-agent.js';

const exec = promisify(execFile);

describe('Core Development Executor clean repository lifecycle', () => {
  it('creates a real isolated patch and runs targeted test plus build without installing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agf-core-executor-'));
    const repository = join(root, 'source'), workspace = join(root, 'workspace');
    await mkdir(join(repository, 'src'), { recursive: true });
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(join(repository, 'node_modules'), { recursive: true });
    await writeFile(join(repository, 'package.json'), JSON.stringify({
      name: 'clean-core-fixture', private: true, type: 'module',
      scripts: { test: 'node scripts/test.mjs', build: 'node scripts/build.mjs' },
    }));
    await writeFile(join(repository, 'src', 'base.ts'), 'export const base = true;\n');
    await writeFile(join(repository, 'scripts', 'test.mjs'), "import {readFile} from 'node:fs/promises'; const text=await readFile('src/capability.ts','utf8'); if(!text.includes('fixtureCapability')) process.exit(1);\n");
    await writeFile(join(repository, 'scripts', 'build.mjs'), "import {access} from 'node:fs/promises'; await access('src/capability.ts');\n");
    await exec('git', ['init', '--quiet'], { cwd: repository });
    await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
    await exec('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
    await exec('git', ['add', '--all'], { cwd: repository });
    await exec('git', ['commit', '--quiet', '-m', 'fixture base'], { cwd: repository });

    let candidate = '';
    const codingBackend = {
      startThread(options: { workingDirectory: string }) {
        candidate = options.workingDirectory;
        return { run: async () => {
          await writeFile(join(candidate, 'src', 'capability.ts'), 'export const fixtureCapability = true;\n');
          return { items: [] };
        } };
      },
    };
    const runner = async (file: string, args: string[], cwd: string, signal?: AbortSignal) => {
      if (file === 'where.exe') return { stdout: 'fixture-codex.exe\r\n', stderr: '' };
      if (/npm\.cmd$/i.test(file)) {
        const npmCli = process.env.npm_execpath;
        if (!npmCli) throw new Error('npm_execpath is unavailable');
        return exec(process.execPath, [npmCli, ...args], { cwd, signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
      }
      return exec(file, args, { cwd, signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
    };

    try {
      const executor = new CodexCodingAgentExecutor(codingBackend as any, runner);
      const report = await executor.execute({
        task_id: 'clean-fixture', repository, workspace,
        requirement: 'Add one reusable local capability.',
        proposal: { problem: 'missing fixture capability', proposed_api: ['fixtureCapability'], impact: ['core'], migration: 'none', tests: ['npm test'], rollback: 'discard candidate', risk: 'low' },
        targeted_tests: ['npm test'], required_acceptance: [],
      });
      expect(report).toMatchObject({
        status: 'candidate_ready', tests_passed: true, build_passed: true, acceptance_passed: true,
        installed: false, registered: false, restart_required: true,
      });
      expect(report.changed_files).toEqual(['src/capability.ts']);
      expect(report.patch_path).toBeTruthy();
      expect(await readFile(report.patch_path!, 'utf8')).toContain('fixtureCapability');
      expect(candidate.startsWith(workspace)).toBe(true);
      await expect(readFile(join(repository, 'src', 'capability.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});